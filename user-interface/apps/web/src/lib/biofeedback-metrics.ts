import type { NanoImuSample } from "@/lib/nano-imu";

const GRAVITY_MS2 = 9.80665;
const DEFAULT_PLANT_GYRO_DPS = 20;
const DEFAULT_REFRACTORY_MS = 220;
const DEFAULT_PRESSURE_TARE_PA = 101_325;
const DEFAULT_BASELINE_PRESSURE_DELTA_PA = 7_730;

type Axis = "x" | "y" | "z";

export type BiofeedbackMetricsConfig = {
  plantGyroDps?: number;
  refractoryMs?: number;
  pressureTarePa?: number;
  baselinePressureDeltaPa?: number;
};

export type BiofeedbackAction =
  | "เริ่มเก็บข้อมูล"
  | "กำลังเดิน"
  | "เดินต่อเนื่อง"
  | "แกว่งมาก"
  | "ลงน้ำหนักมาก"
  | "จังหวะไม่สม่ำเสมอ";

export type BiofeedbackMetrics = {
  sampleCount: number;
  durationMs: number;
  swingAxis: Axis;
  gyroMagnitudeDps: number;
  accelMagnitudeG: number;
  plants: number[];
  cadenceSpm: number | null;
  cycleTimeMs: number | null;
  dutyFactorPercent: number | null;
  rhythmScore: number | null;
  symmetryRatio: number | null;
  consistency: number | null;
  pressureDeltaPa: number;
  loadPercent: number;
  action: BiofeedbackAction;
  confidence: number;
};

type PreparedSample = NanoImuSample & {
  accelMagnitudeG: number;
  gyroMagnitudeDps: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) {
    return 0;
  }

  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function coefficientOfVariation(values: number[]) {
  const avg = mean(values);

  if (values.length < 2 || avg === 0) {
    return 0;
  }

  return standardDeviation(values) / Math.abs(avg);
}

function prepareSamples(samples: NanoImuSample[]) {
  return samples
    .filter((sample) => Number.isFinite(sample.timestamp_ms))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
    .map<PreparedSample>((sample) => {
      const axG = sample.accel.x / GRAVITY_MS2;
      const ayG = sample.accel.y / GRAVITY_MS2;
      const azG = sample.accel.z / GRAVITY_MS2;

      return {
        ...sample,
        accelMagnitudeG: Math.sqrt(axG ** 2 + ayG ** 2 + azG ** 2),
        gyroMagnitudeDps: Math.sqrt(
          sample.gyro.x ** 2 + sample.gyro.y ** 2 + sample.gyro.z ** 2,
        ),
      };
    });
}

function selectSwingAxis(samples: PreparedSample[]): Axis {
  const axes: Axis[] = ["x", "y", "z"];
  const [bestAxis] = axes
    .map((axis) => ({
      axis,
      deviation: standardDeviation(samples.map((sample) => sample.gyro[axis])),
    }))
    .sort((a, b) => b.deviation - a.deviation);

  return bestAxis?.axis ?? "y";
}

function isImpact(samples: PreparedSample[], index: number) {
  const start = Math.max(0, index - 10);
  const nearby = samples.slice(start, index + 1).map((sample) => sample.accelMagnitudeG);
  const baseline = mean(nearby);
  const current = samples[index]?.accelMagnitudeG ?? 0;

  return current > Math.max(1.08, baseline + 0.08);
}

function detectPlants(
  samples: PreparedSample[],
  swingAxis: Axis,
  plantGyroDps: number,
  refractoryMs: number,
) {
  const plants: number[] = [];
  let lastPlantMs = Number.NEGATIVE_INFINITY;

  for (let index = 1; index < samples.length - 1; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const next = samples[index + 1];

    if (!previous || !current || !next) {
      continue;
    }

    const previousSwing = Math.abs(previous.gyro[swingAxis]);
    const currentSwing = Math.abs(current.gyro[swingAxis]);
    const nextSwing = Math.abs(next.gyro[swingAxis]);
    const entersStillBand =
      previousSwing >= plantGyroDps && currentSwing < plantGyroDps;
    const localSwingValley =
      currentSwing <= previousSwing &&
      currentSwing <= nextSwing &&
      currentSwing < plantGyroDps;
    const hasImpact = isImpact(samples, index);
    const enoughGap = current.timestamp_ms - lastPlantMs >= refractoryMs;

    if (enoughGap && hasImpact && (entersStillBand || localSwingValley)) {
      plants.push(current.timestamp_ms);
      lastPlantMs = current.timestamp_ms;
    }
  }

  return plants;
}

function calculateDutyFactor(
  samples: PreparedSample[],
  plants: number[],
  plantGyroDps: number,
) {
  const dutyByCycle: number[] = [];

  for (let cycleIndex = 1; cycleIndex < plants.length; cycleIndex += 1) {
    const startMs = plants[cycleIndex - 1] ?? 0;
    const endMs = plants[cycleIndex] ?? 0;
    const cycleTimeMs = endMs - startMs;

    if (cycleTimeMs <= 0) {
      continue;
    }

    let plantedMs = 0;

    for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += 1) {
      const previous = samples[sampleIndex - 1];
      const current = samples[sampleIndex];

      if (!previous || !current) {
        continue;
      }

      if (current.timestamp_ms < startMs || current.timestamp_ms >= endMs) {
        continue;
      }

      if (current.gyroMagnitudeDps < plantGyroDps) {
        plantedMs += current.timestamp_ms - previous.timestamp_ms;
      }
    }

    dutyByCycle.push(clamp(plantedMs / cycleTimeMs, 0, 1));
  }

  return dutyByCycle;
}

function calculateRhythmScore(cycleTimesMs: number[]) {
  if (cycleTimesMs.length < 4) {
    return {
      consistency: null,
      rhythmScore: null,
      symmetryRatio: null,
    };
  }

  const sideA = cycleTimesMs.filter((_, index) => index % 2 === 0);
  const sideB = cycleTimesMs.filter((_, index) => index % 2 === 1);
  const sideAMean = mean(sideA);
  const sideBMean = mean(sideB);
  const symmetryRatio = Math.min(sideAMean, sideBMean) / Math.max(sideAMean, sideBMean);
  const consistency = clamp(
    1 - mean([coefficientOfVariation(sideA), coefficientOfVariation(sideB)]),
    0,
    1,
  );
  const rhythmScore = 100 * (0.6 * symmetryRatio + 0.4 * consistency);

  return {
    consistency,
    rhythmScore,
    symmetryRatio,
  };
}

function getAction(metrics: Omit<BiofeedbackMetrics, "action">): BiofeedbackAction {
  if (metrics.sampleCount < 20 || metrics.plants.length < 2) {
    return "เริ่มเก็บข้อมูล";
  }

  if (metrics.loadPercent > 115) {
    return "ลงน้ำหนักมาก";
  }

  if (metrics.gyroMagnitudeDps > 140) {
    return "แกว่งมาก";
  }

  if (metrics.rhythmScore !== null && metrics.rhythmScore < 72) {
    return "จังหวะไม่สม่ำเสมอ";
  }

  if (metrics.plants.length >= 5) {
    return "เดินต่อเนื่อง";
  }

  return "กำลังเดิน";
}

export function calculateBiofeedbackMetrics(
  samples: NanoImuSample[],
  config: BiofeedbackMetricsConfig = {},
): BiofeedbackMetrics {
  const preparedSamples = prepareSamples(samples);
  const latestSample = preparedSamples.at(-1);
  const firstSample = preparedSamples.at(0);
  const plantGyroDps = config.plantGyroDps ?? DEFAULT_PLANT_GYRO_DPS;
  const refractoryMs = config.refractoryMs ?? DEFAULT_REFRACTORY_MS;
  const pressureTarePa = config.pressureTarePa ?? DEFAULT_PRESSURE_TARE_PA;
  const baselinePressureDeltaPa =
    config.baselinePressureDeltaPa ?? DEFAULT_BASELINE_PRESSURE_DELTA_PA;
  const swingAxis = selectSwingAxis(preparedSamples);
  const plants = detectPlants(preparedSamples, swingAxis, plantGyroDps, refractoryMs);
  const cycleTimesMs = plants
    .slice(1)
    .map((plantMs, index) => plantMs - (plants[index] ?? plantMs))
    .filter((cycleTimeMs) => cycleTimeMs >= 300 && cycleTimeMs <= 3_000);
  const recentCycleTimes = cycleTimesMs.slice(-8);
  const cycleTimeMs =
    recentCycleTimes.length > 0 ? mean(recentCycleTimes) : null;
  const cadenceSpm = cycleTimeMs ? 60_000 / cycleTimeMs : null;
  const dutyFactors = calculateDutyFactor(preparedSamples, plants, plantGyroDps);
  const dutyFactorPercent =
    dutyFactors.length > 0 ? mean(dutyFactors.slice(-8)) * 100 : null;
  const { consistency, rhythmScore, symmetryRatio } =
    calculateRhythmScore(cycleTimesMs);
  const pressureDeltaPa = Math.max(0, (latestSample?.pressure ?? pressureTarePa) - pressureTarePa);
  const loadPercent =
    baselinePressureDeltaPa > 0
      ? clamp((pressureDeltaPa / baselinePressureDeltaPa) * 100, 0, 200)
      : 0;
  const durationMs =
    latestSample && firstSample ? latestSample.timestamp_ms - firstSample.timestamp_ms : 0;
  const confidence = clamp(
    preparedSamples.length / 100 + plants.length / 8 + (rhythmScore === null ? 0 : 0.25),
    0,
    1,
  );
  const metricsWithoutAction = {
    sampleCount: preparedSamples.length,
    durationMs,
    swingAxis,
    gyroMagnitudeDps: latestSample?.gyroMagnitudeDps ?? 0,
    accelMagnitudeG: latestSample?.accelMagnitudeG ?? 0,
    plants,
    cadenceSpm,
    cycleTimeMs,
    dutyFactorPercent,
    rhythmScore,
    symmetryRatio,
    consistency,
    pressureDeltaPa,
    loadPercent,
    confidence,
  };

  return {
    ...metricsWithoutAction,
    action: getAction(metricsWithoutAction),
  };
}
