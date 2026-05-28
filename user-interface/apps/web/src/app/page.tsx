"use client";

import {
  Activity,
  BarChart3,
  Bluetooth,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Footprints,
  History,
  Home,
  Plus,
  RadioTower,
  Sparkles,
  TrendingUp,
  Waves,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@user-interface/ui/lib/utils";

type PageId = "home" | "biofeedback" | "signals";
type DeviceId = "cane" | "walker";

const pages = [
  { id: "home", label: "หน้าหลัก", icon: Home },
  { id: "biofeedback", label: "ฟีดแบ็ก", icon: Brain },
  { id: "signals", label: "สัญญาณสด", icon: BarChart3 },
] satisfies Array<{ id: PageId; label: string; icon: typeof Home }>;

const devices = [
  {
    id: "cane",
    label: "ไม้เท้า",
    description: "โมดูลติดตั้งกับไม้เท้าเดี่ยว สำหรับติดตามจังหวะการเดิน",
    icon: Footprints,
  },
  {
    id: "walker",
    label: "Walker",
    description: "โมดูลติดตั้งกับ walker หรือ rollator สำหรับติดตามการเคลื่อนที่",
    icon: Activity,
  },
] satisfies Array<{ id: DeviceId; label: string; description: string; icon: typeof Activity }>;

const historyItems = [
  { date: "วันนี้", equipment: "ไม้เท้า", duration: "18 นาที", rhythm: "+6 จากฐานของคุณ" },
  { date: "เมื่อวาน", equipment: "walker", duration: "14 นาที", rhythm: "+3 จากฐานของคุณ" },
  { date: "จันทร์", equipment: "ไม้เท้า", duration: "12 นาที", rhythm: "เริ่มต้นฐาน" },
];

const recommendations = [
  "เริ่มเดินรอบสั้น 5 นาที ก่อนเพิ่มเวลา",
  "ตรวจว่าโมดูลติดแน่นก่อนเริ่มทุกครั้ง",
  "วันนี้จังหวะคงที่ขึ้น ให้รักษาความเร็วที่รู้สึกสบาย",
];

const feedbackCards = [
  { label: "Cadence", value: "82", unit: "รอบ/นาที", helper: "อยู่ในช่วงฝึกที่ดี", icon: Footprints },
  { label: "Rhythm", value: "86", unit: "/100", helper: "สม่ำเสมอกว่า baseline", icon: Waves },
  { label: "Duty factor", value: "41", unit: "%", helper: "เวลาที่อุปกรณ์สัมผัสพื้น", icon: Activity },
  { label: "ML state", value: "เดินต่อเนื่อง", unit: "92%", helper: "คาดการณ์จากรูปแบบการเคลื่อนไหว", icon: Brain },
];

const liveSignals = [
  { label: "ax", value: "0.18", unit: "g", bars: [20, 44, 38, 62, 55, 71, 48, 59, 77, 51, 69, 83] },
  { label: "ay", value: "-0.04", unit: "g", bars: [31, 28, 46, 42, 64, 58, 49, 66, 53, 61, 45, 39] },
  { label: "az", value: "0.96", unit: "g", bars: [72, 69, 76, 71, 80, 74, 78, 73, 79, 75, 82, 77] },
  { label: "gx", value: "12.4", unit: "dps", bars: [35, 52, 41, 67, 74, 63, 58, 81, 73, 66, 84, 70] },
  { label: "gy", value: "-8.7", unit: "dps", bars: [62, 56, 49, 44, 51, 39, 46, 58, 42, 37, 53, 48] },
  { label: "gz", value: "3.1", unit: "dps", bars: [18, 24, 33, 28, 39, 44, 36, 31, 47, 52, 43, 40] },
];

function GridPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "border border-moonwalk-silver bg-moonwalk-white p-3 text-moonwalk-navy dark:border-moonwalk-slate dark:bg-moonwalk-navy dark:text-moonwalk-white sm:p-4",
        className,
      )}
    >
      {children}
    </section>
  );
}

function MiniStatus({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "green" | "amber" | "neutral";
}) {
  return (
    <div className="min-w-0 border border-moonwalk-silver p-3 dark:border-moonwalk-slate">
      <p className="text-[13px] leading-5 text-moonwalk-slate/70 dark:text-moonwalk-white/65">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <Circle
          className={cn(
            "size-2 fill-current",
            tone === "green" && "text-moonwalk-teal",
            tone === "amber" && "text-moonwalk-slate",
            tone === "neutral" && "text-moonwalk-silver",
          )}
          aria-hidden="true"
        />
        <p className="min-w-0 text-[22px] font-bold leading-none">{value}</p>
      </div>
    </div>
  );
}

function StickyDeviceBar({
  selectedDevice,
  onDeviceChange,
  isOpen,
  onToggleOpen,
  onAddDevice,
}: {
  selectedDevice: DeviceId;
  onDeviceChange: (device: DeviceId) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
  onAddDevice: () => void;
}) {
  const selected = devices.find((device) => device.id === selectedDevice) ?? devices[0];
  const SelectedIcon = selected.icon;

  return (
    <section className="sticky top-0 z-10 -mx-3 border-y border-moonwalk-navy bg-moonwalk-white text-moonwalk-navy dark:border-moonwalk-white dark:bg-moonwalk-navy dark:text-moonwalk-white md:mx-0 md:border-x">
      <div className="grid grid-cols-[1fr_auto] items-center border-b border-moonwalk-white bg-moonwalk-navy px-3 py-1.5 text-moonwalk-white">
        <div className="flex min-w-0 items-center gap-2">
          <Bluetooth className="size-4 shrink-0 text-moonwalk-teal" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-base font-bold leading-none">Bluetooth connected</p>
          </div>
        </div>
        <div className="border border-moonwalk-white px-2 py-0.5 text-xs font-bold text-moonwalk-white">
          LIVE
        </div>
      </div>

      <button
        type="button"
        className="grid min-h-14 w-full grid-cols-[56px_1fr_auto] items-center gap-3 px-3 py-2 text-left"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
      >
        <div className="grid h-11 w-14 place-items-center border border-moonwalk-silver bg-moonwalk-silver/35 dark:border-moonwalk-white/25 dark:bg-moonwalk-white/10">
          <SelectedIcon className="size-6 text-moonwalk-teal" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold leading-none">{selected.label}</p>
            <p className="mt-1 truncate text-sm leading-5 text-moonwalk-slate/75 dark:text-moonwalk-white/65">
            {selected.description}
          </p>
        </div>
        <ChevronDown className={cn("size-5 transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="border-t border-moonwalk-navy bg-moonwalk-white dark:border-moonwalk-white/25 dark:bg-moonwalk-navy">
          {devices.map((device) => {
            const Icon = device.icon;
            return (
              <button
                key={device.id}
                type="button"
                className={cn(
                  "grid min-h-20 w-full grid-cols-[64px_1fr_auto] items-center gap-3 border-b border-moonwalk-silver px-3 py-2 text-left last:border-b-0 dark:border-moonwalk-white/15",
                  selectedDevice === device.id && "bg-moonwalk-silver/35 dark:bg-moonwalk-white/10",
                )}
                onClick={() => {
                  onDeviceChange(device.id);
                  onToggleOpen();
                }}
              >
                <div className="grid h-16 w-16 place-items-center border border-moonwalk-silver bg-moonwalk-white dark:border-moonwalk-white/20 dark:bg-moonwalk-slate">
                  <div className="grid justify-items-center gap-1">
                    <Icon className="size-6 text-moonwalk-teal" aria-hidden="true" />
                    <span className="text-[10px] font-bold text-moonwalk-slate/70 dark:text-moonwalk-white/65">IMAGE</span>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xl font-bold leading-none">{device.label}</p>
                  <p className="mt-1 text-sm leading-5 text-moonwalk-slate/75 dark:text-moonwalk-white/65">
                    {device.description}
                  </p>
                </div>
                {selectedDevice === device.id ? <Check className="size-5 text-moonwalk-teal" aria-hidden="true" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            className="grid min-h-20 w-full grid-cols-[64px_1fr_auto] items-center gap-3 px-3 py-2 text-left"
            onClick={onAddDevice}
          >
            <div className="grid h-16 w-16 place-items-center border border-moonwalk-teal bg-moonwalk-teal/10">
              <Plus className="size-7 text-moonwalk-teal" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-bold leading-none">เพิ่มอุปกรณ์ของคุณ</p>
              <p className="mt-1 text-sm leading-5 text-moonwalk-slate/75 dark:text-moonwalk-white/65">
                เพิ่มชื่อ ประเภท รูปแบบการติดตั้ง และรายละเอียดโมดูล
              </p>
            </div>
            <ChevronRight className="size-5 text-moonwalk-slate dark:text-moonwalk-white/65" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function HomePage({ selectedDevice }: { selectedDevice: DeviceId }) {
  const deviceLabel = devices.find((device) => device.id === selectedDevice)?.label ?? "ไม้เท้า";

  return (
    <div className="grid gap-3">
      <GridPanel className="border-moonwalk-navy bg-moonwalk-navy text-moonwalk-white dark:border-moonwalk-white">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-[15px] text-moonwalk-silver">Moon Walk</p>
            <h1 className="mt-3 text-[31px] font-bold leading-[0.95] tracking-normal min-[390px]:text-[36px]">
              สวัสดีคุณ สมชาย
            </h1>
          </div>
          <div className="grid size-11 shrink-0 place-items-center border border-moonwalk-teal">
            <Check className="size-6" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-2">
          <div className="border border-moonwalk-white/30 p-3">
            <p className="text-[13px] text-moonwalk-silver">อุปกรณ์</p>
            <p className="mt-2 text-2xl font-bold">{deviceLabel}</p>
          </div>
          <div className="border border-moonwalk-white/30 p-3">
            <p className="text-[13px] text-moonwalk-silver">เซสชันล่าสุด</p>
            <p className="mt-2 text-2xl font-bold">18 นาที</p>
          </div>
        </div>
      </GridPanel>

      <div className="grid grid-cols-2 gap-3">
        <MiniStatus label="Bluetooth" value="เชื่อมต่อ" tone="green" />
        <MiniStatus label="Calibration" value="พร้อมใช้" tone="green" />
      </div>

      <GridPanel>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="size-5" aria-hidden="true" />
            <h2 className="text-2xl font-bold leading-none">ประวัติ</h2>
          </div>
          <span className="text-sm text-moonwalk-slate/70">3 รายการ</span>
        </div>
        <div className="mt-4 divide-y divide-moonwalk-silver border-y border-moonwalk-silver dark:divide-moonwalk-slate dark:border-moonwalk-slate">
          {historyItems.map((item) => (
            <div key={`${item.date}-${item.duration}`} className="grid gap-1 py-3 min-[430px]:grid-cols-[1fr_auto] min-[430px]:gap-3">
              <div>
                <p className="text-lg font-bold">{item.date}</p>
                <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">
                  {item.equipment} / {item.duration}
                </p>
              </div>
              <p className="self-center text-sm text-moonwalk-slate dark:text-moonwalk-silver min-[430px]:text-right">{item.rhythm}</p>
            </div>
          ))}
        </div>
      </GridPanel>

      <GridPanel>
        <div className="flex items-center gap-2">
          <Sparkles className="size-5" aria-hidden="true" />
          <h2 className="text-2xl font-bold leading-none">คำแนะนำ</h2>
        </div>
        <div className="mt-4 grid gap-2">
          {recommendations.map((item) => (
            <div key={item} className="grid min-h-14 grid-cols-[1fr_auto] items-center gap-3 border border-moonwalk-silver p-3 dark:border-moonwalk-slate">
              <p className="text-[19px] leading-6">{item}</p>
              <ChevronRight className="size-5 text-moonwalk-slate" aria-hidden="true" />
            </div>
          ))}
        </div>
      </GridPanel>
    </div>
  );
}

function UsageMeter({ label, value, helper }: { label: string; value: number; helper: string }) {
  return (
    <div className="border border-moonwalk-silver p-3 dark:border-moonwalk-slate">
      <div className="flex items-center justify-between gap-3">
        <p className="text-lg font-bold leading-none">{label}</p>
        <p className="text-lg font-bold leading-none text-moonwalk-teal">{value}%</p>
      </div>
      <div className="mt-3 h-3 border border-moonwalk-silver dark:border-moonwalk-slate">
        <div className="h-full bg-moonwalk-teal" style={{ width: `${value}%` }} />
      </div>
      <p className="mt-2 text-sm leading-5 text-moonwalk-slate/70 dark:text-moonwalk-white/65">{helper}</p>
    </div>
  );
}

function BiofeedbackPage({ selectedDevice }: { selectedDevice: DeviceId }) {
  const deviceLabel = devices.find((device) => device.id === selectedDevice)?.label ?? "ไม้เท้า";

  return (
    <div className="grid gap-3">
      <GridPanel className="border-moonwalk-navy">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">Live walking state</p>
            <h1 className="mt-2 text-[30px] font-bold leading-none min-[390px]:text-[34px]">กำลังเดิน</h1>
          </div>
          <div className="grid size-11 shrink-0 place-items-center border border-moonwalk-teal text-moonwalk-teal">
            <Activity className="size-6" aria-hidden="true" />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 border border-moonwalk-silver dark:border-moonwalk-slate">
          <div className="border-r border-moonwalk-silver p-3 dark:border-moonwalk-slate">
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">เวลา</p>
            <p className="mt-1 text-2xl font-bold leading-none">08:42</p>
          </div>
          <div className="border-r border-moonwalk-silver p-3 dark:border-moonwalk-slate">
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">อุปกรณ์</p>
            <p className="mt-1 truncate text-2xl font-bold leading-none">{deviceLabel}</p>
          </div>
          <div className="p-3">
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">คุณภาพ</p>
            <p className="mt-1 text-2xl font-bold leading-none text-moonwalk-teal">ดี</p>
          </div>
        </div>
      </GridPanel>

      <GridPanel className="bg-moonwalk-navy text-moonwalk-white dark:border-moonwalk-white">
        <p className="text-sm text-moonwalk-silver">Biofeedback now</p>
        <h2 className="mt-2 text-[32px] font-bold leading-none">คงจังหวะนี้ไว้</h2>
        <p className="mt-3 text-lg leading-7 text-moonwalk-silver">
          ระบบเห็นรูปแบบการเดินต่อเนื่องและจังหวะค่อนข้างสม่ำเสมอ ไม่ต้องเร่งความเร็ว
        </p>
      </GridPanel>

      <div className="grid gap-3">
        {feedbackCards.map(({ label, value, unit, helper, icon: Icon }) => (
          <GridPanel key={label}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">{label}</p>
              <Icon className="size-5 text-moonwalk-slate dark:text-moonwalk-silver" aria-hidden="true" />
            </div>
            <div className="mt-4 flex items-end gap-2">
              <p className="text-3xl font-bold leading-none">{value}</p>
              <p className="pb-1 text-sm font-bold text-moonwalk-slate/70 dark:text-moonwalk-white/65">{unit}</p>
            </div>
            <p className="mt-2 text-base text-moonwalk-slate/70 dark:text-moonwalk-white/65">{helper}</p>
          </GridPanel>
        ))}
      </div>

      <GridPanel>
        <h2 className="text-2xl font-bold">Current usage</h2>
        <div className="mt-4 grid gap-3">
          <UsageMeter label="เป้าหมายเวลาเดิน" value={72} helper="ทำไปแล้ว 8:42 จากเป้าหมาย 12 นาที" />
          <UsageMeter label="ความสม่ำเสมอของจังหวะ" value={86} helper="คะแนนนี้เทียบกับ baseline ส่วนตัว" />
          <UsageMeter label="ความพร้อมของข้อมูล" value={94} helper="Bluetooth และ sample rate อยู่ในช่วงดี" />
        </div>
      </GridPanel>

      <GridPanel>
        <h2 className="text-2xl font-bold">คำแนะนำถัดไป</h2>
        <div className="mt-4 grid gap-2">
          {["เดินต่ออีก 2 นาทีด้วยจังหวะเดิม", "จับอุปกรณ์ให้มั่นคงแต่ไม่ต้องกดเพิ่ม", "ถ้ารู้สึกล้า ให้หยุดพักและบันทึกเซสชัน"].map(
            (item) => (
              <div key={item} className="grid min-h-14 grid-cols-[1fr_auto] items-center gap-3 border border-moonwalk-silver p-3 dark:border-moonwalk-slate">
                <p className="text-[19px] leading-6">{item}</p>
                <ChevronRight className="size-5 text-moonwalk-slate dark:text-moonwalk-silver" aria-hidden="true" />
              </div>
            ),
          )}
        </div>
      </GridPanel>
    </div>
  );
}

function SignalBars({ bars }: { bars: number[] }) {
  return (
    <div className="flex h-16 items-end gap-1 border-t border-moonwalk-silver pt-3 dark:border-moonwalk-slate min-[430px]:h-20">
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

function SignalsPage() {
  return (
    <div className="grid gap-3">
      <GridPanel className="border-moonwalk-navy dark:border-moonwalk-white">
        <div className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div className="min-w-0">
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">Live Signal Dashboard</p>
            <h1 className="mt-2 text-[30px] font-bold leading-none min-[390px]:text-[34px]">สัญญาณสดจากโมดูล</h1>
          </div>
          <RadioTower className="size-7 shrink-0" aria-hidden="true" />
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2">
          <MiniStatus label="Rate" value="20Hz" tone="green" />
          <MiniStatus label="Lost" value="0.4%" tone="amber" />
          <MiniStatus label="Slot" value="A" />
        </div>
      </GridPanel>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {liveSignals.map((signal) => (
          <GridPanel key={signal.label}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm uppercase text-moonwalk-slate/70 dark:text-moonwalk-white/65">{signal.label}</p>
                <p className="mt-1 text-[28px] font-bold leading-none min-[430px]:text-3xl">{signal.value}</p>
              </div>
              <p className="border border-moonwalk-silver px-2 py-1 text-sm dark:border-moonwalk-slate">{signal.unit}</p>
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
            <h2 className="text-2xl font-bold">Raw stream</h2>
            <p className="mt-1 text-lg leading-7 text-moonwalk-slate dark:text-moonwalk-silver">
              หน้านี้แสดงสัญญาณสดสำหรับตรวจสอบระบบ ไม่ใช้เป็นคำวินิจฉัยหรือการจัดระดับผู้ใช้
            </p>
          </div>
        </div>
      </GridPanel>
    </div>
  );
}

function AddDeviceOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="font-line-seed-th fixed inset-0 z-30 bg-moonwalk-white text-moonwalk-navy dark:bg-moonwalk-navy dark:text-moonwalk-white">
      <div className="grid h-full grid-rows-[auto_1fr_auto]">
        <header className="grid grid-cols-[1fr_auto] items-center border-b border-moonwalk-navy p-3 dark:border-moonwalk-white">
          <div>
            <p className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">Device setup</p>
            <h1 className="text-2xl font-bold leading-none">เพิ่มอุปกรณ์ของคุณ</h1>
          </div>
          <button
            type="button"
            className="grid size-11 place-items-center border border-moonwalk-navy dark:border-moonwalk-white"
            onClick={onClose}
            aria-label="ปิด"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-y-auto p-3">
          <div className="grid gap-3">
            <section className="border border-moonwalk-silver p-3 dark:border-moonwalk-white/20">
              <h2 className="text-xl font-bold">ข้อมูลอุปกรณ์</h2>
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1">
                  <span className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">ชื่ออุปกรณ์</span>
                  <input
                    className="h-12 border border-moonwalk-silver bg-moonwalk-white px-3 text-lg outline-none focus:border-moonwalk-teal dark:border-moonwalk-white/20 dark:bg-moonwalk-navy"
                    placeholder="เช่น ไม้ค้ำยันของคุณสมชาย"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">ประเภทอุปกรณ์</span>
                  <select className="h-12 border border-moonwalk-silver bg-moonwalk-white px-3 text-lg outline-none focus:border-moonwalk-teal dark:border-moonwalk-white/20 dark:bg-moonwalk-navy">
                    <option>ไม้เท้า</option>
                    <option>Walker</option>
                    <option>Crutch</option>
                    <option>Rollator</option>
                    <option>อื่นๆ</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-sm text-moonwalk-slate/70 dark:text-moonwalk-white/65">ตำแหน่งติดตั้งโมดูล</span>
                  <input
                    className="h-12 border border-moonwalk-silver bg-moonwalk-white px-3 text-lg outline-none focus:border-moonwalk-teal dark:border-moonwalk-white/20 dark:bg-moonwalk-navy"
                    placeholder="เช่น ด้านขวาของด้ามจับ"
                  />
                </label>
              </div>
            </section>

            <section className="border border-moonwalk-silver p-3 dark:border-moonwalk-white/20">
              <h2 className="text-xl font-bold">รูปอุปกรณ์</h2>
              <button
                type="button"
                className="mt-3 grid min-h-32 w-full place-items-center border border-dashed border-moonwalk-teal bg-moonwalk-teal/10 text-moonwalk-navy dark:text-moonwalk-white"
              >
                <div className="grid justify-items-center gap-2">
                  <Plus className="size-8 text-moonwalk-teal" aria-hidden="true" />
                  <span className="text-lg font-bold">เพิ่มรูปอุปกรณ์</span>
                </div>
              </button>
            </section>

            <section className="border border-moonwalk-silver p-3 dark:border-moonwalk-white/20">
              <h2 className="text-xl font-bold">คำอธิบาย</h2>
              <textarea
                className="mt-3 min-h-28 w-full resize-none border border-moonwalk-silver bg-moonwalk-white p-3 text-lg outline-none focus:border-moonwalk-teal dark:border-moonwalk-white/20 dark:bg-moonwalk-navy"
                placeholder="บันทึกรายละเอียด เช่น ความยาว อุปกรณ์เสริม หรือวิธีติดตั้ง"
              />
            </section>
          </div>
        </div>

        <footer className="grid grid-cols-2 gap-2 border-t border-moonwalk-navy p-3 dark:border-moonwalk-white">
          <button type="button" className="min-h-12 border border-moonwalk-navy text-lg font-bold dark:border-moonwalk-white" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className="min-h-12 border border-moonwalk-teal bg-moonwalk-teal text-lg font-bold text-moonwalk-navy" onClick={onClose}>
            บันทึกอุปกรณ์
          </button>
        </footer>
      </div>
    </div>
  );
}

export default function MoonWalkApp() {
  const [activePage, setActivePage] = useState<PageId>("home");
  const [selectedDevice, setSelectedDevice] = useState<DeviceId>("cane");
  const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
  const [isAddDeviceOpen, setIsAddDeviceOpen] = useState(false);

  const content = useMemo(() => {
    if (activePage === "biofeedback") {
      return <BiofeedbackPage selectedDevice={selectedDevice} />;
    }

    if (activePage === "signals") {
      return <SignalsPage />;
    }

    return <HomePage selectedDevice={selectedDevice} />;
  }, [activePage, selectedDevice]);

  return (
    <main className="min-h-0 overflow-y-auto bg-moonwalk-white text-moonwalk-navy dark:bg-moonwalk-navy dark:text-moonwalk-white">
      <div className="font-line-seed-th mx-auto grid min-h-full w-full max-w-6xl gap-3 px-3 pb-24 pt-0 md:px-5 md:pt-3">
        <StickyDeviceBar
          selectedDevice={selectedDevice}
          onDeviceChange={setSelectedDevice}
          isOpen={isDeviceMenuOpen}
          onToggleOpen={() => setIsDeviceMenuOpen((value) => !value)}
          onAddDevice={() => {
            setIsDeviceMenuOpen(false);
            setIsAddDeviceOpen(true);
          }}
        />

        {content}

        <div className="border border-moonwalk-silver bg-moonwalk-white p-3 text-base text-moonwalk-slate dark:border-moonwalk-white/20 dark:bg-moonwalk-navy dark:text-moonwalk-white/65">
          <span>โมดูลติดตั้งกับ {devices.find((device) => device.id === selectedDevice)?.label}</span>
        </div>
      </div>

      <nav
        className="font-line-seed-th fixed inset-x-0 bottom-0 z-20 border-t border-moonwalk-navy bg-moonwalk-white p-0 pb-[env(safe-area-inset-bottom)] text-moonwalk-navy dark:border-moonwalk-white dark:bg-moonwalk-navy dark:text-moonwalk-white"
        aria-label="หน้าหลัก Moon Walk"
      >
        <div className="mx-auto grid max-w-md grid-cols-3 border-x border-moonwalk-navy dark:border-moonwalk-white">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={cn(
                "flex min-h-[72px] flex-col items-center justify-center gap-1 border-r border-moonwalk-navy px-1 text-base font-bold leading-none last:border-r-0 dark:border-moonwalk-white",
                activePage === id && "bg-moonwalk-navy text-moonwalk-white dark:bg-moonwalk-white dark:text-moonwalk-navy",
              )}
              onClick={() => setActivePage(id)}
            >
              <Icon className="size-5" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>

      {isAddDeviceOpen ? <AddDeviceOverlay onClose={() => setIsAddDeviceOpen(false)} /> : null}
    </main>
  );
}
