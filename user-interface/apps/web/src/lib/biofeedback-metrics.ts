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
  baseline?: BiofeedbackBaseline;
  targetLoadPercent?: number;
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
  loadControlPercent: number;
  loadControlLabel: "เบาเกินไป" | "อยู่ในเป้าหมาย" | "กดมากไป";
  activationScore: number;
  activationLabel: "สงบ" | "กำลังเดินปกติ" | "ใช้แรงสูง" | "ควรชะลอ";
  gaitReadiness: number | null;
  readinessLabel: "พร้อมเดิน" | "เดินแบบระวัง" | "พักก่อน" | "กำลังสร้าง baseline";
  mobilityStrain: number;
  fatigueSlope: number | null;
  fatigueLabel: "ยังคงที่" | "เริ่มล้า" | "ควรพัก" | "กำลังอ่าน";
  recommendation: string;
  action: BiofeedbackAction;
  confidence: number;
};

export type BiofeedbackBaseline = {
  sessionCount: number;
  cadenceMedian: number;
  rhythmMedian: number;
  dutyFactorMedian: number;
  baselinePressureDeltaPa: number;
  activationMedian: number;
  activationMad: number;
};

export type BiofeedbackSessionSummary = {
  id: string;
  startedAt: string;
  endedAt: string;
  deviceType: string;
  sampleCount: number;
  stepCount: number;
  readinessScore: number | null;
  mobilityStrain: number;
  rhythmScore: number | null;
  symmetryRatio: number | null;
  dutyFactorPercent: number | null;
  cadenceSpm: number | null;
  loadInTargetPercent: number;
  fatigueSlope: number | null;
  dominantAction: BiofeedbackAction;
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

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 0) {
    return ((sortedValues[middle - 1] ?? 0) + (sortedValues[middle] ?? 0)) / 2;
  }

  return sortedValues[middle] ?? 0;
}

function scoreDistance(value: number, target: number, tolerance: number) {
  if (target === 0) {
    return 50;
  }

  return clamp(100 - (Math.abs(value - target) / tolerance) * 100, 0, 100);
}

function prepareSamples(samples: NanoImuSample[]) {
  return samples
    .filter((sample) => {
      return (
        Number.isFinite(sample.timestamp_ms) &&
        Number.isFinite(sample.accel.x) &&
        Number.isFinite(sample.accel.y) &&
        Number.isFinite(sample.accel.z) &&
        Number.isFinite(sample.gyro.x) &&
        Number.isFinite(sample.gyro.y) &&
        Number.isFinite(sample.gyro.z)
      );
    })
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
  const start = Math.max(0, index - 20);
  const end = Math.min(samples.length, index + 21);
  const nearby = samples.slice(start, end).map((sample) => sample.accelMagnitudeG);
  const baseline = mean(nearby);
  const current = samples[index]?.accelMagnitudeG ?? 0;

  return current > Math.max(1.06, baseline + 0.06);
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

      const accIsSteady = Math.abs(current.accelMagnitudeG - 1) < 0.2;

      if (current.gyroMagnitudeDps < plantGyroDps && accIsSteady) {
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

function getAction(
  metrics: Omit<BiofeedbackMetrics, "action" | "recommendation">,
): BiofeedbackAction {
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

function calculateActivationScore(
  latestSample: PreparedSample | undefined,
  cycleTimesMs: number[],
  loadPercent: number,
  baseline: BiofeedbackBaseline | undefined,
) {
  if (!latestSample) {
    return 0;
  }

  const motionDemand =
    latestSample.gyroMagnitudeDps / 95 +
    Math.abs(latestSample.accelMagnitudeG - 1) * 1.2;
  const rhythmPenalty =
    cycleTimesMs.length >= 4 ? coefficientOfVariation(cycleTimesMs.slice(-8)) * 1.8 : 0;
  const loadDemand = loadPercent / 120;
  const rawActivation = motionDemand * 0.48 + rhythmPenalty * 0.22 + loadDemand * 0.3;
  const baselineMedian = baseline?.activationMedian ?? 0.85;
  const baselineMad = Math.max(0.25, baseline?.activationMad ?? 0.55);

  return clamp((rawActivation - baselineMedian) / baselineMad + 1.35, 0, 3);
}

function getActivationLabel(score: number): BiofeedbackMetrics["activationLabel"] {
  if (score < 1) {
    return "สงบ";
  }

  if (score < 2) {
    return "กำลังเดินปกติ";
  }

  if (score < 2.7) {
    return "ใช้แรงสูง";
  }

  return "ควรชะลอ";
}

function calculateLoadControl(loadPercent: number, targetLoadPercent: number) {
  const targetDelta = Math.abs(loadPercent - targetLoadPercent);

  return {
    loadControlPercent: clamp(100 - targetDelta * 2, 0, 100),
    loadControlLabel:
      loadPercent > targetLoadPercent + 15
        ? "กดมากไป"
        : loadPercent < Math.max(5, targetLoadPercent - 25)
          ? "เบาเกินไป"
          : "อยู่ในเป้าหมาย",
  } satisfies Pick<BiofeedbackMetrics, "loadControlLabel" | "loadControlPercent">;
}

function calculatePressureDeltaPa(
  samples: PreparedSample[],
  pressureTarePa: number,
) {
  const cleanedDeltas = samples
    .map((sample) => sample.pressure)
    .filter((pressure) => Number.isFinite(pressure) && pressure > 0 && pressure >= 90_000)
    .map((pressure) => Math.max(0, pressure - pressureTarePa))
    .slice(-3);

  return median(cleanedDeltas);
}

function calculateGaitReadiness({
  baseline,
  cadenceSpm,
  dutyFactorPercent,
  fatigueSlope,
  loadControlPercent,
  rhythmScore,
  symmetryRatio,
}: {
  baseline: BiofeedbackBaseline | undefined;
  cadenceSpm: number | null;
  dutyFactorPercent: number | null;
  fatigueSlope: number | null;
  loadControlPercent: number;
  rhythmScore: number | null;
  symmetryRatio: number | null;
}) {
  if (!baseline || baseline.sessionCount < 3 || !rhythmScore || !cadenceSpm) {
    return {
      gaitReadiness: null,
      readinessLabel: "กำลังสร้าง baseline",
    } satisfies Pick<BiofeedbackMetrics, "gaitReadiness" | "readinessLabel">;
  }

  const cadenceStabilityScore = scoreDistance(cadenceSpm, baseline.cadenceMedian, 28);
  const dutyScore = dutyFactorPercent
    ? scoreDistance(dutyFactorPercent, baseline.dutyFactorMedian, 28)
    : 55;
  const fatigueScore = fatigueSlope === null ? 65 : clamp(100 - fatigueSlope * 160, 0, 100);
  const readiness = clamp(
    rhythmScore * 0.3 +
      cadenceStabilityScore * 0.2 +
      (symmetryRatio ?? 0.75) * 100 * 0.2 +
      loadControlPercent * 0.15 +
      mean([dutyScore, fatigueScore]) * 0.15,
    0,
    100,
  );

  return {
    gaitReadiness: readiness,
    readinessLabel:
      readiness >= 67 ? "พร้อมเดิน" : readiness >= 34 ? "เดินแบบระวัง" : "พักก่อน",
  } satisfies Pick<BiofeedbackMetrics, "gaitReadiness" | "readinessLabel">;
}

function calculateMobilityStrain({
  activationScore,
  cycleTimesMs,
  durationMs,
  loadPercent,
  rhythmScore,
}: {
  activationScore: number;
  cycleTimesMs: number[];
  durationMs: number;
  loadPercent: number;
  rhythmScore: number | null;
}) {
  const walkingMinutes = Math.max(0, durationMs / 60_000);
  const highLoadMinutes = walkingMinutes * clamp((loadPercent - 60) / 80, 0, 1);
  const asymmetryMinutes = walkingMinutes * clamp((80 - (rhythmScore ?? 80)) / 45, 0, 1);
  const highMotionMinutes = walkingMinutes * clamp((activationScore - 1.8) / 1.2, 0, 1);
  const irregularStepCount = cycleTimesMs.filter((cycleTimeMs) => {
    const cycleMedian = median(cycleTimesMs);

    return cycleMedian > 0 && Math.abs(cycleTimeMs - cycleMedian) > cycleMedian * 0.18;
  }).length;
  const rawLoad =
    walkingMinutes +
    highLoadMinutes * 1.8 +
    asymmetryMinutes * 1.5 +
    highMotionMinutes * 1.3 +
    irregularStepCount * 0.08;

  return clamp((21 * Math.log1p(rawLoad)) / Math.log1p(50), 0, 21);
}

function calculateFatigueSlope(
  samples: PreparedSample[],
  rhythmScore: number | null,
  loadPercent: number,
  activationScore: number,
  rhythmBaseline: number,
) {
  if (samples.length < 90) {
    return {
      fatigueLabel: "กำลังอ่าน",
      fatigueSlope: null,
    } satisfies Pick<BiofeedbackMetrics, "fatigueLabel" | "fatigueSlope">;
  }

  const third = Math.floor(samples.length / 3);
  const firstThird = samples.slice(0, third);
  const lastThird = samples.slice(-third);
  const firstMotion = mean(firstThird.map((sample) => sample.gyroMagnitudeDps));
  const lastMotion = mean(lastThird.map((sample) => sample.gyroMagnitudeDps));
  const motionIncrease = firstMotion > 0 ? (lastMotion - firstMotion) / firstMotion : 0;
  const rhythmDrop =
    rhythmScore === null ? 0 : clamp((rhythmBaseline - rhythmScore) / 45, 0, 1);
  const loadIncrease = clamp((loadPercent - 70) / 80, 0, 1);
  const activationIncrease = clamp((activationScore - 2) / 1, 0, 1);
  const fatigueSlope = clamp(
    motionIncrease * 0.25 + rhythmDrop * 0.25 + loadIncrease * 0.2 + activationIncrease * 0.2,
    0,
    1,
  );

  return {
    fatigueLabel:
      fatigueSlope > 0.66 ? "ควรพัก" : fatigueSlope > 0.34 ? "เริ่มล้า" : "ยังคงที่",
    fatigueSlope,
  } satisfies Pick<BiofeedbackMetrics, "fatigueLabel" | "fatigueSlope">;
}

function getRecommendation(metrics: Omit<BiofeedbackMetrics, "recommendation">) {
  if (metrics.confidence < 0.45) {
    return "กำลังเก็บข้อมูล เดินต่ออีกเล็กน้อย";
  }

  if (metrics.loadControlLabel === "กดมากไป") {
    return "ลดแรงกดที่ด้ามจับ";
  }

  if (metrics.rhythmScore !== null && metrics.rhythmScore < 72) {
    return "ชะลอและรักษาจังหวะให้เท่ากัน";
  }

  if (metrics.fatigueLabel === "ควรพัก") {
    return "พัก 1 นาที ก่อนเดินต่อ";
  }

  if (metrics.readinessLabel === "พักก่อน") {
    return "วันนี้ใช้รอบสั้นและตรวจอุปกรณ์ก่อนเดิน";
  }

  return "คงจังหวะนี้ไว้";
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
    config.baselinePressureDeltaPa ??
    config.baseline?.baselinePressureDeltaPa ??
    DEFAULT_BASELINE_PRESSURE_DELTA_PA;
  const targetLoadPercent = config.targetLoadPercent ?? 60;
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
  const pressureDeltaPa = calculatePressureDeltaPa(preparedSamples, pressureTarePa);
  const loadPercent =
    baselinePressureDeltaPa > 0
      ? clamp((pressureDeltaPa / baselinePressureDeltaPa) * 100, 0, 200)
      : 0;
  const { loadControlLabel, loadControlPercent } = calculateLoadControl(
    loadPercent,
    targetLoadPercent,
  );
  const durationMs =
    latestSample && firstSample ? latestSample.timestamp_ms - firstSample.timestamp_ms : 0;
  const activationScore = calculateActivationScore(
    latestSample,
    cycleTimesMs,
    loadPercent,
    config.baseline,
  );
  const activationLabel = getActivationLabel(activationScore);
  const { fatigueLabel, fatigueSlope } = calculateFatigueSlope(
    preparedSamples,
    rhythmScore,
    loadPercent,
    activationScore,
    config.baseline?.rhythmMedian ?? 82,
  );
  const { gaitReadiness, readinessLabel } = calculateGaitReadiness({
    baseline: config.baseline,
    cadenceSpm,
    dutyFactorPercent,
    fatigueSlope,
    loadControlPercent,
    rhythmScore,
    symmetryRatio,
  });
  const mobilityStrain = calculateMobilityStrain({
    activationScore,
    cycleTimesMs,
    durationMs,
    loadPercent,
    rhythmScore,
  });
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
    loadControlPercent,
    loadControlLabel,
    activationScore,
    activationLabel,
    gaitReadiness,
    readinessLabel,
    mobilityStrain,
    fatigueSlope,
    fatigueLabel,
    confidence,
  };

  const action = getAction(metricsWithoutAction);

  return {
    ...metricsWithoutAction,
    action,
    recommendation: getRecommendation({
      ...metricsWithoutAction,
      action,
    }),
  };
}

export function summarizeBiofeedbackSession({
  baseline,
  deviceType,
  endedAt = new Date().toISOString(),
  id,
  samples,
  startedAt,
}: {
  baseline?: BiofeedbackBaseline;
  deviceType: string;
  endedAt?: string;
  id?: string;
  samples: NanoImuSample[];
  startedAt?: string;
}): BiofeedbackSessionSummary {
  const metrics = calculateBiofeedbackMetrics(samples, { baseline });
  const firstTimestamp = samples.at(0)?.timestamp_ms ?? 0;
  const lastTimestamp = samples.at(-1)?.timestamp_ms ?? firstTimestamp;

  return {
    id: id ?? `${deviceType}-${firstTimestamp}-${lastTimestamp}`,
    startedAt: startedAt ?? endedAt,
    endedAt,
    deviceType,
    sampleCount: metrics.sampleCount,
    stepCount: metrics.plants.length,
    readinessScore: metrics.gaitReadiness,
    mobilityStrain: metrics.mobilityStrain,
    rhythmScore: metrics.rhythmScore,
    symmetryRatio: metrics.symmetryRatio,
    dutyFactorPercent: metrics.dutyFactorPercent,
    cadenceSpm: metrics.cadenceSpm,
    loadInTargetPercent: metrics.loadControlPercent,
    fatigueSlope: metrics.fatigueSlope,
    dominantAction: metrics.action,
  };
}

export function updateBiofeedbackBaseline(
  sessions: BiofeedbackSessionSummary[],
): BiofeedbackBaseline | null {
  const usableSessions = sessions
    .filter((session) => session.sampleCount > 50)
    .slice(-7);

  if (usableSessions.length < 3) {
    return null;
  }

  const activationProxy = usableSessions.map((session) => {
    return (
      session.mobilityStrain / 7 +
      (100 - session.loadInTargetPercent) / 90 +
      (session.fatigueSlope ?? 0)
    );
  });
  const activationMedian = median(activationProxy);
  const activationMad = median(
    activationProxy.map((value) => Math.abs(value - activationMedian)),
  );

  return {
    sessionCount: usableSessions.length,
    cadenceMedian: median(
      usableSessions
        .map((session) => session.cadenceSpm)
        .filter((value): value is number => value !== null),
    ),
    rhythmMedian: median(
      usableSessions
        .map((session) => session.rhythmScore)
        .filter((value): value is number => value !== null),
    ),
    dutyFactorMedian: median(
      usableSessions
        .map((session) => session.dutyFactorPercent)
        .filter((value): value is number => value !== null),
    ),
    baselinePressureDeltaPa: Math.max(
      DEFAULT_BASELINE_PRESSURE_DELTA_PA,
      median(usableSessions.map((session) => 100 - session.loadInTargetPercent)) * 100,
    ),
    activationMedian,
    activationMad,
  };
}
