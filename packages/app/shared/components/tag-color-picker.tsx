"use client";

import type { TagColor } from "@repo/api/src/types/tag";
import { TAG_COLORS } from "@repo/api/src/types/tag";
import { ColorSwatchPicker } from "./color-swatch-picker";

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

/**
 * The canonical ordered tag palette: every {@link TagColor} paired with its
 * swatch class, derived from `TAG_COLORS` so it cannot drift from the
 * vocabulary. Exported (ISS-6385) so a surface that needs the swatch grid
 * without this component's trigger — the `generic-artifact` prototype's
 * create-tag flow — reads the same 16 rather than inventing a third set.
 */
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
      onSelect={onChange}
      palette={TAG_COLOR_PALETTE}
      selectedName={value}
      triggerColorClass={TAG_COLOR_CLASSES[value] ?? "bg-blue-500"}
      triggerLabel={`Color: ${value}`}
    />
  );
}

/**
 * The one sentence both create-a-tag colour steps show (ISS-6385). It lived in
 * two places with two different quotings of the tag name — the exact drift this
 * ticket exists to remove, one layer up from the palette itself.
 */
export function pickTagColorLabel(tagName: string): string {
  return `Pick a color for ${tagName}`;
}

export { TAG_COLOR_CLASSES, TAG_COLOR_PALETTE };
