"use client";

import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { Line } from "react-chartjs-2";

import { cn } from "@user-interface/ui/lib/utils";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler);

const progressPoints = [
  { day: 1, current: 28, baseline: 28 },
  { day: 4, current: 35, baseline: 31 },
  { day: 7, current: 43, baseline: 35 },
  { day: 10, current: 52, baseline: 39 },
  { day: 13, current: 58, baseline: 42 },
  { day: 16, current: 66, baseline: 47 },
  { day: 20, current: 74, baseline: 53 },
  { day: 24, current: 81, baseline: 62 },
  { day: 28, current: 88, baseline: 71 },
];

const currentDay = 20;
const currentPoint = progressPoints.find((point) => point.day === currentDay);
const baselineAtCurrent =
  currentPoint?.baseline ?? progressPoints[progressPoints.length - 1]?.baseline ?? 0;
const currentAtCurrent =
  currentPoint?.current ?? progressPoints[progressPoints.length - 1]?.current ?? 0;
const improvement = currentAtCurrent - baselineAtCurrent;

export function HomeProgressChart({
  className,
  tone = "default",
}: {
  className?: string;
  tone?: "default" | "navy";
}) {
  const isNavy = tone === "navy";
  const data = useMemo<ChartData<"line">>(
    () => ({
      labels: progressPoints.map((point) => String(point.day)),
      datasets: [
        {
          label: "ค่าเริ่มต้น",
          data: progressPoints.map((point) => point.baseline),
          borderColor: "rgba(148, 163, 184, 0.78)",
          backgroundColor: "rgba(148, 163, 184, 0.08)",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.18,
        },
        {
          label: "ปัจจุบัน",
          data: progressPoints.map((point) => point.current),
          borderColor: "#41c3c0",
          backgroundColor: "rgba(65, 195, 192, 0.18)",
          borderWidth: 2.5,
          fill: true,
          pointRadius: progressPoints.map((point) => (point.day === currentDay ? 4 : 0)),
          pointBackgroundColor: "#41c3c0",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointHoverRadius: 0,
          tension: 0.18,
        },
      ],
    }),
    [],
  );

  const options = useMemo<ChartOptions<"line">>(
    () => ({
      animation: false,
      maintainAspectRatio: false,
      responsive: true,
      events: [],
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          border: { display: false },
          grid: {
            color: "rgba(148, 163, 184, 0.16)",
            drawTicks: false,
          },
          ticks: {
            color: "rgba(100, 116, 139, 0.86)",
            font: { size: 9, weight: 700 },
            maxRotation: 0,
            callback: (_value, index) => {
              const day = progressPoints[index]?.day;
              return day === 1 || day === currentDay || day === 28
                ? `วัน ${day}`
                : "";
            },
          },
        },
        y: {
          min: 20,
          max: 92,
          border: { display: false },
          grid: {
            color: "rgba(148, 163, 184, 0.14)",
            drawTicks: false,
          },
          ticks: {
            color: "rgba(100, 116, 139, 0.72)",
            font: { size: 9, weight: 700 },
            count: 4,
            callback: (value) => `${value}%`,
          },
        },
      },
    }),
    [],
  );

  return (
    <section
      className={cn(
        "border border-moonwalk-silver bg-moonwalk-white text-moonwalk-navy dark:border-moonwalk-slate dark:bg-moonwalk-navy dark:text-moonwalk-white",
        isNavy &&
          "border-moonwalk-white/30 bg-moonwalk-navy text-moonwalk-white dark:border-moonwalk-white/30",
        className,
      )}
    >
      <div
        className={cn(
          "grid grid-cols-[1fr_auto] items-start gap-2 border-b border-moonwalk-silver p-2 dark:border-moonwalk-slate",
          isNavy && "border-moonwalk-white/20 dark:border-moonwalk-white/20",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TrendingUp className="size-4 text-moonwalk-teal" aria-hidden="true" />
            <h2 className="text-base font-bold leading-none">
              ความก้าวหน้าเทียบค่าเริ่มต้น
            </h2>
          </div>
          <p
            className={cn(
              "mt-1 text-[11px] leading-4 text-moonwalk-slate/70 dark:text-moonwalk-white/65",
              isNavy && "text-moonwalk-silver",
            )}
          >
            กราฟจำลองเพื่อดูแนวโน้มว่าการเดินดีขึ้นกว่าช่วงเริ่มใช้งานหรือไม่
          </p>
        </div>
        <div className="border border-moonwalk-teal px-2 py-1 text-right">
          <p
            className={cn(
              "text-[9px] font-bold leading-none text-moonwalk-slate/70 dark:text-moonwalk-white/60",
              isNavy && "text-moonwalk-silver",
            )}
          >
            ดีขึ้น
          </p>
          <p className="mt-1 text-lg font-bold leading-none text-moonwalk-teal">
            +{improvement}%
          </p>
        </div>
      </div>

      <div
        className={cn(
          "grid grid-cols-3 border-b border-moonwalk-silver text-center dark:border-moonwalk-slate",
          isNavy && "border-moonwalk-white/20 dark:border-moonwalk-white/20",
        )}
      >
        <div
          className={cn(
            "border-r border-moonwalk-silver px-1 py-1.5 dark:border-moonwalk-slate",
            isNavy && "border-moonwalk-white/20 dark:border-moonwalk-white/20",
          )}
        >
          <p
            className={cn(
              "text-[9px] text-moonwalk-slate/70 dark:text-moonwalk-white/60",
              isNavy && "text-moonwalk-silver",
            )}
          >
            ปัจจุบัน
          </p>
          <p className="mt-0.5 text-sm font-bold leading-none text-moonwalk-teal">
            {currentAtCurrent}%
          </p>
        </div>
        <div
          className={cn(
            "border-r border-moonwalk-silver px-1 py-1.5 dark:border-moonwalk-slate",
            isNavy && "border-moonwalk-white/20 dark:border-moonwalk-white/20",
          )}
        >
          <p
            className={cn(
              "text-[9px] text-moonwalk-slate/70 dark:text-moonwalk-white/60",
              isNavy && "text-moonwalk-silver",
            )}
          >
            ค่าเริ่มต้น
          </p>
          <p className="mt-0.5 text-sm font-bold leading-none">
            {baselineAtCurrent}%
          </p>
        </div>
        <div className="px-1 py-1.5">
          <p
            className={cn(
              "text-[9px] text-moonwalk-slate/70 dark:text-moonwalk-white/60",
              isNavy && "text-moonwalk-silver",
            )}
          >
            วันที่
          </p>
          <p className="mt-0.5 text-sm font-bold leading-none">
            {currentDay}
          </p>
        </div>
      </div>

      <div className="relative h-[168px] p-2">
        <div
          className={cn(
            "absolute left-[67%] top-3 z-10 border border-moonwalk-teal bg-moonwalk-white px-2 py-1 text-[10px] font-bold leading-none text-moonwalk-navy shadow-[4px_4px_0_rgba(65,195,192,0.18)] dark:bg-moonwalk-navy dark:text-moonwalk-white",
            isNavy &&
              "bg-moonwalk-navy text-moonwalk-white shadow-[4px_4px_0_rgba(65,195,192,0.24)]",
          )}
        >
          วันนี้ {currentAtCurrent}%
        </div>
        <Line data={data} options={options} />
      </div>

      <div
        className={cn(
          "grid grid-cols-[auto_1fr] items-center gap-2 border-t border-moonwalk-silver p-2 dark:border-moonwalk-slate",
          isNavy && "border-moonwalk-white/20 dark:border-moonwalk-white/20",
        )}
      >
        <span className="size-2 bg-moonwalk-teal" />
        <p
          className={cn(
            "text-[11px] leading-4 text-moonwalk-slate/75 dark:text-moonwalk-white/65",
            isNavy && "text-moonwalk-silver",
          )}
        >
          เส้นสีฟ้าคือการใช้งานปัจจุบัน เทียบกับเส้นฐานสีเทาจากช่วงเริ่มต้น
        </p>
      </div>
    </section>
  );
}
