/*
 * uno_q_ble_receiver.ino
 * --------------------------------------------------------------------------
 * BEST-EFFORT BLE central for the Arduino UNO Q (MCU / STM32 side).
 *
 * !! IMPORTANT HARDWARE NOTE !!
 * On the UNO Q the BLE/Wi-Fi radio is attached to the Qualcomm Linux (Debian)
 * side, NOT to the STM32 MCU that runs this sketch. ArduinoBLE central mode
 * here will most likely fail to find/connect to the radio (or fail to
 * compile for this board). If so, use the PRIMARY receiver instead:
 *     ../uno_q_linux_ble_receiver/ble_receiver.py   (Python + bleak)
 * This sketch is kept only to confirm that behaviour on real hardware.
 *
 * It scans for "NanoIMU", connects, subscribes to the IMU characteristic,
 * then prints the raw CSV payload and minimally-parsed values.
 *
 * Library: ArduinoBLE.
 * --------------------------------------------------------------------------
 */

#include <ArduinoBLE.h>

// ---- Shared constants (must match the sender) ---------------------------
static const char* DEVICE_NAME  = "NanoIMU";
static const char* SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
static const char* CHAR_UUID    = "19B10001-E8F2-537E-4F6C-D104768A1214";

void setup() {
  Serial.begin(115200);
  delay(1500);

  if (!BLE.begin()) {
    Serial.println("BLE init FAILED");
    Serial.println("If this board has no MCU-side BLE radio, use the Python receiver instead.");
    while (1) { delay(1000); }
  }
  Serial.println("BLE init OK");

  // Scan only for our target device name.
  BLE.scanForName(DEVICE_NAME);
  Serial.println("scanning...");
}

void loop() {
  // Look for the next discovered peripheral matching the scan filter.
  BLEDevice peripheral = BLE.available();

  if (peripheral) {
    if (peripheral.localName() != DEVICE_NAME) {
      return;   // not ours, keep scanning
    }

    Serial.print("found ");
    Serial.println(DEVICE_NAME);
    BLE.stopScan();

    monitorPeripheral(peripheral);

    // Returned -> disconnected. Resume scanning to reconnect.
    Serial.println("disconnected / reconnecting");
    BLE.scanForName(DEVICE_NAME);
    Serial.println("scanning...");
  }
}

// Connect, discover, subscribe, then stream until the link drops.
void monitorPeripheral(BLEDevice peripheral) {
  if (!peripheral.connect()) {
    Serial.println("connect failed");
    return;
  }
  Serial.println("connected");

  if (!peripheral.discoverAttributes()) {
    Serial.println("attribute discovery failed");
    peripheral.disconnect();
    return;
  }

  BLECharacteristic imuChar = peripheral.characteristic(CHAR_UUID);
  if (!imuChar) {
    Serial.println("IMU characteristic not found");
    peripheral.disconnect();
    return;
  }

  if (!imuChar.canSubscribe() || !imuChar.subscribe()) {
    Serial.println("subscribe failed");
    peripheral.disconnect();
    return;
  }
  Serial.println("subscribed");

  // Stream notifications until disconnect.
  while (peripheral.connected()) {
    if (imuChar.valueUpdated()) {
      // Copy the value into a NUL-terminated buffer.
      char payload[48];
      int len = imuChar.valueLength();
      if (len > (int)sizeof(payload) - 1) {
        len = sizeof(payload) - 1;
      }
      imuChar.readValue((uint8_t*)payload, len);
      payload[len] = '\0';

      Serial.print("raw: ");
      Serial.println(payload);
      printParsed(payload);
    }
  }
}

// Minimal CSV parse: "IMU,ts,ax,ay,az,gx,gy,gz" -> readable fields.
void printParsed(char* payload) {
  // strtok mutates the buffer in place; we already own this copy.
  char* tag = strtok(payload, ",");
  if (!tag || strcmp(tag, "IMU") != 0) {
    return;   // not a payload line we understand
  }
  char* ts = strtok(NULL, ",");
  char* ax = strtok(NULL, ",");
  char* ay = strtok(NULL, ",");
  char* az = strtok(NULL, ",");
  char* gx = strtok(NULL, ",");
  char* gy = strtok(NULL, ",");
  char* gz = strtok(NULL, ",");
  if (!ts || !ax || !ay || !az || !gx || !gy || !gz) {
    return;   // malformed line
  }

  Serial.print("timestamp="); Serial.print(ts);
  Serial.print(" ax="); Serial.print(ax);
  Serial.print(" ay="); Serial.print(ay);
  Serial.print(" az="); Serial.print(az);
  Serial.print(" gx="); Serial.print(gx);
  Serial.print(" gy="); Serial.print(gy);
  Serial.print(" gz="); Serial.println(gz);

  // TODO(Supabase): forward parsed sample to gateway/Supabase here.
}
