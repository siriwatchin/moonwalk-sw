/*
 * nano_imu_ble_sender.ino
 * --------------------------------------------------------------------------
 * Arduino Nano 33 BLE (original gen, LSM9DS1 IMU) -> BLE peripheral.
 *
 * Smart-cane / gait prototype, phase 1: prove the Nano can produce a stable
 * IMU + walking-phase payload over BLE. Inspired by "Walking Distance
 * Estimation Using Walking Canes with Inertial Sensors": rather than starting
 * from raw double-integration, we start from lightweight phase detection using
 * the accelerometer and gyroscope NORMS.
 *
 * Each 50 ms it reads accel+gyro, converts accel g->m/s^2 (gyro stays deg/s),
 * computes acc_norm + gyro_norm, classifies the walking phase, and notifies a
 * compact CSV line over BLE (also echoed to Serial).
 *
 * Payload (11 comma-separated fields):
 *   IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase
 *
 * No calibration / baseline subtraction here on purpose: acc_norm must sit
 * near gravity for the phase rules to hold. No velocity/distance, no Kalman.
 *
 * Libraries: Arduino_LSM9DS1, ArduinoBLE.  Board: "Arduino Nano 33 BLE".
 * --------------------------------------------------------------------------
 */

#include <Arduino_LSM9DS1.h>   // Nano 33 BLE original gen IMU
#include <ArduinoBLE.h>

// ---- Shared BLE contract -------------------------------------------------
static const char* DEVICE_NAME  = "NanoIMU";
static const char* SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
static const char* CHAR_UUID    = "19B10001-E8F2-537E-4F6C-D104768A1214";

const float GRAVITY = 9.80665;
const unsigned long PRINT_INTERVAL_MS = 50;   // serial echo + BLE notify rate

// ---- Phase classification thresholds ------------------------------------
const float ACC_NEAR_G_THRESHOLD = 0.30;   // |acc_norm - g| below this = "near gravity"
const float GYRO_ZERO_THRESHOLD  = 2.0;    // deg/s below this = "no rotation"
const float GYRO_SWING_THRESHOLD = 25.0;   // deg/s at/above this = "swing"

// ---- Phase codes ---------------------------------------------------------
enum Phase {
  PHASE_UNKNOWN                  = 0,
  PHASE_STATIONARY_OR_ZERO_VEL   = 1,
  PHASE_GROUND_CONTACT_ROTATION  = 2,
  PHASE_SWING_OR_ON_AIR          = 3,
};

// ---- BLE objects ---------------------------------------------------------
BLEService imuService(SERVICE_UUID);
// 11-field CSV line fits comfortably in 96 bytes. Central stacks negotiate a
// larger ATT MTU so the whole line arrives in one notification.
BLEStringCharacteristic imuChar(CHAR_UUID, BLERead | BLENotify, 96);

unsigned long lastPrintMs = 0;

// ==========================================================================
// Vec3: tiny value type so per-axis math / norms are written once.
// ==========================================================================
struct Vec3 { float x, y, z; };

Vec3  vscale(Vec3 v, float s) { return { v.x * s, v.y * s, v.z * s }; }
float vmag(Vec3 v)            { return sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

// ==========================================================================
// Helpers
// ==========================================================================

// Read accel (g) + gyro (deg/s) if both are ready; false otherwise.
bool readImu(Vec3& acc, Vec3& gyro) {
  if (!IMU.accelerationAvailable() || !IMU.gyroscopeAvailable()) return false;
  IMU.readAcceleration(acc.x, acc.y, acc.z);
  IMU.readGyroscope(gyro.x, gyro.y, gyro.z);
  return true;
}

// Lightweight walking-phase detection from the two norms.
int classifyPhase(float accNorm, float gyroNorm) {
  float accDelta = fabs(accNorm - GRAVITY);
  bool nearGravity = accDelta < ACC_NEAR_G_THRESHOLD;

  if (nearGravity && gyroNorm < GYRO_ZERO_THRESHOLD) {
    return PHASE_STATIONARY_OR_ZERO_VEL;
  }
  if (nearGravity && gyroNorm >= GYRO_ZERO_THRESHOLD && gyroNorm < GYRO_SWING_THRESHOLD) {
    return PHASE_GROUND_CONTACT_ROTATION;
  }
  if (accDelta >= ACC_NEAR_G_THRESHOLD || gyroNorm >= GYRO_SWING_THRESHOLD) {
    return PHASE_SWING_OR_ON_AIR;
  }
  return PHASE_UNKNOWN;
}

// Poll BLE, log connect/disconnect transitions, return current state.
bool updateConnection() {
  static bool wasConnected = false;
  BLEDevice central = BLE.central();
  bool connected = central && central.connected();

  if (connected && !wasConnected) {
    Serial.print("central connected: ");
    Serial.println(central.address());
  } else if (!connected && wasConnected) {
    Serial.println("central disconnected");
  }
  wasConnected = connected;
  return connected;
}

// Every 50 ms: format the payload, notify over BLE (if connected), echo Serial.
void maybePublish(bool connected, Vec3 accMs2, Vec3 gyro,
                  float accNorm, float gyroNorm, int phase) {
  unsigned long now = millis();
  if (now - lastPrintMs < PRINT_INTERVAL_MS) return;
  lastPrintMs = now;

  char payload[96];
  snprintf(payload, sizeof(payload),
           "IMU,%lu,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%d",
           now,
           accMs2.x, accMs2.y, accMs2.z,
           gyro.x, gyro.y, gyro.z,
           accNorm, gyroNorm, phase);

  if (connected) imuChar.writeValue(payload);   // BLE notify
  Serial.println(payload);                       // local debug echo
}

// ==========================================================================
// Arduino entry points
// ==========================================================================
void setup() {
  Serial.begin(115200);
  // Bounded wait for Serial so the board still runs headless (battery / powered
  // by the gateway with no Serial Monitor attached).
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000);

  if (!IMU.begin()) {
    Serial.println("IMU init FAILED");
    Serial.println("Check board type / Arduino_LSM9DS1 library / Tools > Board");
    while (1) { delay(1000); }
  }
  Serial.println("IMU init OK");

  if (!BLE.begin()) {
    Serial.println("BLE init FAILED");
    while (1) { delay(1000); }
  }
  Serial.println("BLE init OK");

  BLE.setLocalName(DEVICE_NAME);
  BLE.setDeviceName(DEVICE_NAME);
  BLE.setAdvertisedService(imuService);
  imuService.addCharacteristic(imuChar);
  BLE.addService(imuService);
  imuChar.writeValue("IMU,0,0,0,0,0,0,0,0,0,0");   // initial value

  BLE.advertise();
  Serial.print("BLE advertising started as \"");
  Serial.print(DEVICE_NAME);
  Serial.println("\"");

  lastPrintMs = millis();

  // CSV header (matches the BLE payload field order) for serial debugging.
  Serial.println("IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase");
}

void loop() {
  bool connected = updateConnection();

  Vec3 acc, gyro;
  if (!readImu(acc, gyro)) return;   // run as fast as IMU data is available

  Vec3 accMs2 = vscale(acc, GRAVITY);     // g -> m/s^2 (gyro stays deg/s)
  float accNorm  = vmag(accMs2);
  float gyroNorm = vmag(gyro);
  int phase = classifyPhase(accNorm, gyroNorm);

  maybePublish(connected, accMs2, gyro, accNorm, gyroNorm, phase);
}
