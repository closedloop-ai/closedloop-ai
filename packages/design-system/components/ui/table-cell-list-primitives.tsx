"use client";

import type { ElementType } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  avatarInitial,
} from "./avatar";
import { Chip } from "./chip";
import { GridEmptyValue } from "./grid-table-card";
import {
  getTableCellPrimitiveStateAttributes,
  getTableCellPrimitiveStateClassName,
  getTableCellPrimitiveStateValue,
  type TableCellPrimitiveStateProps,
} from "./table-cell-primitives";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { Link } from "@repo/navigation/link";

const CELL_ITEM_GAP_PX = 4;
const CELL_OVERFLOW_WIDTH_PX = 30;

export type TableChoice = {
  className?: string;
  id: string;
  label: string;
};

/**
 * A chip carries at most ONE interaction arm. `ReferenceChip` tests `onSelect`
 * before `href`, so a reference naming both would render the action and drop
 * the destination out of the DOM entirely — the union makes that value
 * unconstructible instead of leaving the precedence to be discovered.
 */
export type TableReferenceInteraction =
  | { href?: string; onSelect?: never }
  | { href?: never; onSelect?: () => void };

export type TableReference = {
  avatarUrl?: string;
  className?: string;
  icon?: ElementType;
  id: string;
  initials?: string;
  label: string;
  tooltip?: string;
} & TableReferenceInteraction;

export function TableChoiceListCell({
  choices,
  disabled,
  errorLabel,
  focusVisible,
  loadingLabel,
  selected,
  state,
}: {
  choices: readonly TableChoice[];
} & TableCellPrimitiveStateProps) {
  const stateValue = getTableCellPrimitiveStateValue({
    disabled,
    errorLabel,
    focusVisible,
    loadingLabel,
    selected,
    state,
  });
  const fit = useMeasuredCellItems(
    choices.map((choice) => choice.id),
    stateValue == null
  );
  if (stateValue) {
    return stateValue;
  }
  if (choices.length === 0) {
    return (
      <GridEmptyValue
        disabled={disabled}
        focusVisible={focusVisible}
        selected={selected}
      />
    );
  }
  const visibleChoices = choices.slice(0, fit.visibleCount);
  const hiddenChoices = choices.slice(fit.visibleCount);
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        "relative flex w-full min-w-0 items-center gap-1 overflow-hidden",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      ref={fit.containerRef}
      {...stateAttributes}
    >
      {visibleChoices.map((choice) => (
        <ChoiceChip choice={choice} key={choice.id} />
      ))}
      <CellOverflow labels={hiddenChoices.map((choice) => choice.label)} />
      <span
        aria-hidden
        className="pointer-events-none absolute flex items-center gap-1 opacity-0"
      >
        {choices.map((choice, index) => (
          <ChoiceChip
            choice={choice}
            key={choice.id}
            measureRef={(element) => {
              fit.measurementRefs.current[index] = element;
            }}
          />
        ))}
      </span>
    </span>
  );
}

export function TableReferenceListCell({
  references,
  disabled,
  emptyTitle,
  errorLabel,
  focusVisible,
  hiddenReferenceCount = 0,
  loadingLabel,
  selected,
  state,
}: {
  references: readonly TableReference[];
  emptyTitle?: string;
  /**
   * References the caller withheld (a server-side cap) that still count
   * toward the `+N` overflow pill, alongside any references dropped for
   * width. Read only when `references` is non-empty — the empty sentinel
   * above returns before this count matters, so a withheld count paired with
   * zero references renders nothing.
   */
  hiddenReferenceCount?: number;
} & TableCellPrimitiveStateProps) {
  const stateValue = getTableCellPrimitiveStateValue({
    disabled,
    errorLabel,
    focusVisible,
    loadingLabel,
    selected,
    state,
  });
  // A public prop is not a runtime guard: `NaN`, `Infinity` or a fraction would
  // render as a `+NaN` pill or reserve width for nothing.
  const withheldCount = toWithheldCount(hiddenReferenceCount);
  const fit = useMeasuredCellItems(
    references.map((reference) => reference.id),
    stateValue == null,
    withheldCount > 0
  );
  if (stateValue) {
    return stateValue;
  }
  if (references.length === 0) {
    return (
      <GridEmptyValue
        disabled={disabled}
        focusVisible={focusVisible}
        selected={selected}
        title={emptyTitle}
      />
    );
  }
  const visibleReferences = references.slice(0, fit.visibleCount);
  const hiddenReferences = references.slice(fit.visibleCount);
  const stateAttributes = getTableCellPrimitiveStateAttributes({
    disabled,
    focusVisible,
    selected,
  });
  return (
    <span
      className={cn(
        // `pl-1` exactly counters the leftmost ReferenceChip's own avatar
        // `-ml-1` pull (see ReferenceChip below): with zero left padding here,
        // the first avatar's negative margin lands it flush against this
        // container's own edge, right where an inset focus ring is drawn —
        // the ring's square-ish corner then peeks out past the avatar's round
        // edge. ChoiceChip (the sibling list above) has no avatar and no such
        // collision, so this padding is scoped to this function only.
        "relative flex w-full min-w-0 items-center gap-1 overflow-hidden pl-1",
        getTableCellPrimitiveStateClassName({
          disabled,
          focusVisible,
          selected,
        })
      )}
      ref={fit.containerRef}
      {...stateAttributes}
    >
      {visibleReferences.map((reference) => (
        <ReferenceChip
          disabled={disabled}
          key={reference.id}
          reference={reference}
        />
      ))}
      <CellOverflow
        disabled={disabled}
        hiddenCount={withheldCount}
        references={hiddenReferences}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute flex items-center gap-1 opacity-0"
      >
        {references.map((reference, index) => (
          <ReferenceChip
            disabled={disabled}
            key={reference.id}
            measureRef={(element) => {
              fit.measurementRefs.current[index] = element;
            }}
            reference={reference}
          />
        ))}
      </span>
    </span>
  );
}

function ChoiceChip({
  choice,
  measureRef,
}: {
  choice: TableChoice;
  measureRef?: (element: HTMLSpanElement | null) => void;
}) {
  return (
    <Chip
      className={cn("max-w-full shrink-0", choice.className)}
      ref={measureRef}
      variant="outline"
    >
      <span className="truncate">{choice.label}</span>
    </Chip>
  );
}

function ReferenceChip({
  disabled,
  measureRef,
  reference,
}: {
  disabled?: boolean;
  measureRef?: (element: HTMLSpanElement | null) => void;
  reference: TableReference;
}) {
  const Icon = reference.icon;
  const content = (
    <>
      {reference.initials || reference.avatarUrl ? (
        <Avatar className="-ml-1 size-5 shrink-0 border border-current/15 ring-2 ring-background">
          {/*
           * Always mounted, `src` possibly undefined — never conditionally
           * removed from the tree. Radix's `Avatar.Root` context caches
           * `imageLoadingStatus`, and `AvatarImage` only reports a status
           * change while it is mounted; unmounting it after a real picture
           * loaded leaves the Root believing "loaded" forever, so
           * `AvatarFallback` (which renders only while status !== "loaded")
           * never comes back — the avatar goes empty instead of falling back
           * to initials. Keeping `AvatarImage` mounted lets its own
           * `src`-keyed effect report the correct "error" status the moment
           * `avatarUrl` disappears, which is what un-hides the fallback.
           */}
          <AvatarImage alt="" src={reference.avatarUrl} />
          <AvatarFallback className="text-[9px]">
            {avatarInitial(reference.initials ?? "")}
          </AvatarFallback>
        </Avatar>
      ) : null}
      {Icon && !(reference.initials || reference.avatarUrl) ? (
        <Icon aria-hidden className="size-3 shrink-0 opacity-70" />
      ) : null}
      <span
        className={cn(
          "truncate text-xs",
          !(reference.initials || reference.avatarUrl) && "font-mono"
        )}
      >
        {reference.label}
      </span>
    </>
  );
  const className = cn(
    "inline-flex min-w-0 shrink-0 items-center gap-1 border",
    reference.initials || reference.avatarUrl
      ? "h-5 rounded-full py-0 pr-2 pl-1"
      : "rounded-md px-1.5 py-0.5",
    reference.className ?? "bg-muted/50",
    !disabled &&
      (reference.href || reference.onSelect) &&
      "hover:border-foreground/20 hover:text-foreground"
  );
  if (reference.onSelect && !measureRef && !disabled) {
    return (
      <button
        aria-label={referenceTooltipLabel(reference)}
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          reference.onSelect?.();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title={referenceTooltipLabel(reference)}
        type="button"
      >
        {content}
      </button>
    );
  }
  if (reference.href && !measureRef && !disabled) {
    // The navigation PORT, not a raw anchor: `reference.href` is an internal
    // org-relative path, and the desktop renderer has no router — a bare
    // `/sessions/x` there is a document navigation Electron's guard blocks, so
    // the click lands and then hangs instead of routing (FEA-4051). The port's
    // adapter navigates in-app and renders the anchor href its surface can
    // resolve (desktop: a `#/sessions/x` hash), which also keeps
    // modifier/middle-click working on both shells.
    return (
      <Link
        aria-label={referenceTooltipLabel(reference)}
        className={className}
        href={reference.href}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        title={referenceTooltipLabel(reference)}
      >
        {content}
      </Link>
    );
  }
  return (
    <span
      aria-disabled={disabled ? true : undefined}
      className={className}
      ref={measureRef}
      title={referenceTooltipLabel(reference)}
    >
      {content}
    </span>
  );
}

/**
 * The `+N` pill and its tooltip, shared by every width-aware list cell —
 * including `InlineSelectCell`'s multi-select trigger, which collapses the
 * same way a read-only choice list does. Exported so a second cell cannot grow
 * its own overflow vocabulary beside this one.
 */
export function CellOverflow({
  disabled,
  hiddenCount = 0,
  labels = [],
  references = [],
}: {
  disabled?: boolean;
  hiddenCount?: number;
  labels?: readonly string[];
  /**
   * References dropped for width. Each keeps its interaction arm inside the
   * tooltip, so a chip that no longer fits is still reachable from the cell.
   */
  references?: readonly TableReference[];
}) {
  const overflowCount = labels.length + references.length + hiddenCount;
  if (overflowCount === 0) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-5 shrink-0 cursor-default items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
          +{overflowCount}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex flex-col gap-1">
          {labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
          {references.map((reference) => (
            <OverflowReference
              disabled={disabled}
              key={reference.id}
              reference={reference}
            />
          ))}
          {hiddenCount > 0 ? (
            // Copy authored for ISS-9317 (PLN-2060, Fable): no noun, so the
            // primitive stays generic; "not shown" matches the sibling
            // documents cell's overflow suffix.
            <span>{hiddenCount} more not shown here</span>
          ) : null}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * How many of `ids` fit the container at its measured width, re-measured on
 * resize. The caller renders the visible slice plus a {@link CellOverflow} and
 * mirrors the full list into an `aria-hidden` measurement layer.
 */
export function useMeasuredCellItems(
  ids: readonly string[],
  enabled: boolean,
  reserveOverflow = false
) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measurementRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [visibleCount, setVisibleCount] = useState(Math.min(2, ids.length));
  const measurementKey = ids.join("\u0000");

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const updateVisibleCount = () => {
      const widths = measurementRefs.current.map(
        (element) => element?.offsetWidth ?? 0
      );
      let usedWidth = 0;
      let nextVisibleCount = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const gapWidth = nextVisibleCount > 0 ? CELL_ITEM_GAP_PX : 0;
        const isLastIndex = index === widths.length - 1;
        const overflowWidth =
          !isLastIndex || reserveOverflow
            ? CELL_ITEM_GAP_PX + CELL_OVERFLOW_WIDTH_PX
            : 0;
        if (
          usedWidth + gapWidth + widths[index] + overflowWidth >
          container.clientWidth
        ) {
          break;
        }
        usedWidth += gapWidth + widths[index];
        nextVisibleCount += 1;
      }
      setVisibleCount(nextVisibleCount);
    };
    updateVisibleCount();
    const observer = new globalThis.ResizeObserver(updateVisibleCount);
    observer.observe(container);
    return () => observer.disconnect();
  }, [enabled, measurementKey, reserveOverflow]);

  return { containerRef, measurementRefs, visibleCount };
}

function referenceTooltipLabel(reference: TableReference): string {
  return reference.tooltip ?? reference.label;
}

/** A withheld count is a non-negative safe integer or it is zero. */
function toWithheldCount(count: number): number {
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function OverflowReference({
  disabled,
  reference,
}: {
  disabled?: boolean;
  reference: TableReference;
}) {
  const label = referenceTooltipLabel(reference);
  if (reference.onSelect && !disabled) {
    return (
      <button
        className="text-left hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          reference.onSelect?.();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {label}
      </button>
    );
  }
  if (reference.href && !disabled) {
    return (
      <Link
        className="hover:underline"
        href={reference.href}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {label}
      </Link>
    );
  }
  return <span>{label}</span>;
}
