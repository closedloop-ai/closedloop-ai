"use client";

import {
  CUSTOM_FIELD_OPTION_COLOR_CLASSES,
  CustomFieldOptionColor,
  isCustomFieldOptionColor,
} from "@repo/app/custom-fields/lib/option-colors";
import { ColorSwatchPicker } from "@repo/app/shared/components/color-swatch-picker";

export type ColorName = CustomFieldOptionColor;

export const COLOR_PALETTE: readonly { name: ColorName; colorClass: string }[] =
  Object.values(CustomFieldOptionColor).map((name) => ({
    name,
    colorClass: CUSTOM_FIELD_OPTION_COLOR_CLASSES[name],
  }));

export type ColorPickerProps = {
  value: ColorName | null;
  onChange: (color: ColorName | null) => void;
  disabled?: boolean;
};

/**
 * The prop type says `color` is canonical, but a PERSISTED row can carry
 * anything — including the add-field dialog's Tailwind class from before
 * ISS-8215 — so the unknown-value fallback to grey is load-bearing rather than
 * defensive. Resolving such a value to the colour its author picked is the
 * caller's job (`storedOptionColor`), not this renderer's.
 */
function getColorClass(color: ColorName | null): string {
  const known = color !== null && isCustomFieldOptionColor(color);
  return CUSTOM_FIELD_OPTION_COLOR_CLASSES[
    known ? color : CustomFieldOptionColor.None
  ];
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
        onChange(name === CustomFieldOptionColor.None ? null : name)
      }
      palette={COLOR_PALETTE}
      selectedName={value ?? "none"}
      triggerColorClass={getColorClass(value)}
      triggerLabel={`Color: ${value ?? "none"}`}
    />
  );
}
