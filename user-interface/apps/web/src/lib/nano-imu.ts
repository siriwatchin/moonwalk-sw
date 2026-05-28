export type NanoImuSample = {
  device: string;
  timestamp_ms: number;
  accel: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
  pressure: number;
  raw: string;
};

export const NANO_IMU_DEVICE_NAME = "NanoIMU";
export const NANO_IMU_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
export const NANO_IMU_CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";

export function decodeNanoImuValue(value: DataView) {
  return new TextDecoder().decode(
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
  );
}

export function parseNanoImuPayload(raw: string): NanoImuSample | null {
  const parts = raw.trim().split(",");

  if (parts.length !== 9 || parts[0] !== "IMU") {
    return null;
  }

  const timestampMs = Number.parseInt(parts[1] ?? "", 10);
  const values = parts.slice(2, 9).map(Number);

  if (
    !Number.isFinite(timestampMs) ||
    values.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }

  const [ax, ay, az, gx, gy, gz, pressure] = values;

  return {
    device: NANO_IMU_DEVICE_NAME,
    timestamp_ms: timestampMs,
    accel: { x: ax ?? 0, y: ay ?? 0, z: az ?? 0 },
    gyro: { x: gx ?? 0, y: gy ?? 0, z: gz ?? 0 },
    pressure: pressure ?? 0,
    raw,
  };
}
