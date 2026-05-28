"use client";

import {
  Activity,
  ChevronRight,
  ShieldCheck,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";

import { GridPanel } from "@/components/moonwalk/panel";
import { UsageMeter } from "@/components/moonwalk/usage-meter";
import type { BiofeedbackMetrics } from "@/lib/biofeedback-metrics";

export function BiofeedbackPage({
  metrics,
  isBluetoothConnected,
}: {
  metrics: BiofeedbackMetrics;
  isBluetoothConnected: boolean;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(522);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const liveRhythm = isBluetoothConnected ? null : 86 + (elapsedSeconds % 3);
  const liveDuty = isBluetoothConnected ? null : 41 + (elapsedSeconds % 4);
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
  const wsTrainingLoadValue =
    metrics.sessionWeightSupportTrainingLoad === null
      ? "--"
      : String(Math.round(metrics.sessionWeightSupportTrainingLoad));
  const targetComplianceValue =
    metrics.targetCompliancePercent === null
      ? "--"
      : `${Math.round(metrics.targetCompliancePercent)}%`;
  const headlineCards = [
    {
      label: "เวลาลงไม้เท้า",
      value: dutyValue,
      unit: "%",
      icon: Activity,
    },
    {
      label: "จังหวะสมดุล",
      value: rhythmValue,
      unit: "/100",
      icon: Waves,
    },
    {
      label: "ฝึกลงน้ำหนัก",
      value: wsTrainingLoadValue,
      unit: targetComplianceValue,
      icon: ShieldCheck,
    },
  ];

  if (isBluetoothConnected && metrics.isIdle) {
    return (
      <div className="grid gap-2">
        <GridPanel className="min-h-64 border-moonwalk-navy bg-moonwalk-navy p-4 text-moonwalk-white dark:border-moonwalk-white">
          <div className="grid h-full min-h-56 content-center text-center">
            <p className="text-xs font-bold uppercase text-moonwalk-silver">
              Live walking state
            </p>
            <h1 className="mt-3 text-4xl font-bold leading-none">Idle</h1>
            <p className="mx-auto mt-3 max-w-64 text-sm leading-5 text-moonwalk-silver">
              ยังไม่พบการถือหรือใช้งานอุปกรณ์ เริ่มถือไม้เท้าและเดินเพื่อเปิดการคำนวณ
            </p>
          </div>
        </GridPanel>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <GridPanel className="bg-moonwalk-navy p-2 text-moonwalk-white dark:border-moonwalk-white">
        <p className="text-xs text-moonwalk-silver">ฟีดแบ็กตอนนี้</p>
        <h2 className="mt-1 text-xl font-bold leading-none">
          {metrics.recommendation}
        </h2>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-moonwalk-silver">
          {metrics.sampleCount > 0
            ? `อ่าน ${metrics.sampleCount} ตัวอย่าง / ลงไม้เท้า ${dutyValue}% / จังหวะ ${rhythmValue} / ฝึกน้ำหนัก ${wsTrainingLoadValue}`
            : isBluetoothConnected
              ? "เชื่อมต่อแล้ว กำลังรอ frame IMU จากอุปกรณ์"
              : "โหมดสาธิตจะแสดงค่าจำลองจนกว่าจะเชื่อมต่อ Bluetooth"}
        </p>
      </GridPanel>

      <div className="grid grid-cols-3 gap-2">
        {headlineCards.map(({ label, value, unit, icon: Icon }) => (
          <GridPanel key={label} className="p-2">
            <div className="flex items-center justify-between gap-1">
              <p className="truncate text-[10px] font-bold text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                {label}
              </p>
              <Icon className="size-3.5 shrink-0 text-moonwalk-teal" aria-hidden="true" />
            </div>
            <p className="mt-2 truncate text-xl font-bold leading-none">{value}</p>
            <p className="mt-1 truncate text-[10px] font-bold text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              {unit}
            </p>
          </GridPanel>
        ))}
      </div>

      <GridPanel className="p-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold leading-none">ตัวชี้วัดหลัก</h2>
          <span className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
            live
          </span>
        </div>
        <div className="mt-2 grid gap-2">
          <UsageMeter
            label="จังหวะสมดุล"
            value={metrics.rhythmScore === null ? 0 : Math.round(metrics.rhythmScore)}
            helper={
              metrics.rhythmScore === null
                ? "ต้องตรวจพบ plant อย่างน้อย 4 รอบ"
                : "ความสม่ำเสมอของรอบก้าวเทียบกับ baseline ส่วนตัว"
            }
          />
          <UsageMeter
            label="เวลาลงไม้เท้า"
            value={metrics.dutyFactorPercent === null ? 0 : Math.round(metrics.dutyFactorPercent)}
            helper={
              metrics.dutyFactorPercent === null
                ? "ต้องตรวจพบช่วงที่ไม้เท้าวางนิ่ง"
                : "สัดส่วนเวลาที่ไม้เท้าวางรับน้ำหนักในแต่ละรอบ"
            }
          />
          <UsageMeter
            label="ฝึกลงน้ำหนัก"
            value={
              metrics.sessionWeightSupportTrainingLoad === null
                ? 0
                : Math.round(metrics.sessionWeightSupportTrainingLoad)
            }
            helper={
              metrics.sessionWeightSupportTrainingLoad === null
                ? "ต้องตรวจพบแรงกดสูงสุดรายรอบก้าว"
                : `อยู่ในเป้าหมาย ${targetComplianceValue}`
            }
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
