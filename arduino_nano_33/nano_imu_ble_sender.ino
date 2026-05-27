/*
 * nano_imu_ble_sender.ino
 * --------------------------------------------------------------------------
 * Arduino Nano 33 BLE original generation + LSM9DS1 IMU
 *
 * Role:
 *   Nano 33 BLE = BLE Peripheral / Sensor Node
 *
 * It reads accelerometer + gyroscope and sends a raw IMU CSV payload over BLE.
 *
 * Payload:
 *   IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps
 *
 * Notes:
 * - Raw 6-axis only: no norms, no phase classification, no velocity/distance, no Kalman.
 *   Any feature extraction / classification is done downstream on the UNO Q.
 * - UNO Q receives BLE payload and stores/displays data.
 * - Connect-first: the Nano reads the IMU and emits a payload (BLE notify +
 *   Serial echo together) only while a BLE central is connected. Before that it
 *   just advertises and prints a periodic "waiting" heartbeat.
 * --------------------------------------------------------------------------
 */

#include <Arduino_LSM9DS1.h>
#include <ArduinoBLE.h>

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
// State
// --------------------------------------------------------------------------

unsigned long lastSendMs = 0;

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
  Vec3 gyro
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
    "IMU,%lu,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f",
    now,
    accMs2.x,
    accMs2.y,
    accMs2.z,
    gyro.x,
    gyro.y,
    gyro.z
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
  imuChar.writeValue("IMU,0,0,0,0,0,0,0");

  BLE.advertise();

  Serial.print("BLE advertising started as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\"");

  Serial.println(
    "IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps"
  );

  lastSendMs = millis();
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------

void loop() {
  bool connected = updateConnection();

  // Connect-first: don't read the IMU or emit anything until a central is connected.
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
  maybePublish(accMs2, gyro);
}
