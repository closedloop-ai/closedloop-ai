import {
  TABLE_FIELD_OPTION_COLORS,
  type TableFieldOptionColorClass,
} from "@repo/design-system/components/ui/table-add-field-dialog-colors";

/**
 * The canonical vocabulary persisted in `custom_field_enum_options.color`, and
 * the only spelling every custom-field host understands.
 *
 * Lightweight on purpose: no Zod, no component runtime, nothing that a
 * bundle-sensitive `"use client"` consumer would have to pay for to read a
 * colour id. `color-picker.tsx` renders it; nothing else may re-declare it.
 */
export const CustomFieldOptionColor = {
  None: "none",
  Red: "red",
  Orange: "orange",
  Yellow: "yellow",
  Green: "green",
  Teal: "teal",
  Blue: "blue",
  Purple: "purple",
  Pink: "pink",
} as const;
export type CustomFieldOptionColor =
  (typeof CustomFieldOptionColor)[keyof typeof CustomFieldOptionColor];

/**
 * The Tailwind class each canonical id renders as. Exhaustive by type: a new
 * member of {@link CustomFieldOptionColor} fails `tsc` here until the renderer
 * has been told what it looks like, rather than silently reading as grey.
 */
export const CUSTOM_FIELD_OPTION_COLOR_CLASSES: Readonly<
  Record<CustomFieldOptionColor, string>
> = {
  [CustomFieldOptionColor.None]: "bg-gray-300",
  [CustomFieldOptionColor.Red]: "bg-red-500",
  [CustomFieldOptionColor.Orange]: "bg-orange-500",
  [CustomFieldOptionColor.Yellow]: "bg-yellow-400",
  [CustomFieldOptionColor.Green]: "bg-green-500",
  [CustomFieldOptionColor.Teal]: "bg-teal-500",
  [CustomFieldOptionColor.Blue]: "bg-blue-500",
  [CustomFieldOptionColor.Purple]: "bg-purple-500",
  [CustomFieldOptionColor.Pink]: "bg-pink-500",
};

/**
 * The design-system add-field dialog's swatch class -> the id that renders the
 * same colour.
 *
 * The dialog is project-agnostic and speaks semantic DS tokens, so this is the
 * translation at the custom-field/design-system boundary that ISS-8215 asked
 * for — the classes stop here and never reach a persisted row. Each pairing is
 * the token's own hue: `--success` is oklch hue 155 (green), `--warning` hue 85
 * (yellow), `--primary` hue 267 (blue), per
 * `packages/design-system/styles/globals.css`.
 *
 * Exhaustive over {@link TABLE_FIELD_OPTION_COLORS}: a fourth dialog swatch
 * fails `tsc` here until someone decides which colour it persists as.
 */
const DIALOG_COLOR_CLASS_IDS: Readonly<
  Record<TableFieldOptionColorClass, CustomFieldOptionColor>
> = {
  "bg-success": CustomFieldOptionColor.Green,
  "bg-warning": CustomFieldOptionColor.Yellow,
  "bg-primary": CustomFieldOptionColor.Blue,
};

/** Whether `value` is one of the canonical persisted colour ids. */
export function isCustomFieldOptionColor(
  value: string
): value is CustomFieldOptionColor {
  return (Object.values(CustomFieldOptionColor) as string[]).includes(value);
}

/**
 * The canonical id for a swatch class the add-field dialog handed back, or
 * `undefined` for anything else.
 *
 * `TableCustomFieldDraft.optionColors` is typed `string[]` — the dialog is a
 * generic component and does not know this vocabulary — so the narrowing
 * happens here rather than at the call site.
 */
export function customFieldOptionColorFromDialogClass(
  colorClass: string | undefined
): CustomFieldOptionColor | undefined {
  if (colorClass === undefined) {
    return;
  }
  const known = (TABLE_FIELD_OPTION_COLORS as readonly string[]).includes(
    colorClass
  );
  return known
    ? DIALOG_COLOR_CLASS_IDS[colorClass as TableFieldOptionColorClass]
    : undefined;
}

/**
 * The palette class for a stored colour this build RECOGNISES, or `undefined`
 * for everything else — including `none`.
 *
 * For a renderer that also accepts a raw CSS colour. `custom_field_enum_options.color`
 * is an unconstrained string server-side, so a row can hold `#ff0000`; narrowing
 * such a renderer to this palette would drop a colour it shows today. Returning
 * `undefined` lets the caller keep its existing path for anything unrecognised
 * — and `none` stays there deliberately, so an option with no colour renders no
 * dot rather than gaining a grey one it never had.
 */
export function knownCustomFieldOptionColorClass(
  stored: string | null | undefined
): string | undefined {
  if (!stored) {
    return;
  }
  const resolved = isCustomFieldOptionColor(stored)
    ? stored
    : customFieldOptionColorFromDialogClass(stored);
  if (resolved === undefined || resolved === CustomFieldOptionColor.None) {
    return;
  }
  return CUSTOM_FIELD_OPTION_COLOR_CLASSES[resolved];
}

/**
 * A persisted `color` read back as a canonical id.
 *
 * Rows written before ISS-8215 carry the dialog's Tailwind class instead of an
 * id, so the class spellings are accepted as a compatibility alias and resolve
 * to the colour the author actually picked. Anything else — an id this build
 * does not know, a value from a newer peer — falls back to `None`, which is the
 * grey the renderer already showed rather than a throw or a wrong colour.
 */
export function resolveCustomFieldOptionColor(
  stored: string | null | undefined
): CustomFieldOptionColor {
  if (!stored) {
    return CustomFieldOptionColor.None;
  }
  if (isCustomFieldOptionColor(stored)) {
    return stored;
  }
  return (
    customFieldOptionColorFromDialogClass(stored) ?? CustomFieldOptionColor.None
  );
}
