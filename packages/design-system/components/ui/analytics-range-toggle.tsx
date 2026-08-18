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
      <span className="mr-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
        {label}
      </span>
      {/* `outline` = the shared token-based segmented control: a bordered,
          padded container of borderless pills, bg-muted + accent-foreground on
          the active pill, muted/foreground labels. Its predecessor hardcoded a
          slate/emerald palette that failed the 4.5:1 contrast floor on the
          light product surfaces every consumer renders on. */}
      <ToggleGroup
        onValueChange={(nextValue) => {
          if (nextValue) {
            onValueChange?.(nextValue);
          }
        }}
        size="sm"
        type="single"
        value={value}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
