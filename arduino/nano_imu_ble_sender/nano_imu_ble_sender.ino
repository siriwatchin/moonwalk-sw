/*
 * nano_imu_ble_sender.ino
 * --------------------------------------------------------------------------
 * Arduino Nano 33 BLE (original gen, LSM9DS1 IMU) -> BLE peripheral.
 *
 * Reads accelerometer + gyroscope and notifies a compact CSV string over BLE
 * every SEND_INTERVAL_MS. A BLE central (e.g. the UNO Q Linux-side Python
 * receiver in ../uno_q_linux_ble_receiver/ble_receiver.py) subscribes and
 * prints the data.
 *
 * Payload format (single CSV line):
 *   IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps
 * Example:
 *   IMU,123456,0.0123,-0.0456,9.8012,0.1200,-0.3100,0.0500
 *
 * Accelerometer is converted from g -> m/s^2. Gyroscope stays in deg/s.
 *
 * Libraries (install via Arduino Library Manager):
 *   - Arduino_LSM9DS1
 *   - ArduinoBLE
 * Board: "Arduino Nano 33 BLE".
 * --------------------------------------------------------------------------
 */

#include <Arduino_LSM9DS1.h>
#include <ArduinoBLE.h>

// ---- Shared constants (must match every receiver) -----------------------
static const char* DEVICE_NAME      = "NanoIMU";
static const char* SERVICE_UUID     = "19B10000-E8F2-537E-4F6C-D104768A1214";
static const char* CHAR_UUID        = "19B10001-E8F2-537E-4F6C-D104768A1214";
static const unsigned long SEND_INTERVAL_MS = 50;   // ~20 Hz
static const float GRAVITY          = 9.80665f;     // g -> m/s^2

// ---- BLE objects ---------------------------------------------------------
BLEService imuService(SERVICE_UUID);
// String characteristic keeps formatting simple; 40 bytes fits our CSV line.
BLEStringCharacteristic imuChar(CHAR_UUID, BLERead | BLENotify, 40);

unsigned long lastSendMs = 0;

void setup() {
  Serial.begin(115200);
  // Do NOT block forever on Serial: the board must also run headless (powered
  // from the UNO Q / a battery with no Serial Monitor attached).
  delay(1500);

  // ---- IMU init ----------------------------------------------------------
  if (!IMU.begin()) {
    Serial.println("IMU init FAILED");
    Serial.println("Check: board = Arduino Nano 33 BLE, Arduino_LSM9DS1 library, wiring/board health");
    while (1) { delay(1000); }   // halt: nothing useful to do without the IMU
  }
  Serial.println("IMU init OK");

  // ---- BLE init ----------------------------------------------------------
  if (!BLE.begin()) {
    Serial.println("BLE init FAILED");
    while (1) { delay(1000); }   // halt: nothing useful to do without BLE
  }
  Serial.println("BLE init OK");

  // ---- Advertise the IMU service ----------------------------------------
  BLE.setLocalName(DEVICE_NAME);
  BLE.setDeviceName(DEVICE_NAME);
  BLE.setAdvertisedService(imuService);
  imuService.addCharacteristic(imuChar);
  BLE.addService(imuService);
  imuChar.writeValue("IMU,0,0,0,0,0,0,0");   // initial value before first read

  BLE.advertise();
  Serial.print("BLE advertising started as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\"");
}

void loop() {
  // Wait for / handle a central connection (e.g. the UNO Q receiver).
  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("central connected: ");
    Serial.println(central.address());

    // Stream while the central stays connected.
    while (central.connected()) {
      unsigned long now = millis();
      if (now - lastSendMs >= SEND_INTERVAL_MS) {
        lastSendMs = now;
        sendImuSample(now);
      }
    }

    Serial.println("central disconnected");
  }
}

// Read one IMU sample, format the CSV payload, notify it and echo to Serial.
void sendImuSample(unsigned long timestampMs) {
  // Only read when both sensors have fresh data ready.
  if (!IMU.accelerationAvailable() || !IMU.gyroscopeAvailable()) {
    return;
  }

  float ax, ay, az;   // accelerometer, units: g
  float gx, gy, gz;   // gyroscope, units: deg/s
  IMU.readAcceleration(ax, ay, az);
  IMU.readGyroscope(gx, gy, gz);

  // Convert acceleration g -> m/s^2; gyro stays in deg/s.
  float ax_ms2 = ax * GRAVITY;
  float ay_ms2 = ay * GRAVITY;
  float az_ms2 = az * GRAVITY;

  // Build the compact CSV payload. snprintf keeps it bounded to the 40-byte
  // characteristic. %.4f -> 4 decimal places for both accel and gyro.
  char payload[40];
  snprintf(payload, sizeof(payload),
           "IMU,%lu,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f",
           timestampMs, ax_ms2, ay_ms2, az_ms2, gx, gy, gz);

  imuChar.writeValue(payload);   // notify subscribed central
  Serial.println(payload);       // local debug echo
}
