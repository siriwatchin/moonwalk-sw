"use client";

import {
  Activity,
  Brain,
  ChevronRight,
  Footprints,
  Gauge,
  ShieldCheck,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";

import { devices, type DeviceId } from "@/components/moonwalk-data";
import { GridPanel } from "@/components/moonwalk/panel";
import { UsageMeter } from "@/components/moonwalk/usage-meter";
import type { BiofeedbackMetrics } from "@/lib/biofeedback-metrics";
import { formatSessionTime } from "@/lib/format";

export function BiofeedbackPage({
  metrics,
  selectedDevice,
  isBluetoothConnected,
}: {
  metrics: BiofeedbackMetrics;
  selectedDevice: DeviceId;
  isBluetoothConnected: boolean;
}) {
  const deviceLabel =
    devices.find((device) => device.id === selectedDevice)?.label ?? "ไม้เท้า";
  const [elapsedSeconds, setElapsedSeconds] = useState(522);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const liveCadence = isBluetoothConnected ? null : 82 + (elapsedSeconds % 5) - 2;
  const liveRhythm = isBluetoothConnected ? null : 86 + (elapsedSeconds % 3);
  const liveDuty = isBluetoothConnected ? null : 41 + (elapsedSeconds % 4);
  const cadenceValue =
    metrics.cadenceSpm === null
      ? liveCadence === null
        ? "--"
        : String(liveCadence)
      : String(Math.round(metrics.cadenceSpm));
  const rhythmValue =
    metrics.rhythmScore === null
      ? liveRhythm === null
        ? "--"
        : String(liveRhythm)
      : String(Math.round(metrics.rhythmScore));
  const dutyValue =
    metrics.dutyFactorPercent === null
      ? liveDuty === null
        ? "--"
        : String(liveDuty)
      : String(Math.round(metrics.dutyFactorPercent));
  const readinessValue =
    metrics.gaitReadiness === null ? "--" : String(Math.round(metrics.gaitReadiness));
  const activationValue = metrics.activationScore.toFixed(1);
  const strainValue = metrics.mobilityStrain.toFixed(1);
  const loadValue = Math.round(metrics.loadControlPercent);
  const confidenceValue = Math.round(metrics.confidence * 100);
  const dataQualityValue =
    metrics.sampleCount > 0 ? confidenceValue : isBluetoothConnected ? 0 : 94;
  const qualityLabel =
    metrics.sampleCount === 0
      ? isBluetoothConnected
        ? "รอสัญญาณ"
        : "ดี"
      : confidenceValue >= 70
        ? "ดี"
        : "กำลังอ่าน";
  const timeProgress = Math.min(96, Math.round((elapsedSeconds / 720) * 100));
  const coachCards = [
    {
      label: "Readiness",
      value: readinessValue,
      unit: metrics.readinessLabel,
      icon: ShieldCheck,
    },
    {
      label: "Activation",
      value: activationValue,
      unit: metrics.activationLabel,
      icon: Gauge,
    },
    {
      label: "Load",
      value: String(loadValue),
      unit: metrics.loadControlLabel,
      icon: Activity,
    },
    {
      label: "Strain",
      value: strainValue,
      unit: "/21",
      icon: Brain,
    },
  ];
  const liveFeedbackCards = [
    {
      label: "Cadence",
      value: cadenceValue,
      unit: "รอบ/นาที",
      icon: Footprints,
    },
    {
      label: "Rhythm",
      value: rhythmValue,
      unit: "/100",
      icon: Waves,
    },
    {
      label: "Duty factor",
      value: dutyValue,
      unit: "%",
      icon: Activity,
    },
    {
      label: "Action",
      value: metrics.action,
      unit: metrics.fatigueLabel,
      icon: Brain,
    },
  ];

  return (
    <div className="grid gap-2">
      <GridPanel className="border-moonwalk-navy p-2">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              Live walking state
            </p>
            <h1 className="mt-1 text-xl font-bold leading-none">
              {metrics.activationLabel}
            </h1>
          </div>
          <div className="grid size-9 shrink-0 place-items-center border border-moonwalk-teal text-moonwalk-teal">
            <Activity className="size-5" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 border border-moonwalk-silver dark:border-moonwalk-slate">
          <div className="border-r border-moonwalk-silver p-2 dark:border-moonwalk-slate">
            <p className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              เวลา
            </p>
            <p className="mt-1 text-lg font-bold leading-none">
              {formatSessionTime(elapsedSeconds)}
            </p>
          </div>
          <div className="border-r border-moonwalk-silver p-2 dark:border-moonwalk-slate">
            <p className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              อุปกรณ์
            </p>
            <p className="mt-1 truncate text-lg font-bold leading-none">
              {deviceLabel}
            </p>
          </div>
          <div className="p-2">
            <p className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              คุณภาพ
            </p>
            <p className="mt-1 text-lg font-bold leading-none text-moonwalk-teal">
              {qualityLabel}
            </p>
          </div>
        </div>
      </GridPanel>

      <GridPanel className="bg-moonwalk-navy p-2 text-moonwalk-white dark:border-moonwalk-white">
        <p className="text-xs text-moonwalk-silver">Biofeedback now</p>
        <h2 className="mt-1 text-xl font-bold leading-none">
          {metrics.recommendation}
        </h2>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-moonwalk-silver">
          {metrics.sampleCount > 0
            ? `อ่าน ${metrics.sampleCount} ตัวอย่าง / readiness ${readinessValue} / strain ${strainValue}`
            : isBluetoothConnected
              ? "เชื่อมต่อแล้ว กำลังรอ frame IMU จากอุปกรณ์"
              : "โหมดสาธิตจะแสดงค่าจำลองจนกว่าจะเชื่อมต่อ Bluetooth"}
        </p>
      </GridPanel>

      <div className="grid grid-cols-2 gap-2">
        {coachCards.map(({ label, value, unit, icon: Icon }) => (
          <GridPanel key={label} className="p-2">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                {label}
              </p>
              <Icon className="size-4 shrink-0 text-moonwalk-teal" aria-hidden="true" />
            </div>
            <div className="mt-2 grid grid-cols-[auto_1fr] items-end gap-1">
              <p className="text-xl font-bold leading-none">{value}</p>
              <p className="truncate pb-0.5 text-[10px] font-bold text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                {unit}
              </p>
            </div>
          </GridPanel>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {liveFeedbackCards.map(({ label, value, unit, icon: Icon }) => (
          <GridPanel key={label} className="p-2">
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                {label}
              </p>
              <Icon
                className="size-4 shrink-0 text-moonwalk-slate dark:text-moonwalk-silver"
                aria-hidden="true"
              />
            </div>
            <div className="mt-2 flex items-end gap-1">
              <p className="truncate text-xl font-bold leading-none">
                {value}
              </p>
              <p className="pb-0.5 text-xs font-bold text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                {unit}
              </p>
            </div>
          </GridPanel>
        ))}
      </div>

      <GridPanel className="p-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold leading-none">Current usage</h2>
          <span className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
            live
          </span>
        </div>
        <div className="mt-2 grid gap-2">
          <UsageMeter
            label="เป้าหมายเวลาเดิน"
            value={timeProgress}
            helper={`ทำไปแล้ว ${formatSessionTime(elapsedSeconds)} จากเป้าหมาย 12 นาที`}
          />
          <UsageMeter
            label="ความสม่ำเสมอของจังหวะ"
            value={metrics.rhythmScore === null ? 0 : Math.round(metrics.rhythmScore)}
            helper={
              metrics.rhythmScore === null
                ? "ต้องตรวจพบ plant อย่างน้อย 4 รอบ"
                : "คะแนนนี้เทียบกับ baseline ส่วนตัว"
            }
          />
          <UsageMeter
            label="ควบคุมน้ำหนัก"
            value={loadValue}
            helper={metrics.loadControlLabel}
          />
          <UsageMeter
            label="ความพร้อมข้อมูล"
            value={dataQualityValue}
            helper={`${metrics.sampleCount} samples / axis ${metrics.swingAxis.toUpperCase()}`}
          />
        </div>
      </GridPanel>

      <GridPanel className="p-2">
        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <div>
            <p className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              คำแนะนำถัดไป
            </p>
            <p className="truncate text-base font-bold leading-none">
              {metrics.recommendation}
            </p>
          </div>
          <ChevronRight
            className="size-5 text-moonwalk-slate dark:text-moonwalk-silver"
            aria-hidden="true"
          />
        </div>
      </GridPanel>
    </div>
  );
}
