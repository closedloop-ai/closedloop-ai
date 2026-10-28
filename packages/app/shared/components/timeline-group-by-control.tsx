"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { useId } from "react";

export type TimelineGroupingOption<TValue extends string = string> = {
  readonly label: string;
  readonly value: TValue;
};

export function TimelineGroupByControl<TValue extends string>({
  onValueChange,
  options,
  title = "Group timeline by",
  triggerClassName = "h-[26px] w-[156px]",
  value,
}: Readonly<{
  onValueChange: (value: TValue) => void;
  options: readonly TimelineGroupingOption<TValue>[];
  title?: string;
  triggerClassName?: string;
  value: TValue;
}>) {
  const labelId = useId();

  return (
    <div className="flex items-center gap-2">
      <span
        className="whitespace-nowrap text-muted-foreground text-xs"
        id={labelId}
      >
        Group by
      </span>
      <Select
        onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
        value={value}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          className={triggerClassName}
          size="sm"
          title={title}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
