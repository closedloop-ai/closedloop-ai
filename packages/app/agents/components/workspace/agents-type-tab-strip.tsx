"use client";

/**
 * ISS-4803: the Agents workspace type quick-filter strip.
 *
 * Extracted from `AgentsGroupedList`, which owned this markup inline. It renders
 * the same segmented control it always has — `All` plus one segment per core
 * kind — inside the shared `ScrollFadeTrack`, and adds the overflow disclosure
 * the strip has been missing since FEA-4019 grew it to eight segments.
 *
 * The defect this closes: at a phone width only the leading few segments fit.
 * The track scrolls, and its edge fade says something is cut off, but a fade is
 * a hint rather than a control — and the strip is a Radix `ToggleGroup`, a
 * roving-tabindex widget that is ONE tab stop, so Tab does not step through the
 * segments either. The trailing kinds were reachable only by arrowing blind
 * inside a control that never announced there was more.
 *
 * With `overflowMenuEnabled` the strip fits itself to the row's MEASURED width
 * and collapses whatever does not fit behind a real focusable menu whose
 * accessible name lists the hidden kinds. Measured, not a breakpoint: this
 * component mounts on the web route and in the resizable desktop window, and a
 * viewport media query says nothing about the width this row actually got.
 *
 * With the flag off it renders every segment, exactly as it ships today.
 *
 * Domain component: lives in this feature slice, NOT in @closedloop-ai/design-system.
 */

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { ScrollFadeTrack } from "../../../shared/components/scroll-fade-track";
import { fitTypeTabs } from "../../lib/agents-type-tab-fit";

/** One segment of the type strip. */
export type AgentsTypeTabOption = {
  /** The `ToggleGroup` value this segment selects. */
  value: string;
  /** Visible text AND accessible name — the two must not drift. */
  label: string;
  /** The kind's canonical icon, from `kindMeta`. */
  icon: LucideIcon;
};

export type AgentsTypeTabStripProps = Readonly<{
  /** Segments in render order; the caller owns the order and the vocabulary. */
  options: readonly AgentsTypeTabOption[];
  /** Currently selected segment value. */
  value: string;
  /**
   * Called with the newly selected value. The `ToggleGroup` fires with the empty
   * string when the active segment is re-clicked, and that is forwarded as-is —
   * the caller already owns what "deselected" means for this strip.
   */
  onValueChange: (value: string) => void;
  /**
   * ISS-4803, default OFF (ISS-4779 closed-by-default). When on, segments that
   * do not fit the measured row collapse into the overflow menu; when off every
   * segment is rendered on the strip and only the scroll track clips them.
   */
  overflowMenuEnabled?: boolean;
}>;

/**
 * The Agents type quick-filter strip, with the ISS-4803 overflow disclosure.
 */
export function AgentsTypeTabStrip({
  options,
  value,
  onValueChange,
  overflowMenuEnabled = false,
}: AgentsTypeTabStripProps) {
  // Measured on the ROW, not on the scrolling track inside it: the row's content
  // width is independent of whether the overflow control is rendered, so the fit
  // cannot feed its own output back into its input and oscillate at the
  // threshold. `measured` guards against adapting to the wide SSR default.
  const { ref, width, measured } = useContainerWidth<HTMLDivElement>();
  // `fitTypeTabs` owns BOTH halves — the leading-run measurement and the
  // re-check after the active tab is pinned into the last visible slot. Doing
  // the two separately let a wide selected tab overflow the row it had just
  // been measured into (see the function's own note).
  const { visible, overflow } = fitTypeTabs(
    options,
    overflowMenuEnabled && measured ? width : Number.NaN,
    (option) => option.value === value,
    (option) => option.label
  );

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b px-4 pt-3"
      ref={ref}
    >
      <ScrollFadeTrack>
        <ToggleGroup
          aria-label="Component type"
          onValueChange={onValueChange}
          type="single"
          value={value}
          variant="outline"
        >
          {visible.map((option) => (
            <ToggleGroupItem
              aria-label={option.label}
              key={option.value}
              value={option.value}
            >
              <option.icon className="size-4" />
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ScrollFadeTrack>
      {overflow.length > 0 ? (
        <AgentsTypeTabOverflowMenu
          onValueChange={onValueChange}
          options={overflow}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The overflow disclosure: a real `<button>` opening a menu of the segments the
 * strip could not fit.
 *
 * A menu rather than a popover of buttons because these are mutually exclusive
 * selections, and `DropdownMenu` brings the keyboard contract for that for free
 * — Enter/Space to open, arrows to move, Enter to choose, Escape to dismiss —
 * which is the whole point of the ticket: the hidden kinds have to be reachable
 * without a pointer.
 *
 * Plain items rather than a radio group even though the strip is single-select:
 * `partitionTypeTabs` guarantees the ACTIVE segment always keeps a visible slot,
 * so no item in this menu is ever the selected one, and rendering a radio group
 * with nothing checked would state something false about the strip's state.
 */
function AgentsTypeTabOverflowMenu({
  options,
  onValueChange,
}: Readonly<{
  options: readonly AgentsTypeTabOption[];
  onValueChange: (value: string) => void;
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* `h-7 text-xs` is the delta from `size="sm"` that puts this on the
            strip's own scale: the outline `ToggleGroupItem`s beside it are 28px
            tall with 12px labels, and a 32px/14px button next to them reads as a
            mistake rather than as their counter. Same correction ISS-5282 took
            on the Sessions overflow chip (review cid 3731458708). The `size-4`
            chevron matches the tabs' own kind icons rather than the `sm`
            variant's 14px default, for the same reason. */}
        <Button
          aria-label={overflowAriaLabel(options.map((option) => option.label))}
          className="h-7 shrink-0 text-xs"
          size="sm"
          variant="ghost"
        >
          {`+${options.length}`}
          <ChevronDownIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onValueChange(option.value)}
          >
            <option.icon className="size-4" />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Accessible name for the overflow control. `+4` announced alone is not a fact
 * anybody can act on, and the menu naming the hidden kinds is behind an
 * activation a screen-reader user has to choose to make — so the button's own
 * name carries the same list the menu does. Mirrors ISS-5282's
 * `overflowAriaLabel` on the Sessions `Signals` cell so the two overflow
 * affordances in this feature announce themselves the same way. Customer-facing
 * text, so a plain comma-joined list and no em dash.
 */
function overflowAriaLabel(labels: readonly string[]): string {
  return `${labels.length} more component types: ${labels.join(", ")}`;
}
