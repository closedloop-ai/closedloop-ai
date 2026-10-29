"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { TableBulkActionBarInFlowContext } from "@closedloop-ai/design-system/lib/table-bulk-action-bar-layout";
import { type ReactNode, useContext } from "react";
import { type CountNoun, pluralize } from "@closedloop-ai/design-system/lib/count-noun";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export function TableBulkActionBar({
  actionLabel,
  actions,
  className,
}: {
  actionLabel: string;
  actions: ReactNode;
  className?: string;
}) {
  const inFlow = useContext(TableBulkActionBarInFlowContext);
  // In flow, from `md` up the rail sits in its own band with the pagination
  // band's padding; below `md` it floats like every other bar, so a phone list
  // loses no height to it (operator ruling on the ISS-12305 iPhone retest).
  // Floating, the wrapper is `contents` so the bar positions against the
  // viewport. The same elements either way, so a mode change never remounts
  // the toolbar under the reader's focus.
  return (
    <div
      className={
        inFlow
          ? "contents md:flex md:shrink-0 md:justify-center md:px-4 md:py-3"
          : "contents"
      }
    >
      <div
        // Named, so a screen-reader user who Tabs in is told what the toolbar
        // acts on before they hear the first button. NOT `aria-live`
        // (ISS-9574): this bar is mounted conditionally by every host, so it is
        // absent at the two moments its count matters most, and a second live
        // region saying the same sentence as {@link TableSelectionAnnouncer}
        // announces it twice. The artifact surface's own bar already carries
        // this note verbatim.
        aria-label={actionLabel}
        className={cn(
          "z-50 flex h-14 items-center overflow-x-auto rounded-xl bg-foreground px-2 text-background shadow-lg md:gap-1 md:rounded-full md:px-4",
          inFlow
            ? "fixed bottom-16 left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:relative md:bottom-auto md:left-auto md:max-w-full md:translate-x-0"
            : "fixed bottom-16 left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 md:bottom-8",
          className
        )}
        role="toolbar"
      >
        <span className="shrink-0 whitespace-nowrap px-2 font-medium text-xs md:min-w-44 md:px-3 md:text-sm">
          {actionLabel}
        </span>
        {actions}
      </div>
    </div>
  );
}

export function TableBulkActionButton({
  children,
  className,
  disabled,
  label,
  onClick,
  pressed,
}: {
  children: ReactNode;
  className?: string;
  /** This action's own mutation is in flight — never "unavailable here". */
  disabled?: boolean;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-pressed={pressed}
          className={cn(TABLE_BULK_ACTION_BUTTON_CLASS_NAME, className)}
          disabled={disabled}
          onClick={onClick}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export const TABLE_BULK_ACTION_BUTTON_CLASS_NAME =
  "flex size-10 shrink-0 items-center justify-center rounded-full text-background/85 transition-colors hover:bg-background/10 hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/70 disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-[18px]";

/**
 * The selected-count statement that SURVIVES the bar (ISS-9574).
 *
 * {@link TableBulkActionBar} USED to be the live region and is no longer, which
 * is the whole reason this exists: a live region announces only what changes
 * while it is ALREADY in the document, and every host mounts that bar
 * conditionally on having a selection worth acting on. So the two moments a
 * reader most needs told were the two the bar could not tell them — its first
 * appearance, and its disappearance when the selection empties or when a
 * filter, a page change or an arriving row drops the selection below the host's
 * threshold. That last one is the point: a selection can shrink without the
 * reader touching a row.
 *
 * Render it beside the bar, unconditionally, wherever the host has a selection
 * to state at all. `sr-only`, because the bar already says the same count on
 * screen — this is the one statement in the accessibility tree that CHANGES,
 * and leaving the bar live as well would announce every change twice.
 */
export function TableSelectionAnnouncer({
  count,
  noun,
}: {
  count: number;
  /**
   * What one row IS. {@link CountNoun}, the shape every other counted surface in
   * this package already declares — not a tuple, so `.other` reads as the plural
   * rather than an index, and an invariant noun can be a bare string.
   */
  noun: CountNoun;
}) {
  const announcement =
    count === 0
      ? `No ${pluralize(noun, 0)} selected`
      : `${count} ${pluralize(noun, count)} selected`;
  // `<output>` carries an implicit `role="status"` — polite, so a selection
  // the reader made themselves never interrupts them mid-sentence.
  return (
    <output
      aria-label={announcement}
      aria-live="polite"
      className="sr-only"
    >
      {announcement}
    </output>
  );
}
