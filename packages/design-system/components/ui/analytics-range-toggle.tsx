"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "./toggle-group";

export type AnalyticsRangeToggleOption = {
  label: string;
  value: string;
};

type AnalyticsRangeToggleProps = {
  label?: string;
  options: AnalyticsRangeToggleOption[];
  value: string;
  onValueChange?: (value: string) => void;
  className?: string;
};

export function AnalyticsRangeToggle({
  label = "Range",
  options,
  value,
  onValueChange,
  className,
}: Readonly<AnalyticsRangeToggleProps>) {
  return (
    <div className={className ?? "flex items-center gap-2"}>
      <span className="mr-2 font-medium text-slate-400 text-xs uppercase tracking-wider">
        {label}
      </span>
      <ToggleGroup
        className="gap-1"
        onValueChange={(nextValue) => {
          if (nextValue) {
            onValueChange?.(nextValue);
          }
        }}
        size="sm"
        type="single"
        value={value}
        variant="default"
      >
        {options.map((option) => (
          // `default` (not `outline`): this control carries its own dark
          // slate/emerald theme and opts out of the shared outline redesign
          // (borderless pills + bg-muted active). `border` restores the
          // per-item border width the outline variant used to provide.
          <ToggleGroupItem
            className="border border-slate-700 bg-transparent text-slate-400 hover:text-white data-[state=on]:border-emerald-500/60 data-[state=on]:bg-emerald-600 data-[state=on]:text-white"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
