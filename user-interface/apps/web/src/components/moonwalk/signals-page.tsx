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
import { RadioTower, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";

import { liveSignals } from "@/components/moonwalk-data";
import { GridPanel } from "@/components/moonwalk/panel";
import type { NanoImuSample } from "@/lib/nano-imu";
import { cn } from "@user-interface/ui/lib/utils";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler);

type StreamSignal = {
  label: string;
  unit: string;
  value: number;
  samples: number[];
};

const streamMeta = {
  ax: { group: "ACC", axis: "X", min: -2, max: 2 },
  ay: { group: "ACC", axis: "Y", min: -2, max: 2 },
  az: { group: "ACC", axis: "Z", min: -2, max: 2 },
  gx: { group: "GYRO", axis: "X", min: -180, max: 180 },
  gy: { group: "GYRO", axis: "Y", min: -180, max: 180 },
  gz: { group: "GYRO", axis: "Z", min: -180, max: 180 },
} as const;

function normalizeSample(height: number, index: number) {
  const centered = (height - 50) / 25;
  const drift = Math.sin(index * 0.8) * 0.18;
  return Number((centered + drift).toFixed(2));
}

function createInitialStream(): StreamSignal[] {
  return liveSignals.map((signal) => {
    const samples = signal.bars.map(normalizeSample);
    return {
      label: signal.label,
      unit: signal.unit,
      value: samples.at(-1) ?? 0,
      samples,
    };
  });
}

function sampleToSignalValue(sample: NanoImuSample, label: string) {
  if (label === "ax") {
    return sample.accel.x;
  }

  if (label === "ay") {
    return sample.accel.y;
  }

  if (label === "az") {
    return sample.accel.z;
  }

  if (label === "gx") {
    return sample.gyro.x;
  }

  if (label === "gy") {
    return sample.gyro.y;
  }

  return sample.gyro.z;
}

function SignalRow({
  signal,
  options,
}: {
  signal: StreamSignal;
  options: ChartOptions<"line">;
}) {
  const meta = streamMeta[signal.label as keyof typeof streamMeta];
  const peak = Math.max(...signal.samples.map((sample) => Math.abs(sample)));
  const chartData: ChartData<"line"> = {
    labels: signal.samples.map((_, sampleIndex) => String(sampleIndex)),
    datasets: [
      {
        data: signal.samples.map(() => 0),
        borderColor: "rgba(11, 16, 31, 0.26)",
        borderWidth: 1,
        pointRadius: 0,
        tension: 0,
      },
      {
        data: signal.samples,
        borderColor: "#41c3c0",
        backgroundColor: "rgba(65, 195, 192, 0.12)",
        borderWidth: 1.8,
        fill: true,
        pointRadius: 0,
        tension: 0.35,
      },
    ],
  };

  return (
    <div className="grid min-h-12 grid-cols-[48px_62px_1fr_40px] items-center border-b border-moonwalk-silver bg-moonwalk-white last:border-b-0 dark:border-moonwalk-white/15 dark:bg-moonwalk-navy">
      <div className="grid h-full grid-cols-[4px_1fr] border-r border-moonwalk-silver dark:border-moonwalk-white/15">
        <span
          className={cn(
            "h-full bg-moonwalk-navy dark:bg-moonwalk-white",
            meta.group === "ACC" && "bg-moonwalk-teal dark:bg-moonwalk-teal",
          )}
        />
        <div className="min-w-0 px-1.5 py-1.5">
          <p className="text-[10px] font-bold uppercase leading-none text-moonwalk-slate/70 dark:text-moonwalk-white/60">
            {meta.group}
          </p>
          <p className="mt-1 text-sm font-bold uppercase leading-none">
            {meta.axis}
          </p>
        </div>
      </div>
      <div className="border-r border-moonwalk-silver px-1.5 py-1.5 dark:border-moonwalk-white/15">
        <p className="text-[10px] font-bold uppercase leading-none text-moonwalk-slate/70 dark:text-moonwalk-white/60">
          {signal.label}
        </p>
        <p className="mt-1 text-[15px] font-bold leading-none tabular-nums">
          {signal.value.toFixed(2)}
        </p>
        <p className="mt-0.5 text-[9px] leading-none text-moonwalk-slate/70 dark:text-moonwalk-white/60">
          {signal.unit}
        </p>
      </div>
      <div className="h-11 min-w-0 bg-[linear-gradient(90deg,rgba(212,217,221,0.55)_1px,transparent_1px)] bg-[length:18px_100%] px-1.5 py-1 dark:bg-[linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)]">
        <Line data={chartData} options={options} />
      </div>
      <div className="grid h-full content-center border-l border-moonwalk-silver px-1 text-center dark:border-moonwalk-white/15">
        <p className="text-[9px] font-bold leading-none text-moonwalk-slate/60 dark:text-moonwalk-white/55">
          pk
        </p>
        <p className="mt-1 text-[11px] font-bold leading-none tabular-nums text-moonwalk-teal">
          {peak.toFixed(1)}
        </p>
      </div>
    </div>
  );
}

export function SignalsPage({
  badPacketCount,
  isBluetoothConnected,
  latestSample,
  packetCount,
}: {
  badPacketCount: number;
  isBluetoothConnected: boolean;
  latestSample: NanoImuSample | null;
  packetCount: number;
}) {
  const [stream, setStream] = useState(createInitialStream);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (isBluetoothConnected) {
      return;
    }

    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      setStream((current) =>
        current.map((signal, signalIndex) => {
          const previous = signal.samples.at(-1) ?? 0;
          const wave = Math.sin(Date.now() / 360 + signalIndex * 0.9) * 0.2;
          const jitter = (Math.random() - 0.5) * 0.14;
          const next = Number(
            Math.max(
              -1.6,
              Math.min(1.6, previous * 0.62 + wave + jitter),
            ).toFixed(2),
          );

          return {
            ...signal,
            value: next,
            samples: [...signal.samples.slice(1), next],
          };
        }),
      );
    }, 420);

    return () => window.clearInterval(timer);
  }, [isBluetoothConnected]);

  useEffect(() => {
    if (!latestSample) {
      return;
    }

    setTick(packetCount);
    setStream((current) =>
      current.map((signal) => {
        const next = sampleToSignalValue(latestSample, signal.label);

        return {
          ...signal,
          value: next,
          samples: [...signal.samples.slice(1), next],
        };
      }),
    );
  }, [latestSample, packetCount]);

  const chartOptions = useMemo<ChartOptions<"line">>(
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
          display: false,
          grid: { display: false },
        },
        y: {
          display: false,
          grid: { display: false },
        },
      },
    }),
    [],
  );

  return (
    <div className="grid gap-2 overflow-hidden">
      <GridPanel className="border-moonwalk-navy bg-moonwalk-navy p-0 text-moonwalk-white dark:border-moonwalk-white">
        <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-moonwalk-white/20 p-2">
          <div className="min-w-0">
            <p className="text-[10px] uppercase leading-none text-moonwalk-silver">
              Live Signal Dashboard
            </p>
            <h1 className="mt-1 truncate text-xl font-bold leading-none">
              สัญญาณสดจากโมดูล
            </h1>
          </div>
          <div className="grid grid-cols-[auto_auto] items-center gap-2 border border-moonwalk-white px-2 py-1 text-moonwalk-white">
            <RadioTower className="size-4" aria-hidden="true" />
            <span className="text-xs font-bold leading-none">20Hz</span>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] text-center">
          <div className="border-r border-moonwalk-white/20 px-1 py-1.5">
            <p className="text-[9px] uppercase leading-none text-moonwalk-silver">
              stream
            </p>
            <p className="mt-1 text-sm font-bold leading-none text-moonwalk-teal">
              {isBluetoothConnected ? "BLE" : "MOCK"}
            </p>
          </div>
          <div className="border-r border-moonwalk-white/20 px-1 py-1.5">
            <p className="text-[9px] uppercase leading-none text-moonwalk-silver">
              packets
            </p>
            <p className="mt-1 text-sm font-bold leading-none tabular-nums">
              {String(isBluetoothConnected ? packetCount : 1280 + tick).padStart(
                4,
                "0",
              )}
            </p>
          </div>
          <div className="border-r border-moonwalk-white/20 px-1 py-1.5">
            <p className="text-[9px] uppercase leading-none text-moonwalk-silver">
              {isBluetoothConnected ? "bad" : "loss"}
            </p>
            <p className="mt-1 text-sm font-bold leading-none text-moonwalk-teal">
              {isBluetoothConnected ? badPacketCount : "0.4%"}
            </p>
          </div>
          <div className="grid place-items-center px-2">
            <Zap className="size-4 text-moonwalk-teal" aria-hidden="true" />
          </div>
        </div>
      </GridPanel>

      <GridPanel className="p-0">
        <div className="grid grid-cols-[48px_62px_1fr_40px] border-b border-moonwalk-navy bg-moonwalk-silver/40 text-moonwalk-navy dark:border-moonwalk-white dark:bg-moonwalk-white/10 dark:text-moonwalk-white">
          <p className="border-r border-moonwalk-navy/15 px-1.5 py-1 text-[9px] font-bold uppercase leading-none dark:border-moonwalk-white/20">
            axis
          </p>
          <p className="border-r border-moonwalk-navy/15 px-1.5 py-1 text-[9px] font-bold uppercase leading-none dark:border-moonwalk-white/20">
            value
          </p>
          <p className="px-1.5 py-1 text-[9px] font-bold uppercase leading-none">
            waveform
          </p>
          <p className="border-l border-moonwalk-navy/15 px-1 py-1 text-center text-[9px] font-bold uppercase leading-none dark:border-moonwalk-white/20">
            peak
          </p>
        </div>
        {stream.map((signal, index) => (
          <SignalRow
            key={signal.label}
            signal={signal}
            options={chartOptions}
          />
        ))}
      </GridPanel>
    </div>
  );
}
