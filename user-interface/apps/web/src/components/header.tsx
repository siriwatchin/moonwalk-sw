"use client";
import { Activity, Bluetooth } from "lucide-react";

import { ModeToggle } from "./mode-toggle";

export default function Header() {
  return (
    <header className="border-b border-moonwalk-navy bg-moonwalk-white text-moonwalk-navy dark:border-moonwalk-white dark:bg-moonwalk-navy dark:text-moonwalk-white">
      <div className="font-line-seed-th mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-3 md:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-8 shrink-0 place-items-center border border-moonwalk-navy bg-moonwalk-navy text-moonwalk-white dark:border-moonwalk-white dark:bg-moonwalk-white dark:text-moonwalk-navy">
            <Activity className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xl font-bold leading-none">Moon Walk</p>
            <p className="truncate text-sm leading-none text-moonwalk-slate dark:text-moonwalk-white/65">ระบบช่วยเดินอัจฉริยะ</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 border border-moonwalk-white bg-moonwalk-navy px-2 py-1 text-sm text-moonwalk-white sm:flex">
            <Bluetooth className="size-4" aria-hidden="true" />
            connected
          </div>
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}
