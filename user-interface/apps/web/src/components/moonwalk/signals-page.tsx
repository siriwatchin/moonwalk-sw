import { RadioTower, Waves } from "lucide-react";

import { liveSignals } from "@/components/moonwalk-data";
import { GridPanel, MiniStatus } from "@/components/moonwalk/panel";

function SignalBars({ bars }: { bars: number[] }) {
  return (
    <div className="flex h-12 items-end gap-1 border-t border-moonwalk-silver pt-2 dark:border-moonwalk-slate min-[430px]:h-14">
      {bars.map((height, index) => (
        <div
          key={`${height}-${index}`}
          className="w-full bg-moonwalk-teal"
          style={{ height: `${height}%` }}
        />
      ))}
    </div>
  );
}

export function SignalsPage() {
  return (
    <div className="grid gap-2">
      <GridPanel className="border-moonwalk-navy dark:border-moonwalk-white">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">
              Live Signal Dashboard
            </p>
            <h1 className="mt-1 text-2xl font-bold leading-none">
              สัญญาณสดจากโมดูล
            </h1>
          </div>
          <RadioTower className="size-6 shrink-0" aria-hidden="true" />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <MiniStatus label="Rate" value="20Hz" tone="green" />
          <MiniStatus label="Lost" value="0.4%" tone="amber" />
          <MiniStatus label="Slot" value="A" />
        </div>
      </GridPanel>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {liveSignals.map((signal) => (
          <GridPanel key={signal.label}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm uppercase text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                  {signal.label}
                </p>
                <p className="mt-1 text-xl font-bold leading-none min-[430px]:text-2xl">
                  {signal.value}
                </p>
              </div>
              <p className="border border-moonwalk-silver px-1.5 py-0.5 text-xs dark:border-moonwalk-slate">
                {signal.unit}
              </p>
            </div>
            <div className="mt-4">
              <SignalBars bars={signal.bars} />
            </div>
          </GridPanel>
        ))}
      </div>

      <GridPanel>
        <div className="grid grid-cols-[auto_1fr] gap-3">
          <Waves className="mt-1 size-5" aria-hidden="true" />
          <div>
            <h2 className="text-xl font-bold leading-none">Raw stream</h2>
            <p className="mt-1 text-sm leading-5 text-moonwalk-slate dark:text-moonwalk-silver">
              หน้านี้แสดงสัญญาณสดสำหรับตรวจสอบระบบ
              ไม่ใช้เป็นคำวินิจฉัยหรือการจัดระดับผู้ใช้
            </p>
          </div>
        </div>
      </GridPanel>
    </div>
  );
}
