export type NanoImuPhase = 0 | 1 | 2 | 3;

export type NanoImuSample = {
  device: string;
  timestamp_ms: number;
  accel: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
  acc_norm: number;
  gyro_norm: number;
  phase: NanoImuPhase;
  phase_label: string;
  raw: string;
};

export const NANO_IMU_PHASE_LABELS: Record<NanoImuPhase, string> = {
  0: "UNKNOWN",
  1: "STATIONARY_OR_ZERO_VELOCITY",
  2: "GROUND_CONTACT_WITH_ROTATION",
  3: "SWING_OR_ON_AIR",
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

  if (parts.length !== 11 || parts[0] !== "IMU") {
    return null;
  }

  const timestampMs = Number.parseInt(parts[1] ?? "", 10);
  const values = parts.slice(2, 10).map(Number);
  const phase = Number.parseInt(parts[10] ?? "", 10) as NanoImuPhase;

  if (
    !Number.isFinite(timestampMs) ||
    values.some((value) => !Number.isFinite(value)) ||
    !(phase in NANO_IMU_PHASE_LABELS)
  ) {
    return null;
  }

  const [ax, ay, az, gx, gy, gz, accNorm, gyroNorm] = values;

  return {
    device: NANO_IMU_DEVICE_NAME,
    timestamp_ms: timestampMs,
    accel: { x: ax ?? 0, y: ay ?? 0, z: az ?? 0 },
    gyro: { x: gx ?? 0, y: gy ?? 0, z: gz ?? 0 },
    acc_norm: accNorm ?? 0,
    gyro_norm: gyroNorm ?? 0,
    phase,
    phase_label: NANO_IMU_PHASE_LABELS[phase],
    raw,
  };
}
