"use client";

import type { TagColor } from "@repo/api/src/types/tag";
import { TAG_COLORS } from "@repo/api/src/types/tag";
import { ColorSwatchPicker } from "@repo/app/shared/components/color-swatch-picker";

const TAG_COLOR_CLASSES: Record<TagColor, string> = {
  red: "bg-red-500",
  rose: "bg-rose-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  yellow: "bg-yellow-400",
  lime: "bg-lime-500",
  green: "bg-green-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  cyan: "bg-cyan-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
};

const TAG_COLOR_PALETTE = TAG_COLORS.map((color) => ({
  name: color,
  colorClass: TAG_COLOR_CLASSES[color],
}));

type TagColorPickerProps = {
  value: TagColor;
  onChange: (color: TagColor) => void;
  disabled?: boolean;
};

export function TagColorPicker({
  value,
  onChange,
  disabled,
}: Readonly<TagColorPickerProps>) {
  return (
    <ColorSwatchPicker
      columns={8}
      disabled={disabled}
      onSelect={(name) => onChange(name as TagColor)}
      palette={TAG_COLOR_PALETTE}
      selectedName={value}
      triggerColorClass={TAG_COLOR_CLASSES[value] ?? "bg-blue-500"}
      triggerLabel={`Color: ${value}`}
    />
  );
}

export { TAG_COLOR_CLASSES };
