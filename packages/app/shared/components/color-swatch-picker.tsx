"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";

export type ColorSwatch = {
  /** Stable identifier passed back to `onSelect`. */
  name: string;
  /** Tailwind background class rendered for the swatch (e.g. `bg-red-500`). */
  colorClass: string;
};

export type ColorSwatchPickerProps = {
  /** Swatches rendered in the popover grid. */
  palette: readonly ColorSwatch[];
  /** Background class shown inside the trigger button. */
  triggerColorClass: string;
  /** Accessible label for the trigger button. */
  triggerLabel: string;
  /** Swatch `name` that should display the active ring, or `null` for none. */
  selectedName: string | null;
  /** Invoked with the selected swatch `name`. */
  onSelect: (name: string) => void;
  /** Number of grid columns in the popover. */
  columns: number;
  disabled?: boolean;
};

/**
 * Generic popover swatch picker shared by the custom-field and tag color
 * pickers. Callers own their palette, value type, and any "clear"/null
 * mapping; this primitive only renders the trigger + swatch grid.
 */
export function ColorSwatchPicker({
  palette,
  triggerColorClass,
  triggerLabel,
  selectedName,
  onSelect,
  columns,
  disabled,
}: Readonly<ColorSwatchPickerProps>) {
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
      </PopoverContent>
    </Popover>
  );
}
