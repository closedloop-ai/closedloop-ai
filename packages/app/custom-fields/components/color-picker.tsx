"use client";

import { ColorSwatchPicker } from "@repo/app/shared/components/color-swatch-picker";

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
  return (
    <ColorSwatchPicker
      columns={5}
      disabled={disabled}
      onSelect={(name) =>
        onChange(name === "none" ? null : (name as ColorName))
      }
      palette={COLOR_PALETTE}
      selectedName={value ?? "none"}
      triggerColorClass={getColorClass(value)}
      triggerLabel={`Color: ${value ?? "none"}`}
    />
  );
}
