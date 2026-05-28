/*
 * nano_imu_ble_sender.ino
 * --------------------------------------------------------------------------
 * Arduino Nano 33 BLE original generation + LSM9DS1 IMU + BME680 (pressure)
 *
 * Role:
 *   Nano 33 BLE = BLE Peripheral / Sensor Node
 *
 * It reads accelerometer + gyroscope (LSM9DS1) and barometric pressure (BME680)
 * and sends a raw CSV payload over BLE.
 *
 * Payload:
 *   IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,pressure_pa
 *
 * Wiring:
 * - BME680 over I2C on the hardware `Wire` bus: A4 = SDA, A5 = SCL. (The onboard LSM9DS1
 *   lives on the internal `Wire1`, so the public `Wire` is free.)
 *
 * Notes:
 * - Raw 6-axis IMU + pressure only: no norms, no phase classification, no velocity/distance,
 *   no Kalman. Any feature extraction / classification is done downstream on the UNO Q.
 * - The IMU runs at ~20 Hz; the BME680 is read ~1 Hz (non-blocking) and its last value is
 *   repeated on every payload line. Pressure changes slowly, so this keeps the IMU cadence clean.
 * - UNO Q receives BLE payload and stores/displays data.
 * - Connect-first: the Nano reads the IMU and emits a payload (BLE notify +
 *   Serial echo together) only while ≥1 BLE central is connected. Before that
 *   it just advertises and prints a periodic "waiting" heartbeat.
 * - Multi-central: accepts up to MAX_CENTRALS simultaneous centrals (Mbed/Cordio
 *   DM_CONN_MAX default = 3). BLENotify auto-broadcasts to every subscribed
 *   central, so all of them get the same CSV stream in parallel.
 * --------------------------------------------------------------------------
 */

#include <Arduino_LSM9DS1.h>
#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME680.h>

// BLE contract — inlined so this sketch is a single self-contained file.
// Canonical values live in protocol/ble_contract.json (which still drives the Python consumers
// via protocol/gen_contract.py); keep the constants below in sync with that file by hand.
static const char*  DEVICE_NAME      = "NanoIMU";
static const char*  SERVICE_UUID     = "19B10000-E8F2-537E-4F6C-D104768A1214";
static const char*  CHAR_UUID        = "19B10001-E8F2-537E-4F6C-D104768A1214";
const float         GRAVITY          = 9.80665f;
const unsigned long SEND_INTERVAL_MS = 50;

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// Init recovery: instead of hanging forever on a failed IMU/BLE init, retry a few times then
// reboot (NVIC_SystemReset) so a transient power-up fault can self-recover unattended.
const unsigned long INIT_RETRY_MS    = 1000;
const unsigned int  INIT_MAX_ATTEMPTS = 10;

// Pressure-alarm indicator on D2. Three modes evaluated each loop from `lastPressurePa`:
//   p <= PRESSURE_ALARM_PA            → LED off + reset hold timer
//   p >  PRESSURE_ALARM_PA, held <10s → LED solid on
//   p >  PRESSURE_ALARM_PA, held ≥10s → LED blinks ~1 s/cycle (500 ms on / 500 ms off)
// No hysteresis: ambient ~101300 Pa is ~4 kPa below the threshold so flicker isn't a risk.
const float         PRESSURE_ALARM_PA       = 105000.0f;
const unsigned long PRESSURE_ALARM_DELAY_MS = 10000;
const unsigned long PRESSURE_ALARM_BLINK_MS = 500;
const uint8_t       LED_PRESSURE_PIN        = 2;

// --------------------------------------------------------------------------
// BLE objects
// --------------------------------------------------------------------------

BLEService imuService(SERVICE_UUID);

// Use 160 bytes to avoid payload truncation.
// CSV payload is easier for MVP, but binary packet is better later.
BLEStringCharacteristic imuChar(
  CHAR_UUID,
  BLERead | BLENotify,
  160
);

// --------------------------------------------------------------------------
// BME680 (pressure) — on the hardware `Wire` bus (A4 = SDA, A5 = SCL).
// (The Nano 33 BLE's onboard LSM9DS1 lives on the internal `Wire1`, so this `Wire` is free.)
// --------------------------------------------------------------------------

Adafruit_BME680 bme;   // default constructor uses &Wire

const unsigned long BME_READ_INTERVAL_MS = 1000;   // pressure changes slowly: read ~1 Hz

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

unsigned long lastSendMs = 0;

// 0 = lastPressurePa is currently ≤ threshold (also the boot state); else = millis() of the
// first sample that crossed above. Used by updatePressureLed() to drive solid-vs-blink.
unsigned long pressureHighSinceMs = 0;

// BLE multi-central state. Mbed/Cordio's ArduinoBLE stack supports up to DM_CONN_MAX
// simultaneous centrals (default 3); BLENotify auto-broadcasts to every subscribed
// central, so we only need to count peers + drive advertising. `volatile` is defensive:
// ArduinoBLE dispatches event handlers from BLE.poll() (cooperative, not ISR), but the
// keyword is cheap and documents the cross-context access.
//
// IMPORTANT — Cordio link-layer quirk: calling BLE.advertise() **from inside** a
// BLEConnected/BLEDisconnected callback leaves advertising packets going out (so scanners
// still see NanoIMU), but the link-layer state machine is locked in "connected" context
// and silently drops incoming connect_req — i.e. a second central can SEE us but never
// ACKs through. The deferred-flag pattern below moves the advertise() call to loop()
// main context, which is safe. See: Mbed forum "BLE: Cordio Peripheral - Multiple
// Central Connections?" + ArduinoBLE issue #108.
static const int MAX_CENTRALS  = 3;     // mirrors ATT_MAX_PEERS / DM_CONN_MAX
volatile int     connectedCount = 0;    // updated from BLE event handlers
volatile bool    advertisingRequested = false;   // set in handlers, consumed in loop()
unsigned long    lastAdvertiseRearmMs = 0;       // periodic-rearm timer (idempotent kick)

// Settle window after a new BLEConnected fires: pause notify TX so the fresh central's
// GATT discovery + characteristic subscribe (ATT_READ_BY_GROUP_TYPE / ATT_READ_BY_TYPE /
// ATT_WRITE) can complete without competing for radio TX slots against the existing
// connection's notify cadence. Without this, conn 1's notify storm starves conn 2's ATT
// responses and the new central ATT-times-out while Nano still thinks it's connected.
volatile unsigned long     pauseUntilMs = 0;                  // 0 = streaming; >0 = paused
static const unsigned long SETTLE_AFTER_CONNECT_MS = 2000;    // GATT discovery budget

// Whitelist foundation — track each connected central's MAC address per slot so a
// future whitelist gate in onBLEConnected can decide whether to accept. "" = empty slot.
// (BLE MAC string format = "AA:BB:CC:DD:EE:FF" = 17 chars + NUL.) Global zero-init.
char connectedAddresses[MAX_CENTRALS][18];

// Serial-mirror throttle while connected: 80-byte payload at 115200 baud blocks ~7 ms
// per println — eats ~14% of every 50 ms window. With centrals subscribed we mirror
// only every Nth sample so BLE.poll() gets more radio-time slots. When 0 centrals are
// connected we don't enter maybePublish() at all, so the bring-up heartbeat is intact.
static const unsigned int SERIAL_ECHO_EVERY = 10;   // 50 ms × 10 = ~2 Hz Serial debug

// BME680 state. pressure is optional: if the sensor is absent we keep sending IMU with
// pressure = 0 so the downstream CSV contract stays well-formed.
bool          bmeOk          = false;   // sensor found at setup
float         lastPressurePa = 0.0f;    // last good reading, repeated on every payload line
bool          bmeReading     = false;   // an async beginReading() is in flight
unsigned long bmeReadyAt     = 0;       // millis() when the in-flight reading is ready
unsigned long lastBmeStartMs = 0;       // when we last kicked off a reading

// --------------------------------------------------------------------------
// Small vector helper
// --------------------------------------------------------------------------

struct Vec3 {
  float x;
  float y;
  float z;
};

Vec3 vscale(Vec3 v, float s) {
  Vec3 out;
  out.x = v.x * s;
  out.y = v.y * s;
  out.z = v.z * s;
  return out;
}

// --------------------------------------------------------------------------
// IMU read
// --------------------------------------------------------------------------

bool readImu(Vec3& acc, Vec3& gyro) {
  if (!IMU.accelerationAvailable() || !IMU.gyroscopeAvailable()) {
    return false;
  }

  // Accelerometer unit from Arduino_LSM9DS1 = g
  IMU.readAcceleration(acc.x, acc.y, acc.z);

  // Gyroscope unit = deg/s
  IMU.readGyroscope(gyro.x, gyro.y, gyro.z);

  return true;
}

// --------------------------------------------------------------------------
// BME680 pressure read (non-blocking, ~1 Hz)
// --------------------------------------------------------------------------

// Drive the BME680 with Adafruit's async API so we never block the 20 Hz IMU loop:
// every BME_READ_INTERVAL_MS kick off a reading (beginReading), then collect it
// (endReading) once its scheduled ready-time has passed. Caches into lastPressurePa.
// All diagnostic logs in here are rate-limited (~ every 5 s) so they don't drown the Serial.
void updatePressure() {
  static unsigned long lastWarnMs       = 0;     // throttle for begin/end-failed logs
  static unsigned long lastHeartbeatMs  = 0;     // throttle for the "[bme] p=… ok" heartbeat
  const  unsigned long WARN_THROTTLE_MS = 5000;

  if (!bmeOk) {
    return;   // sensor absent — keep lastPressurePa at 0
  }

  unsigned long now = millis();

  if (!bmeReading) {
    if (now - lastBmeStartMs < BME_READ_INTERVAL_MS) {
      return;
    }
    unsigned long readyAt = bme.beginReading();   // 0 = failed to start
    if (readyAt == 0) {
      if (now - lastWarnMs >= WARN_THROTTLE_MS) {
        Serial.println("[bme] beginReading failed");
        lastWarnMs = now;
      }
      lastBmeStartMs = now;   // back off a full interval before trying again
      return;
    }
    bmeReading = true;
    bmeReadyAt = readyAt;
    lastBmeStartMs = now;
    return;
  }

  // A reading is in flight — collect it once it's due.
  if (now >= bmeReadyAt) {
    if (bme.endReading()) {
      lastPressurePa = bme.pressure;   // Adafruit_BME680.pressure is in Pa
      if (now - lastHeartbeatMs >= WARN_THROTTLE_MS) {
        Serial.print("[bme] p="); Serial.print(lastPressurePa, 1); Serial.println(" Pa");
        lastHeartbeatMs = now;
      }
    } else if (now - lastWarnMs >= WARN_THROTTLE_MS) {
      Serial.println("[bme] endReading failed");
      lastWarnMs = now;
    }
    bmeReading = false;
  }
}

// --------------------------------------------------------------------------
// Pressure-alarm LED on D2 — non-blocking, evaluated each loop
// --------------------------------------------------------------------------

// Reads lastPressurePa (refreshed ~1 Hz by updatePressure()) and drives D2 directly. The
// blink phase is derived from a single `heldFor` calculation so the transition solid → blink
// at the 10 s mark starts on the "on" half — no visible dropout.
void updatePressureLed() {
  unsigned long now = millis();
  if (lastPressurePa > PRESSURE_ALARM_PA) {
    if (pressureHighSinceMs == 0) {
      pressureHighSinceMs = now;
    }
    unsigned long heldFor = now - pressureHighSinceMs;
    if (heldFor < PRESSURE_ALARM_DELAY_MS) {
      digitalWrite(LED_PRESSURE_PIN, HIGH);
    } else {
      bool on = ((heldFor - PRESSURE_ALARM_DELAY_MS) / PRESSURE_ALARM_BLINK_MS) % 2 == 0;
      digitalWrite(LED_PRESSURE_PIN, on ? HIGH : LOW);
    }
  } else {
    pressureHighSinceMs = 0;
    digitalWrite(LED_PRESSURE_PIN, LOW);
  }
}

// --------------------------------------------------------------------------
// Connected-central registry helpers (whitelist foundation)
// --------------------------------------------------------------------------

// Linear scans over MAX_CENTRALS = 3 — O(N) is fine; keeps the data structure flat.
int findSlotByAddress(const char* addr) {
  for (int i = 0; i < MAX_CENTRALS; i++) {
    if (strncmp(connectedAddresses[i], addr, 18) == 0) return i;
  }
  return -1;
}

int findFreeSlot() {
  for (int i = 0; i < MAX_CENTRALS; i++) {
    if (connectedAddresses[i][0] == 0) return i;
  }
  return -1;
}

// --------------------------------------------------------------------------
// BLE event handlers (driven by BLE.poll() in loop())
// --------------------------------------------------------------------------
//
// Multi-central model: ArduinoBLE on Mbed/Cordio accepts up to MAX_CENTRALS
// simultaneous centrals (default DM_CONN_MAX = 3). BLENotify on imuChar
// auto-broadcasts to every subscribed central, so the publish path is
// unchanged — these handlers just count peers and keep advertising alive so
// the next central can still discover us while existing ones stream.

// New central just paired. Bump the counter, log the transition, and request a
// deferred re-arm of advertising (loop() will call BLE.advertise() in main context —
// see Cordio quirk note in the state block). At the cap we leave advertising paused:
// a 4th scanner will not see NanoIMU until someone disconnects.
void onBLEConnected(BLEDevice central) {
  connectedCount++;

  // Record the address into a free slot — feeds the periodic active-list log and
  // gives the future whitelist gate something concrete to check against.
  String addr = central.address();
  int slot = findFreeSlot();
  if (slot >= 0) {
    strncpy(connectedAddresses[slot], addr.c_str(), 17);
    connectedAddresses[slot][17] = 0;
  }

  // TODO(whitelist): once a whitelist is defined, gate by address here, e.g.
  //   static const char* ALLOWED[] = { "AA:BB:CC:DD:EE:FF", ... };
  //   if (!inArray(ALLOWED, addr.c_str())) { central.disconnect(); return; }
  // For now any address is accepted — see `connectedAddresses[]` for the live list.

  Serial.print("central connected: ");
  Serial.print(addr);
  Serial.print(" (");
  Serial.print(connectedCount);
  Serial.print("/");
  Serial.print(MAX_CENTRALS);
  Serial.println(")");

  // Pause notify TX so the new central's GATT discovery + subscribe can land without
  // competing for radio TX slots against the existing connections' notify cadence.
  pauseUntilMs = millis() + SETTLE_AFTER_CONNECT_MS;
  Serial.print("[ble] notify TX paused for ");
  Serial.print(SETTLE_AFTER_CONNECT_MS);
  Serial.println(" ms — letting new central finish GATT discovery");

  if (connectedCount < MAX_CENTRALS) {
    advertisingRequested = true;     // deferred; loop() does the real BLE.advertise()
  } else {
    Serial.println("at MAX_CENTRALS — advertising paused");
  }
}

// Central dropped (clean disconnect or supervision timeout). Decrement, log,
// and request a deferred re-arm (covers below-cap and was-at-cap).
void onBLEDisconnected(BLEDevice central) {
  if (connectedCount > 0) {
    connectedCount--;
  }
  String addr = central.address();
  int slot = findSlotByAddress(addr.c_str());
  if (slot >= 0) {
    connectedAddresses[slot][0] = 0;     // free the slot
  }

  Serial.print("central disconnected: ");
  Serial.print(addr);
  Serial.print(" (");
  Serial.print(connectedCount);
  Serial.print("/");
  Serial.print(MAX_CENTRALS);
  Serial.println(")");

  advertisingRequested = true;       // deferred; loop() does the real BLE.advertise()
}

// --------------------------------------------------------------------------
// Publish payload every 50 ms (called while ≥1 central is subscribed;
// BLENotify auto-broadcasts the value to every subscribed central).
// --------------------------------------------------------------------------

void maybePublish(
  Vec3 accMs2,
  Vec3 gyro,
  float pressurePa
) {
  unsigned long now = millis();

  if (now - lastSendMs < SEND_INTERVAL_MS) {
    return;
  }

  // Settle window — see `pauseUntilMs` note in the state block: skip notify TX while a
  // freshly connected central is doing GATT discovery, otherwise its ATT responses
  // get starved by this loop's notify cadence and the central times out.
  if (now < pauseUntilMs) {
    return;
  }

  lastSendMs = now;

  char payload[160];

  snprintf(
    payload,
    sizeof(payload),
    "IMU,%lu,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.1f",
    now,
    accMs2.x,
    accMs2.y,
    accMs2.z,
    gyro.x,
    gyro.y,
    gyro.z,
    pressurePa
  );

  imuChar.writeValue(payload);   // BLE notify — broadcasts to every subscribed central

  // Throttled Serial mirror — see SERIAL_ECHO_EVERY note in the state block.
  static unsigned int echoCounter = 0;
  if (++echoCounter >= SERIAL_ECHO_EVERY) {
    echoCounter = 0;
    Serial.println(payload);
  }
}

// --------------------------------------------------------------------------
// Setup
// --------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);

  // Bounded wait so the device can still run without Serial Monitor.
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000) {
    delay(10);
  }

  if (!IMU.begin()) {
    Serial.println("IMU init FAILED");
    Serial.println("Check:");
    Serial.println("- Board is Nano 33 BLE original generation");
    Serial.println("- Library is Arduino_LSM9DS1");
    Serial.println("- Tools > Board is Arduino Nano 33 BLE");
    // Retry instead of hanging; reboot if it stays dead so a transient fault can recover.
    for (unsigned int attempt = 1; !IMU.begin(); attempt++) {
      if (attempt >= INIT_MAX_ATTEMPTS) {
        Serial.println("IMU still failing — rebooting");
        delay(100);
        NVIC_SystemReset();
      }
      delay(INIT_RETRY_MS);
    }
  }

  Serial.println("IMU init OK");

  // Pressure-alarm LED on D2 — start dark so we don't flash before the first BME680 read.
  pinMode(LED_PRESSURE_PIN, OUTPUT);
  digitalWrite(LED_PRESSURE_PIN, LOW);

  // BME680 over the hardware `Wire` bus (A4=SDA, A5=SCL). Optional: a few retries, then carry on
  // without it (we still stream IMU, with pressure = 0) rather than reboot — it's a secondary sensor.
  Wire.begin();

  // I2C scanner first: probing 0x76 / 0x77 separates "no one ACKs" (wiring/power/breakout) from
  // "ACK but library init fails" (wrong sensor variant / library) — much easier to diagnose
  // from the Serial Monitor than a single "init FAILED" line.
  Serial.println("I2C scan on Wire (A4/A5):");
  bool anyAck = false;
  for (uint8_t addr : {0x76, 0x77}) {
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    if (err == 0) {
      Serial.print("  0x"); Serial.print(addr, HEX); Serial.println(" ACK");
      anyAck = true;
    } else {
      Serial.print("  0x"); Serial.print(addr, HEX); Serial.print(" NACK (err=");
      Serial.print(err); Serial.println(")");
    }
  }
  if (!anyAck) {
    Serial.println("  no devices ACK on Wire — check SDA->A4, SCL->A5, VCC=3V3, GND, pull-ups");
  }

  for (unsigned int attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt++) {
    if (bme.begin(0x76) || bme.begin(0x77)) {   // 0x76 first: matches the breakout used in bring-up
      bmeOk = true;
      break;
    }
    delay(INIT_RETRY_MS);
  }
  if (bmeOk) {
    // Pressure-only config: oversample pressure (+ a little temperature, needed for the pressure
    // compensation) and disable humidity + the gas heater. IIR filter @ 3 on-chip smooths
    // pressure noise (Bosch's recommendation for pressure monitoring). 16X oversampling +
    // IIR-3 takes ~150-200 ms per measurement, well under our 1 Hz read interval.
    bme.setTemperatureOversampling(BME680_OS_2X);
    bme.setPressureOversampling(BME680_OS_16X);
    bme.setHumidityOversampling(BME680_OS_NONE);
    bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
    bme.setGasHeater(0, 0);   // gas heater off — we only want pressure

    // Warm-up: one synchronous read here seeds lastPressurePa so the very first CSV lines after
    // boot carry a real value instead of 0 (the async loop would take ~1 s otherwise).
    if (bme.performReading()) {
      lastPressurePa = bme.pressure;
      Serial.print("BME680 init OK (pressure) — seed p=");
      Serial.print(lastPressurePa, 1); Serial.println(" Pa");
    } else {
      Serial.println("BME680 init OK (pressure) — seed read failed, will retry async");
    }
  } else {
    Serial.println("BME680 init FAILED — continuing IMU-only (pressure=0)");
    Serial.println("Check: SDA->A4, SCL->A5, 3V3 power, address 0x76/0x77,");
    Serial.println("       Adafruit BME680 + Adafruit Unified Sensor libraries installed");
  }

  if (!BLE.begin()) {
    Serial.println("BLE init FAILED");
    for (unsigned int attempt = 1; !BLE.begin(); attempt++) {
      if (attempt >= INIT_MAX_ATTEMPTS) {
        Serial.println("BLE still failing — rebooting");
        delay(100);
        NVIC_SystemReset();
      }
      delay(INIT_RETRY_MS);
    }
  }

  Serial.println("BLE init OK");

  BLE.setLocalName(DEVICE_NAME);
  BLE.setDeviceName(DEVICE_NAME);
  BLE.setAdvertisedService(imuService);

  imuService.addCharacteristic(imuChar);
  BLE.addService(imuService);

  // Multi-central event-driven model — see onBLEConnected / onBLEDisconnected above.
  BLE.setEventHandler(BLEConnected,    onBLEConnected);
  BLE.setEventHandler(BLEDisconnected, onBLEDisconnected);

  // Initial value
  imuChar.writeValue("IMU,0,0,0,0,0,0,0,0");

  BLE.advertise();

  Serial.print("BLE advertising started as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\"");

  Serial.println(
    "IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,pressure_pa"
  );

  lastSendMs = millis();
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------

void loop() {
  BLE.poll();                              // drives onBLEConnected / onBLEDisconnected

  // Deferred advertise — event handlers set advertisingRequested; we call BLE.advertise()
  // here from main context so Cordio can fully re-enter the advertising state machine and
  // accept new connect_req (the in-callback call doesn't — see state block note).
  if (advertisingRequested) {
    advertisingRequested = false;
    int rc = BLE.advertise();
    lastAdvertiseRearmMs = millis();
    Serial.print("[ble] advertise() rearm rc=");
    Serial.print(rc);
    Serial.print(" connectedCount=");
    Serial.println(connectedCount);
  }

  // Periodic idempotent re-arm while below cap — Cordio sometimes silently exits
  // advertising after a heavy notify burst on conn 1; this kick keeps us discoverable
  // without a connect/disconnect event needing to fire.
  if (connectedCount < MAX_CENTRALS &&
      millis() - lastAdvertiseRearmMs > 2000) {
    BLE.advertise();                       // no-op if already advertising
    lastAdvertiseRearmMs = millis();
  }

  // Service the BME680 every loop (non-blocking; refreshes lastPressurePa ~1 Hz). This runs
  // BEFORE the connect-gate so the sensor is exercised + the [bme] heartbeat appears in Serial
  // from boot — without waiting for a BLE central to pair (key for bring-up debugging).
  updatePressure();

  // Drive the D2 alarm LED off the same `lastPressurePa` — has to run BEFORE the connect-gate
  // so the indicator works whether or not a central is subscribed.
  updatePressureLed();

  // One-shot "resumed" log when the settle window expires — easier to read than inferring
  // resume from the payload mirror reappearing 2 s after a connect.
  {
    static unsigned long pauseExpiredAt = 0;
    if (pauseUntilMs > 0 && millis() >= pauseUntilMs && pauseExpiredAt != pauseUntilMs) {
      pauseExpiredAt = pauseUntilMs;
      Serial.println("[ble] notify TX resumed");
    }
  }

  // While connected: periodic state log so a Serial Monitor watcher can confirm the
  // advertising machine is still up + see the live active-central list. The payload
  // mirror is throttled to 2 Hz so this debug line doesn't get buried.
  if (connectedCount > 0) {
    static unsigned long lastStateLogMs = 0;
    unsigned long now = millis();
    if (now - lastStateLogMs >= 5000) {
      lastStateLogMs = now;
      Serial.print("[ble] active=[");
      bool first = true;
      for (int i = 0; i < MAX_CENTRALS; i++) {
        if (connectedAddresses[i][0] != 0) {
          if (!first) Serial.print(",");
          Serial.print(connectedAddresses[i]);
          first = false;
        }
      }
      Serial.print("] count=");
      Serial.print(connectedCount);
      Serial.print(" advertising=");
      Serial.println(connectedCount < MAX_CENTRALS ? "on" : "paused");
    }
  }

  // Connect-first for the BLE payload: only emit IMU/pressure CSV while ≥1 central is
  // subscribed. imuChar.writeValue() auto-broadcasts to every subscribed central, so the
  // publish path doesn't loop by hand.
  if (connectedCount == 0) {
    static unsigned long lastWaitingLogMs = 0;
    unsigned long now = millis();
    if (now - lastWaitingLogMs >= 2000) {
      lastWaitingLogMs = now;
      Serial.println("waiting for a BLE central to connect...");
    }
    return;
  }

  Vec3 acc;
  Vec3 gyro;
  if (!readImu(acc, gyro)) {
    return;   // run as fast as IMU data is available
  }

  Vec3 accMs2 = vscale(acc, GRAVITY);     // g -> m/s^2 (gyro stays deg/s)

  // One payload at most every 50 ms: BLE notify (broadcast) + Serial echo together.
  maybePublish(accMs2, gyro, lastPressurePa);
}
