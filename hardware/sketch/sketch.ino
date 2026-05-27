#include "Arduino_Modulino.h"
#include "Arduino_LSM6DSOX.h"
#include "Arduino_RouterBridge.h"

ModulinoMovement imu;

const unsigned long READ_INTERVAL_MS = 50;
const char PROTOCOL_VERSION[] = "cane-posture.motion.v1";
unsigned long lastReadMs = 0;

String motionJson(unsigned long timestampMs, float ax, float ay, float az, float roll, float pitch, float yaw) {
  String json = "{";
  json += "\"protocol\":\"" + String(PROTOCOL_VERSION) + "\",";
  json += "\"kind\":\"raw\",";
  json += "\"timestamp_ms\":" + String(timestampMs) + ",";
  json += "\"ax_g\":" + String(ax, 4) + ",";
  json += "\"ay_g\":" + String(ay, 4) + ",";
  json += "\"az_g\":" + String(az, 4) + ",";
  json += "\"roll_dps\":" + String(roll, 4) + ",";
  json += "\"pitch_dps\":" + String(pitch, 4) + ",";
  json += "\"yaw_dps\":" + String(yaw, 4);
  json += "}";
  return json;
}

void setup() {
  Monitor.begin();
  Modulino.begin();
  imu.begin();

  Bridge.begin();

  Monitor.println("Modulino Movement bridge ready");
}

void loop() {
  unsigned long now = millis();
  if (now - lastReadMs >= READ_INTERVAL_MS) {
    lastReadMs = now;
    imu.update();

    float ax = imu.getX();
    float ay = imu.getY();
    float az = imu.getZ();
    float roll = imu.getRoll();
    float pitch = imu.getPitch();
    float yaw = imu.getYaw();

    Bridge.notify("motion_update", ax, ay, az, roll, pitch, yaw);
    Monitor.print("MWALK_MOTION_RAW ");
    Monitor.println(motionJson(now, ax, ay, az, roll, pitch, yaw));
  }
}
