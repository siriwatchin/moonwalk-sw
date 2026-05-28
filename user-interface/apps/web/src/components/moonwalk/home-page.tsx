import { Check, ChevronRight, History, Sparkles } from "lucide-react";

import {
  devices,
  type DeviceId,
  historyItems,
  recommendations,
} from "@/components/moonwalk-data";
import { GridPanel, MiniStatus } from "@/components/moonwalk/panel";

export function HomePage({
  selectedDevice,
  isBluetoothConnected,
}: {
  selectedDevice: DeviceId;
  isBluetoothConnected: boolean;
}) {
  const deviceLabel =
    devices.find((device) => device.id === selectedDevice)?.label ?? "ไม้เท้า";

  return (
    <div className="grid gap-2">
      <GridPanel className="border-moonwalk-navy bg-moonwalk-navy text-moonwalk-white dark:border-moonwalk-white">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-xs text-moonwalk-silver">Moon Walk</p>
            <h1 className="mt-2 text-[22px] font-bold leading-[0.95] tracking-normal min-[390px]:text-[24px]">
              สวัสดีคุณ สมชาย
            </h1>
          </div>
          <div className="grid size-9 shrink-0 place-items-center border border-moonwalk-teal">
            <Check className="size-5" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="border border-moonwalk-white/30 p-2">
            <p className="text-xs text-moonwalk-silver">อุปกรณ์</p>
            <p className="mt-1 text-lg font-bold">{deviceLabel}</p>
          </div>
          <div className="border border-moonwalk-white/30 p-2">
            <p className="text-xs text-moonwalk-silver">เซสชันล่าสุด</p>
            <p className="mt-1 text-lg font-bold">18 นาที</p>
          </div>
        </div>
      </GridPanel>

      <div className="grid grid-cols-2 gap-3">
        <MiniStatus
          label="Bluetooth"
          value={isBluetoothConnected ? "เชื่อมต่อ" : "ยังไม่เชื่อมต่อ"}
          tone={isBluetoothConnected ? "green" : "neutral"}
        />
        <MiniStatus label="Calibration" value="พร้อมใช้" tone="green" />
      </div>

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
          {recommendations.map((item) => (
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
          ))}
        </div>
      </GridPanel>
    </div>
  );
}
