"use client";

import { GRID_NAV_CELL_ROLE } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { cn } from "@closedloop-ai/design-system/lib/utils";

/** Domain-free live feedback rendered beside an inline editing control. */
export function InlineEditFeedback({
  alignEnd = false,
  className,
  id,
  message,
  truncate = false,
}: Readonly<InlineEditFeedbackProps>) {
  return (
    <span
      className={cn(
        INLINE_EDIT_FEEDBACK_CLASS,
        // One ellipsized line with the full sentence in `title`: operator
        // ruling, Daveth Oakhurst, 2026-10-20 (PRD-722 manual QA, HUMAN-1 and
        // HUMAN-2).
        // `leading-4`, not `leading-none`: a one-line box clips descenders.
        truncate && "truncate leading-4",
        alignEnd && "text-right",
        className
      )}
      id={id}
      role="alert"
      title={truncate ? message : undefined}
    >
      {message}
    </span>
  );
}

export type InlineEditFeedbackProps = {
  /** The adapter-owned message announced to assistive technology. */
  message: string;
  /** Connects the message to its control through `aria-describedby`. */
  id?: string;
  /** Follows a right-aligned field in numeric columns. */
  alignEnd?: boolean;
  /**
   * Holds the message to one line under a grid-height field; the `title` gives
   * the full sentence back when it truncates.
   */
  truncate?: boolean;
  className?: string;
};

/**
 * Restores an inline control only while focus is still owned by that edit:
 * nothing holds focus, the control does, or focus sits on the grid cell or row
 * that contains it (a grid moves focus to the cell on Enter before the
 * refusal lands). Async persistence must not pull a user back from a different
 * control or cell.
 */
export function refocusInlineEditControlIfOwned(
  control: HTMLElement | null
): boolean {
  if (!control) {
    return false;
  }
  const { activeElement, body } = control.ownerDocument;
  if (
    activeElement !== null &&
    activeElement !== body &&
    activeElement !== control &&
    !isOwningGridContainer(activeElement, control)
  ) {
    return false;
  }
  control.focus();
  return control.ownerDocument.activeElement === control;
}

function isOwningGridContainer(element: Element, control: HTMLElement) {
  return (
    element === control.closest(OWNING_CELL_SELECTOR) ||
    element === control.closest(OWNING_ROW_SELECTOR)
  );
}

const OWNING_CELL_SELECTOR = `[role="${GRID_NAV_CELL_ROLE}"]`;
const OWNING_ROW_SELECTOR = '[role="row"]';

/**
 * The message's own type and colour, exported so the theme contrast sweep
 * measures the class that ships. `font-normal`: a host may render the field
 * inside a heading (Session detail's `<h1>`), whose weight the message must
 * not inherit.
 */
export const INLINE_EDIT_FEEDBACK_CLASS =
  "font-normal text-destructive text-xs";
