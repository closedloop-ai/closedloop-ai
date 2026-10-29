"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";

/**
 * `Name` is inferred from the palette the caller passes, so a palette of
 * `TagColor`s hands `onSelect` a `TagColor` rather than a bare `string`
 * (ISS-6385). Defaults to `string`, so an untyped palette behaves as before.
 */
export type ColorSwatch<Name extends string = string> = {
  /** Stable identifier passed back to `onSelect`. */
  name: Name;
  /** Tailwind background class rendered for the swatch (e.g. `bg-red-500`). */
  colorClass: string;
};

export type ColorSwatchPickerProps<Name extends string = string> = {
  /** Swatches rendered in the popover grid. */
  palette: readonly ColorSwatch<Name>[];
  /** Background class shown inside the trigger button. */
  triggerColorClass: string;
  /** Accessible label for the trigger button. */
  triggerLabel: string;
  /** Swatch `name` that should display the active ring, or `null` for none. */
  selectedName: Name | null;
  /** Invoked with the selected swatch `name`. */
  onSelect: (name: Name) => void;
  /** Number of grid columns in the popover. */
  columns: number;
  disabled?: boolean;
};

/**
 * Generic popover swatch picker shared by the custom-field and tag color
 * pickers. Callers own their palette, value type, and any "clear"/null
 * mapping; this primitive only renders the trigger + swatch grid.
 */
export function ColorSwatchPicker<Name extends string = string>({
  palette,
  triggerColorClass,
  triggerLabel,
  selectedName,
  onSelect,
  columns,
  disabled,
}: Readonly<ColorSwatchPickerProps<Name>>) {
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          aria-label={triggerLabel}
          className="flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled}
          type="button"
        >
          <span className={cn("h-4 w-4 rounded-full", triggerColorClass)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <ColorSwatchGrid
          columns={columns}
          onSelect={onSelect}
          palette={palette}
          selectedName={selectedName}
        />
      </PopoverContent>
    </Popover>
  );
}

export type ColorSwatchGridProps<Name extends string = string> = Pick<
  ColorSwatchPickerProps<Name>,
  "palette" | "selectedName" | "onSelect" | "columns"
>;

/**
 * The swatch grid on its own, without {@link ColorSwatchPicker}'s trigger and
 * popover (ISS-6385).
 *
 * A surface that is ALREADY inside a popover — the `generic-artifact`
 * prototype's create-a-tag flow, which reveals the colour choice in the tag
 * editor it is standing in — cannot nest a second one, and used to hand-roll
 * this grid against its own palette rather than nest. One grid, both callers,
 * so the swatch size, ring, and selected affordance cannot drift apart.
 *
 * Each swatch is named by its colour, so the choice is reachable and announced
 * by name rather than by hue alone (WCAG 1.4.1).
 */
export function ColorSwatchGrid<Name extends string = string>({
  palette,
  selectedName,
  onSelect,
  columns,
}: Readonly<ColorSwatchGridProps<Name>>) {
  return (
    <div
      className="grid gap-1"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      }}
    >
      {palette.map(({ name, colorClass }) => (
        <button
          aria-label={name}
          className={cn(
            "h-5 w-5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            colorClass,
            selectedName === name && "ring-2 ring-ring ring-offset-1"
          )}
          key={name}
          onClick={() => onSelect(name)}
          type="button"
        />
      ))}
    </div>
  );
}
