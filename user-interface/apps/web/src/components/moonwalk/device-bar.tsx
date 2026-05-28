"use client";

import {
  Bluetooth,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-react";

import { devices, type DeviceId } from "@/components/moonwalk-data";
import { cn } from "@user-interface/ui/lib/utils";

export function StickyDeviceBar({
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
  const selected =
    devices.find((device) => device.id === selectedDevice) ?? devices[0];

  return (
    <section className="sticky top-0 z-10 -mx-3 border-y border-moonwalk-navy bg-moonwalk-white text-moonwalk-navy dark:border-moonwalk-white dark:bg-moonwalk-navy dark:text-moonwalk-white md:mx-0 md:border-x">
      <div className="grid grid-cols-[1fr_auto] items-center border-b border-moonwalk-white bg-moonwalk-navy px-3 py-1.5 text-moonwalk-white">
        <div className="flex min-w-0 items-center gap-2">
          <Bluetooth
            className="size-4 shrink-0 text-moonwalk-teal"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-base font-bold leading-none">
              Bluetooth connected
            </p>
          </div>
        </div>
        <div className="border border-moonwalk-white px-2 py-0.5 text-xs font-bold text-moonwalk-white">
          LIVE
        </div>
      </div>

      <button
        type="button"
        className="grid min-h-12 w-full grid-cols-[48px_1fr_auto] items-center gap-2 px-3 py-1.5 text-left"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
      >
        <div className="grid h-10 w-12 place-items-center border border-moonwalk-silver bg-moonwalk-silver/35 dark:border-moonwalk-white/25 dark:bg-moonwalk-white/10">
          <img
            src={selected.iconSrc}
            alt=""
            className="h-8 w-8 object-contain"
          />
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-bold leading-none">
            {selected.label}
          </p>
          <p className="mt-0.5 truncate text-xs leading-4 text-moonwalk-slate/75 dark:text-moonwalk-white/65">
            {selected.description}
          </p>
        </div>
        <ChevronDown
          className={cn("size-5 transition-transform", isOpen && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {isOpen ? (
        <div className="border-t border-moonwalk-navy bg-moonwalk-white dark:border-moonwalk-white/25 dark:bg-moonwalk-navy">
          {devices.map((device) => {
            return (
              <button
                key={device.id}
                type="button"
                className={cn(
                  "grid min-h-16 w-full grid-cols-[56px_1fr_auto] items-center gap-2 border-b border-moonwalk-silver px-3 py-1.5 text-left last:border-b-0 dark:border-moonwalk-white/15",
                  selectedDevice === device.id &&
                    "bg-moonwalk-silver/35 dark:bg-moonwalk-white/10",
                )}
                onClick={() => {
                  onDeviceChange(device.id);
                  onToggleOpen();
                }}
              >
                <div className="grid h-14 w-14 place-items-center border border-moonwalk-silver bg-moonwalk-white dark:border-moonwalk-white/20 dark:bg-moonwalk-slate">
                  <img
                    src={device.iconSrc}
                    alt=""
                    className="h-11 w-11 object-contain"
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-lg font-bold leading-none">
                    {device.label}
                  </p>
                  <p className="mt-0.5 text-xs leading-4 text-moonwalk-slate/75 dark:text-moonwalk-white/65">
                    {device.description}
                  </p>
                </div>
                {selectedDevice === device.id ? (
                  <Check
                    className="size-5 text-moonwalk-teal"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            className="grid min-h-16 w-full grid-cols-[56px_1fr_auto] items-center gap-2 px-3 py-1.5 text-left"
            onClick={onAddDevice}
          >
            <div className="grid h-14 w-14 place-items-center border border-moonwalk-teal bg-moonwalk-teal/10">
              <Plus className="size-6 text-moonwalk-teal" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-bold leading-none">
                เพิ่มอุปกรณ์ของคุณ
              </p>
              <p className="mt-0.5 text-xs leading-4 text-moonwalk-slate/75 dark:text-moonwalk-white/65">
                เพิ่มชื่อ ประเภท รูปแบบการติดตั้ง และรายละเอียดโมดูล
              </p>
            </div>
            <ChevronRight
              className="size-5 text-moonwalk-slate dark:text-moonwalk-white/65"
              aria-hidden="true"
            />
          </button>
        </div>
      ) : null}
    </section>
  );
}
