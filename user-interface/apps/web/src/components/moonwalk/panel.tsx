import { Circle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@user-interface/ui/lib/utils";

export function GridPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "border border-moonwalk-silver bg-moonwalk-white p-2 text-moonwalk-navy dark:border-moonwalk-slate dark:bg-moonwalk-navy dark:text-moonwalk-white sm:p-3",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function MiniStatus({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "green" | "amber" | "neutral";
}) {
  return (
    <div className="min-w-0 border border-moonwalk-silver p-2 dark:border-moonwalk-slate">
      <p className="text-xs leading-4 text-moonwalk-slate/70 dark:text-moonwalk-white/65">
        {label}
      </p>
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
        <p className="min-w-0 text-base font-bold leading-none">{value}</p>
      </div>
    </div>
  );
}
