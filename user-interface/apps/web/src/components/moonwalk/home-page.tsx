import { Check, ChevronRight, History, Sparkles, Zap } from "lucide-react";

import {
  devices,
  type DeviceId,
  historyItems,
  recommendations,
} from "@/components/moonwalk-data";
import { GridPanel, MiniStatus } from "@/components/moonwalk/panel";
import type { BiofeedbackMetrics } from "@/lib/biofeedback-metrics";

export function HomePage({
  selectedDevice,
  isBluetoothConnected,
  metrics,
}: {
  selectedDevice: DeviceId;
  isBluetoothConnected: boolean;
  metrics: BiofeedbackMetrics;
}) {
  const deviceLabel =
    devices.find((device) => device.id === selectedDevice)?.label ?? "ไม้เท้า";
  const dutyValue =
    metrics.dutyFactorPercent === null
      ? "--"
      : String(Math.round(metrics.dutyFactorPercent));
  const rhythmValue =
    metrics.rhythmScore === null
      ? isBluetoothConnected
        ? "--"
        : "86"
      : String(Math.round(metrics.rhythmScore));
  const wsTrainingLoadValue =
    metrics.sessionWeightSupportTrainingLoad === null
      ? "--"
      : String(Math.round(metrics.sessionWeightSupportTrainingLoad));
  const targetComplianceValue =
    metrics.targetCompliancePercent === null
      ? "--"
      : `${Math.round(metrics.targetCompliancePercent)}%`;
  const trainingTone =
    metrics.sessionWeightSupportTrainingLoad === null
      ? "neutral"
      : metrics.sessionWeightSupportTrainingLoad >= 55
        ? "green"
        : "amber";

  return (
    <div className="grid gap-2">
      <GridPanel className="border-moonwalk-navy bg-moonwalk-navy text-moonwalk-white dark:border-moonwalk-white">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-xs text-moonwalk-silver">Moon Walk</p>
            <h1 className="mt-2 text-[22px] font-bold leading-[0.95] tracking-normal min-[390px]:text-[24px]">
              สวัสดีคุณ เอ้อ
            </h1>
          </div>
          <div className="grid size-9 shrink-0 place-items-center border border-moonwalk-teal">
            <Check className="size-5" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="border border-moonwalk-white/30 p-2">
            <p className="text-[10px] text-moonwalk-silver">Rhythm</p>
            <p className="mt-1 text-lg font-bold">{rhythmValue}</p>
            <p className="mt-1 truncate text-[10px] text-moonwalk-silver">
              limp meter
            </p>
          </div>
          <div className="border border-moonwalk-white/30 p-2">
            <p className="text-[10px] text-moonwalk-silver">Duty</p>
            <p className="mt-1 text-lg font-bold">{dutyValue}</p>
            <p className="mt-1 truncate text-[10px] text-moonwalk-silver">
              planted %
            </p>
          </div>
          <div className="border border-moonwalk-white/30 p-2">
            <p className="text-[10px] text-moonwalk-silver">WS load</p>
            <p className="mt-1 text-lg font-bold">{wsTrainingLoadValue}</p>
            <p className="mt-1 truncate text-[10px] text-moonwalk-silver">
              {targetComplianceValue}
            </p>
          </div>
        </div>
      </GridPanel>

      <div className="grid grid-cols-2 gap-2">
        <MiniStatus
          label="Bluetooth"
          value={isBluetoothConnected ? "เชื่อมต่อ" : "ยังไม่เชื่อมต่อ"}
          tone={isBluetoothConnected ? "green" : "neutral"}
        />
        <MiniStatus label="อุปกรณ์" value={deviceLabel} tone="green" />
        <MiniStatus
          label="WS training"
          value={wsTrainingLoadValue}
          tone={trainingTone}
        />
      </div>

      <GridPanel className="p-0">
        <div className="grid grid-cols-[1fr_auto] items-center border-b border-moonwalk-silver p-2 dark:border-moonwalk-slate">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-moonwalk-teal" aria-hidden="true" />
            <h2 className="text-base font-bold leading-none">Today coaching</h2>
          </div>
          <span className="text-[10px] font-bold uppercase text-moonwalk-slate/70 dark:text-moonwalk-white/60">
            live
          </span>
        </div>
        <div className="grid grid-cols-3 text-center">
          <div className="border-r border-moonwalk-silver p-2 dark:border-moonwalk-slate">
            <p className="text-[10px] text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              Rhythm
            </p>
            <p className="mt-1 text-base font-bold">{rhythmValue}</p>
          </div>
          <div className="border-r border-moonwalk-silver p-2 dark:border-moonwalk-slate">
            <p className="text-[10px] text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              Duty
            </p>
            <p className="mt-1 text-base font-bold">{dutyValue}</p>
          </div>
          <div className="p-2">
            <p className="text-[10px] text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              WS load
            </p>
            <p className="mt-1 text-base font-bold">{wsTrainingLoadValue}</p>
          </div>
        </div>
      </GridPanel>

      <GridPanel>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="size-5" aria-hidden="true" />
            <h2 className="text-lg font-bold leading-none">ประวัติ</h2>
          </div>
          <span className="text-xs text-moonwalk-slate/70">3 รายการ</span>
        </div>
        <div className="mt-2 divide-y divide-moonwalk-silver border-y border-moonwalk-silver dark:divide-moonwalk-slate dark:border-moonwalk-slate">
          {historyItems.map((item) => (
            <div
              key={`${item.date}-${item.duration}`}
              className="grid gap-0.5 py-2 min-[430px]:grid-cols-[1fr_auto] min-[430px]:gap-3"
            >
              <div>
                <p className="text-sm font-bold leading-none">{item.date}</p>
                <p className="text-xs text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                  {item.equipment} / {item.duration}
                </p>
              </div>
              <p className="self-center text-xs text-moonwalk-slate dark:text-moonwalk-silver min-[430px]:text-right">
                {item.rhythm}
              </p>
            </div>
          ))}
        </div>
      </GridPanel>

      <GridPanel>
        <div className="flex items-center gap-2">
          <Sparkles className="size-5" aria-hidden="true" />
          <h2 className="text-lg font-bold leading-none">คำแนะนำ</h2>
        </div>
        <div className="mt-2 grid gap-2">
          {[metrics.recommendation, ...recommendations.slice(0, 2)].map(
            (item) => (
              <div
                key={item}
                className="grid min-h-11 grid-cols-[1fr_auto] items-center gap-2 border border-moonwalk-silver p-2 dark:border-moonwalk-slate"
              >
                <p className="text-sm leading-5">{item}</p>
                <ChevronRight
                  className="size-5 text-moonwalk-slate"
                  aria-hidden="true"
                />
              </div>
            ),
          )}
        </div>
      </GridPanel>
    </div>
  );
}
