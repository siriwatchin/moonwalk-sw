export function UsageMeter({
  label,
  value,
  helper,
}: {
  label: string;
  value: number;
  helper: string;
}) {
  return (
    <div className="border border-moonwalk-silver p-2 dark:border-moonwalk-slate">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold leading-none">{label}</p>
        <p className="text-sm font-bold leading-none text-moonwalk-teal">
          {value}%
        </p>
      </div>
      <div className="mt-2 h-2 border border-moonwalk-silver dark:border-moonwalk-slate">
        <div
          className="h-full bg-moonwalk-teal"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="mt-1 truncate text-xs leading-4 text-moonwalk-slate/70 dark:text-moonwalk-white/65">
        {helper}
      </p>
    </div>
  );
}
