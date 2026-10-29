"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { format, isValid, parse } from "date-fns";
import { useEffect, useId, useRef, useState } from "react";
import { CHIP_FOCUS_RING_CLASS } from "./chip";
import { DatePickerPopover } from "./date-picker-popover";
import { GridEmptyValue } from "./grid-table-card";
import {
  assertInlineEditFailureBehavior,
  type InlineEditFailureBehavior,
} from "./inline-edit-failure-behavior";
import {
  InlineEditFeedback,
  refocusInlineEditControlIfOwned,
} from "./inline-edit-feedback";
import { INVALID_STATE_UTILITIES } from "./invalid-state";
import { useCommitLedger } from "./use-commit-ledger";

/** The wire shape of a date scalar. Local-calendar, never an instant. */
const ISO_DATE_FORMAT = "yyyy-MM-dd";

/**
 * The `date` branch of {@link InlineScalarCell} — reached through
 * `type="date"`, which is the entry point callers use.
 *
 * **It delegates to `DatePickerPopover`, deliberately.** A native
 * `<input type="date">` ships the browser's own calendar: unstyled,
 * untokenized, differently shaped per platform, and unreachable by the design
 * system. `DueDateCell` (`packages/app/documents/components/table/cells/
 * edit-cells.tsx`) already reached for the popover for exactly that reason and
 * is the reference this follows.
 *
 * **Dismissal is not a commit.** The text branch needs `cancelingRef` because
 * Escape reverts and then blurs THROUGH THE COMMIT PATH; a popover has no such
 * race, because there is no draft and no blur-commit — `onCommit` is reachable
 * only from an actual calendar selection or an explicit clear. Escape, an
 * outside click, and a re-focus therefore write nothing by construction rather
 * than by an interlock. That is a different mechanism for the same promise, and
 * it is pinned by its own test.
 *
 * **There is no same-value guard, deliberately.** Ordinarily the picker's
 * `mode="single"` toggles the selected day to clear. After a refused save the
 * picker keeps the confirmed day selected while the trigger shows the failed
 * day, so selecting that failed day again is a retry rather than a clear.
 *
 * With the explicit retained-failure policy, a refused commit keeps the
 * selected day visibly marked as unsaved while the shared ledger retains the
 * previous confirmed day. A later selection retries; Escape restores the
 * confirmation. Compatibility callers restore it immediately.
 *
 * `value` is an ISO `yyyy-MM-dd` calendar day, parsed and formatted in LOCAL
 * time. `new Date("2026-08-17")` would parse as UTC midnight and render as the
 * 16th anywhere west of Greenwich, which is how a due date silently moves a day.
 */
export function InlineDateCell({
  value,
  onCommit,
  label,
  readOnly = false,
  alignEnd = false,
  dateFormat = "MMM d, yyyy",
  className,
  saveErrorMessage,
  retainRejectedDraft = false,
  onFailureCleared,
  maxDate,
}: Readonly<InlineDateCellProps>) {
  assertInlineEditFailureBehavior(retainRejectedDraft, saveErrorMessage);
  const [shown, setShown] = useState(value);
  const [saveFailed, setSaveFailed] = useState(false);
  const saveErrorMessageId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const failedDraftRef = useRef<string | null>(null);
  const ledger = useCommitLedger(value);

  // A committed value that changes underneath us (another user, a refetch) is
  // authoritative: it replaces what is on screen and outranks every commit in
  // flight, so a late rejection cannot roll it back. While a refused day is
  // retained, the scalar cell's rule applies instead: the ledger records the
  // new value for Escape and the picker, but the failed day and its error
  // stay, so a host rolling back its optimistic patch after the refusal
  // settled cannot erase the message.
  useEffect(() => {
    ledger.reset(value);
    if (failedDraftRef.current !== null) {
      return;
    }
    setSaveFailed(false);
    setShown(value);
  }, [value, ledger]);

  const selected = parseIsoDate(shown);
  const pickerSelected = parseIsoDate(
    failedDraftRef.current === null ? shown : ledger.current()
  );
  const formatted = selected ? format(selected, dateFormat) : null;

  if (readOnly) {
    if (!formatted) {
      return <GridEmptyValue alignEnd={alignEnd} title={`No ${label}`} />;
    }
    return (
      <span className={cn("truncate text-sm", alignEnd && "ml-auto", className)}>
        {formatted}
      </span>
    );
  }

  const trigger = (
    <button
      aria-describedby={
        saveFailed && saveErrorMessage ? saveErrorMessageId : undefined
      }
      aria-invalid={saveFailed || undefined}
      // A date button reading "Aug 17, 2026" does not say WHAT it dates, and an
      // empty one is a bare em-dash naming nothing at all (WCAG 2.4.6). The
      // filled name contains the visible text, so speech input still reaches it
      // by what is on screen (WCAG 2.5.3). Radix supplies `aria-expanded` and
      // `aria-haspopup` on the trigger.
      aria-label={formatted ? `${label}: ${formatted}` : `Set ${label}`}
      className={cn(
        // Same box as the text branch, so a date column and a text column line
        // up and the empty cell clears the 24px minimum target (WCAG 2.5.8).
        "flex h-7 w-full items-center rounded-md px-1.5 text-left text-sm hover:bg-muted",
        CHIP_FOCUS_RING_CLASS,
        alignEnd && "justify-end",
        // Only while failed, so a resting trigger keeps its exact box; the
        // text branch's Input paints the same treatment from its own border.
        saveFailed && ["border", INVALID_STATE_UTILITIES],
        className
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || failedDraftRef.current === null) {
          return;
        }
        event.preventDefault();
        failedDraftRef.current = null;
        setSaveFailed(false);
        setShown(ledger.current());
        onFailureCleared?.();
      }}
      ref={triggerRef}
      type="button"
    >
      {formatted ?? <GridEmptyValue title={`Set ${label}`} />}
    </button>
  );

  return (
    <div className="flex w-full min-w-0 flex-col">
      <DatePickerPopover
        dateFormat={dateFormat}
        onSelect={(date) => {
          if (failedDraftRef.current !== null && date === null) {
            failedDraftRef.current = null;
            setSaveFailed(false);
            setShown(ledger.current());
            onFailureCleared?.();
            return;
          }
          const next = date ? format(date, ISO_DATE_FORMAT) : "";
          failedDraftRef.current = null;
          setSaveFailed(false);
          setShown(next);
          ledger.submit(
            next,
            onCommit,
            (resolved) => {
              if (failedDraftRef.current !== null) {
                refocusInlineEditControlIfOwned(triggerRef.current);
                return;
              }
              setShown(resolved);
            },
            ({ accepted, authoritative, submitted }) => {
              if (accepted && authoritative) {
                failedDraftRef.current = null;
                setSaveFailed(false);
              } else if (authoritative && retainRejectedDraft) {
                failedDraftRef.current = submitted;
                setSaveFailed(true);
                refocusInlineEditControlIfOwned(triggerRef.current);
              }
            }
          );
        }}
        toDate={parseIsoDate(maxDate ?? "") ?? undefined}
        trigger={trigger}
        value={pickerSelected}
      />
      {saveFailed && saveErrorMessage ? (
        <InlineEditFeedback
          alignEnd={alignEnd}
          id={saveErrorMessageId}
          message={saveErrorMessage}
          truncate
        />
      ) : null}
    </div>
  );
}

export type InlineDateCellProps = {
  /** The committed day as ISO `yyyy-MM-dd`. An empty string is "no date". */
  value: string;
  /**
   * Called only when the user picks a day different from `value`, or clears it
   * (`""`). Signal a refusal with a rejected promise or thenable, or a
   * synchronous throw. With the explicit retained-draft policy, the rejected
   * day remains visibly failed for retry and Escape restores confirmation;
   * compatibility callers restore confirmation immediately.
   */
  onCommit: (next: string) => Promise<unknown> | void;
  /** What is being dated ("Due date", "Target"). Names the control. */
  label: string;
  /** Renders the formatted day as plain text with no control. */
  readOnly?: boolean;
  /** Right-align under a right-flush column. */
  alignEnd?: boolean;
  /** How the committed day reads on screen. The wire shape stays ISO. */
  dateFormat?: string;
  className?: string;
  /** Called when a retained failed day returns to the confirmed value. */
  onFailureCleared?: () => void;
  /**
   * The last ISO `yyyy-MM-dd` day the picker offers; later days render
   * disabled. For a host whose storage stops at a year (a custom-field date
   * stops at 9999-12-31).
   */
  maxDate?: string;
} & InlineEditFailureBehavior;

/**
 * `null` for an empty or unparseable stored value. Parsed against a local
 * reference date so `yyyy-MM-dd` stays the calendar day it names.
 */
function parseIsoDate(value: string): Date | null {
  if (!value) {
    return null;
  }
  const parsed = parse(value, ISO_DATE_FORMAT, new Date());
  return isValid(parsed) ? parsed : null;
}
