// AUTO-GENERATED from protocol/ble_contract.json by protocol/gen_contract.py — DO NOT EDIT.
#pragma once

static const char* DEVICE_NAME  = "NanoIMU";
static const char* SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
static const char* CHAR_UUID    = "19B10001-E8F2-537E-4F6C-D104768A1214";

const float         GRAVITY          = 9.80665f;
const unsigned long SEND_INTERVAL_MS = 50;

// Phase classification thresholds
const float ACC_NEAR_G_THRESHOLD = 0.3f;  // m/s^2
const float GYRO_ZERO_THRESHOLD  = 2.0f;   // deg/s
const float GYRO_SWING_THRESHOLD = 25.0f;  // deg/s
