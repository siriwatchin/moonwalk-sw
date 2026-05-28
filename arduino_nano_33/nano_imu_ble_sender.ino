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
 *   Serial echo together) only while a BLE central is connected. Before that it
 *   just advertises and prints a periodic "waiting" heartbeat.
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
// BLE connection status
// --------------------------------------------------------------------------

// Poll BLE; log connect/disconnect transitions + a periodic "waiting" heartbeat;
// re-arm advertising after a disconnect. Returns the current connection state.
bool updateConnection() {
  static bool wasConnected = false;
  static unsigned long lastWaitingLogMs = 0;

  BLEDevice central = BLE.central();
  bool connected = central && central.connected();

  if (connected && !wasConnected) {
    Serial.print("central connected: ");
    Serial.println(central.address());
  } else if (!connected && wasConnected) {
    Serial.println("central disconnected; advertising again");
    BLE.advertise();                 // re-arm advertising (some ArduinoBLE versions stop after disconnect)
  } else if (!connected) {
    unsigned long now = millis();    // heartbeat so a bare Serial Monitor shows we're alive + waiting
    if (now - lastWaitingLogMs >= 2000) {
      lastWaitingLogMs = now;
      Serial.println("waiting for a BLE central (UNO Q) to connect...");
    }
  }

  wasConnected = connected;
  return connected;
}

// --------------------------------------------------------------------------
// Publish payload every 50 ms (called only while a central is connected)
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

  imuChar.writeValue(payload);   // BLE notify to the connected central
  Serial.println(payload);       // mirror to Serial for debug
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
  bool connected = updateConnection();

  // Service the BME680 every loop (non-blocking; refreshes lastPressurePa ~1 Hz). This runs
  // BEFORE the connect-gate so the sensor is exercised + the [bme] heartbeat appears in Serial
  // from boot — without waiting for a BLE central to pair (key for bring-up debugging).
  updatePressure();

  // Connect-first for the BLE payload: only emit IMU/pressure CSV while a central is connected.
  if (!connected) {
    return;
  }

  Vec3 acc;
  Vec3 gyro;
  if (!readImu(acc, gyro)) {
    return;   // run as fast as IMU data is available
  }

  Vec3 accMs2 = vscale(acc, GRAVITY);     // g -> m/s^2 (gyro stays deg/s)

  // One payload at most every 50 ms: BLE notify + Serial echo together.
  maybePublish(accMs2, gyro, lastPressurePa);
}
