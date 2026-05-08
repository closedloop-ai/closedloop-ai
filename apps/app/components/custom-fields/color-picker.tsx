"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";

export const COLOR_PALETTE = [
  { name: "none", colorClass: "bg-gray-300" },
  { name: "red", colorClass: "bg-red-500" },
  { name: "orange", colorClass: "bg-orange-500" },
  { name: "yellow", colorClass: "bg-yellow-400" },
  { name: "green", colorClass: "bg-green-500" },
  { name: "teal", colorClass: "bg-teal-500" },
  { name: "blue", colorClass: "bg-blue-500" },
  { name: "purple", colorClass: "bg-purple-500" },
  { name: "pink", colorClass: "bg-pink-500" },
] as const;

export type ColorName = (typeof COLOR_PALETTE)[number]["name"];

export type ColorPickerProps = {
  value: ColorName | null;
  onChange: (color: ColorName | null) => void;
  disabled?: boolean;
};

function getColorClass(color: ColorName | null): string {
  if (!color || color === "none") {
    return "bg-gray-300";
  }
  const entry = COLOR_PALETTE.find((c) => c.name === color);
  return entry ? entry.colorClass : "bg-gray-300";
}

export function ColorPicker({
  value,
  onChange,
  disabled,
}: Readonly<ColorPickerProps>) {
  const activeColorClass = getColorClass(value);

  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          aria-label={`Color: ${value ?? "none"}`}
          className="flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled}
          type="button"
        >
          <span className={cn("h-4 w-4 rounded-full", activeColorClass)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-5 gap-1">
          {COLOR_PALETTE.map(({ name, colorClass }) => (
            <button
              aria-label={name}
              className={cn(
                "h-5 w-5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                colorClass,
                (value === name || (name === "none" && !value)) &&
                  "ring-2 ring-ring ring-offset-1"
              )}
              key={name}
              onClick={() => onChange(name === "none" ? null : name)}
              type="button"
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
