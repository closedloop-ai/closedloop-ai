"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Calendar } from "@repo/design-system/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { CalendarRangeIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  acceptSessionCustomDateWindow,
  formatSessionCustomDateWindow,
  fromLocalCalendarDate,
  MAX_SESSION_CUSTOM_WINDOW_DAYS,
  type SessionCustomDateWindow,
  toLocalCalendarDate,
} from "../../lib/session-custom-date-window";

/**
 * FEA-4201 — the Sessions listing's explicit from/to window, as a control.
 *
 * Sits beside the rolling-preset pills rather than inside them: the presets are
 * a single-select segmented control whose every option is a lookback, and an
 * option that opens a calendar instead of selecting a window would make the
 * group's selected state mean two different things. Keeping it a sibling also
 * keeps `DateRangeFilter` — shared with Branches, Insights and the Agents
 * workspace — untouched.
 *
 * The active window is stated in WORDS on the trigger, never by styling alone,
 * so which of the two controls is deciding the rows is legible without relying
 * on color (WCAG 1.4.1). Both the trigger and the clear control are real
 * `<Button>`s, so each is tab-reachable and operable from the keyboard with the
 * design system's own focus treatment rather than a hand-rolled one.
 *
 * The other half of that legibility is NOT here: while this window is in charge
 * the preset group must render nothing selected, or the toolbar shows a filled
 * "30d" pill over rows that are Jan 1-8 and the filled pill is the louder claim.
 * `SessionsToolbar` owns that, because only the host knows both values.
 */
export function SessionsCustomRangeControl({
  value,
  onChange,
}: {
  /** The active explicit window, or `null` when a rolling preset is in charge. */
  value: SessionCustomDateWindow | null;
  /** `null` clears the window and hands the listing back to the preset. */
  onChange: (window: SessionCustomDateWindow | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CalendarSelection | undefined>(undefined);
  const selection = draft ?? toCalendarSelection(value);

  // The window this selection would name, and whether the CONTRACT accepts it.
  // `acceptSessionCustomDateWindow` is the same acceptance
  // `parseSessionCustomDateWindowParams` applies to the params on the way back
  // in, so an offered Apply and a surviving window are one question rather than
  // two that can disagree.
  const pendingWindow = toPendingWindow(selection);
  const applicableWindow =
    pendingWindow === null
      ? null
      : acceptSessionCustomDateWindow(pendingWindow);
  // Both bounds chosen, and the contract still refuses them — the only reachable
  // cause here is a span past the maximum, since the calendar cannot report an
  // inverted range.
  const isOverMaximumSpan = pendingWindow !== null && applicableWindow === null;

  const handleApply = () => {
    if (applicableWindow === null) {
      return;
    }
    onChange(applicableWindow);
    setDraft(undefined);
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-1">
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setDraft(undefined);
          }
        }}
        open={open}
      >
        <PopoverTrigger asChild>
          {/* The accessible name is STABLE and always says what the control is.
              Swapping the visible label for the window it holds is right for the
              eye, but letting the name go with it leaves a screen reader with a
              date and a button and nothing that says which filter it is. */}
          <Button
            aria-label={
              value === null
                ? undefined
                : `Custom date range: ${formatSessionCustomDateWindow(value)}`
            }
            size="sm"
            variant="outline"
          >
            <CalendarRangeIcon aria-hidden="true" />
            {value === null ? "Custom" : formatSessionCustomDateWindow(value)}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            autoFocus
            // Reopen on the window that is in effect, not on today: a viewer
            // adjusting a January drill-down should not have to page back eight
            // months to see what they are adjusting.
            defaultMonth={selection?.from}
            mode="range"
            // One month, not two. The DS calendar stacks its months vertically
            // below the `md` VIEWPORT breakpoint, so a two-month popover is
            // ~600px tall in a narrow Electron window with nothing to scroll it;
            // crossing a month boundary costs one nav click instead.
            numberOfMonths={1}
            onSelect={setDraft}
            selected={selection}
          />
          {/* An explicit commit, not select-and-close. The calendar reports a
              first click as a one-day range, so closing on selection would
              apply a single-day window the moment a user reached for the first
              end of a longer one — and they would have to reopen the control to
              discover that is what happened. */}
          {/* The refusal is stated, never just enacted. A disabled Apply with
              no reason beside it reads as a broken control, and a native
              disabled button is not focusable, so `aria-describedby` on it
              would never be announced. The region is ALWAYS mounted and only
              its text changes, which is what makes a polite live region
              actually announce rather than silently appear. */}
          <div className="flex items-center justify-end gap-2 border-t p-2">
            <p
              className="mr-auto text-destructive text-xs empty:hidden"
              role="status"
            >
              {isOverMaximumSpan
                ? `Choose ${MAX_SESSION_CUSTOM_WINDOW_DAYS} days or fewer.`
                : ""}
            </p>
            <Button
              disabled={applicableWindow === null}
              onClick={handleApply}
              size="sm"
              type="button"
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {value === null ? null : (
        <Button
          aria-label={`Clear custom date range ${formatSessionCustomDateWindow(value)}`}
          onClick={() => onChange(null)}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/**
 * The calendar's own range shape, declared structurally rather than imported.
 *
 * `react-day-picker` is a transitive dependency of `@repo/design-system`, not a
 * dependency of this package, and adding one just to name a two-field object
 * would couple every consumer of `@repo/app` to the calendar's version. Declared
 * here it stays assignable to the `Calendar` props by structure.
 */
type CalendarSelection = { from: Date | undefined; to?: Date | undefined };

/**
 * The two calendar days a selection names, or `null` until BOTH ends exist.
 *
 * Narrowing here rather than casting at the call site is what lets the encoder
 * take real `Date`s: the calendar's own range type leaves `to` optional, and a
 * half-open selection is not a window this control may apply.
 */
function toPendingWindow(
  selection: CalendarSelection | undefined
): SessionCustomDateWindow | null {
  if (selection?.from === undefined || selection.to === undefined) {
    return null;
  }
  return {
    from: fromLocalCalendarDate(selection.from),
    to: fromLocalCalendarDate(selection.to),
  };
}

function toCalendarSelection(
  window: SessionCustomDateWindow | null
): CalendarSelection | undefined {
  if (window === null) {
    return undefined;
  }
  const from = toLocalCalendarDate(window.from);
  return from === undefined
    ? undefined
    : { from, to: toLocalCalendarDate(window.to) };
}
