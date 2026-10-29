"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { type ReactNode, useState } from "react";
import { Button } from "./button";
import { CommandList } from "./command";
import { GridEmptyValue } from "./grid-table-card";
import {
  INLINE_CELL_TRIGGER_CLASS,
  InlinePickerContent,
  InlinePickerOption,
} from "./inline-select-cell";
import { Popover, PopoverTrigger } from "./popover";
import { sameOrderedValues, useCommitLedger } from "./use-commit-ledger";
import { useSerializedCommit } from "./use-serialized-commit";

/**
 * The shared grid cell for a LINK to other records: one reference or a set,
 * chosen from a searchable list that is usually loaded from the server as the
 * user types.
 *
 * ## What the host owns and what this owns
 *
 * The query is controlled. A reference list is rarely in memory: the host
 * debounces the query, loads, filters out targets the field cannot hold, and
 * hands back the `options` to offer, with `listStatus` in their place while it
 * is loading, has failed, or found nothing. This cell owns the rest: the
 * trigger, the popover, the search box, the pick, and what the cell SHOWS
 * after a write settles.
 *
 * ## Refusal is the load-bearing part
 *
 * A pick commits the whole next set (`[]` is a clear) through the same
 * {@link useCommitLedger} every champion reads, dispatched behind the one
 * before it ({@link useSerializedCommit}). A refusal (a rejected promise or
 * thenable, or a synchronous throw) puts back the newest set that was not
 * refused. Every hand-rolled reference picker this replaced closed on the pick
 * and left the chosen target on screen whether or not it saved.
 *
 * ## Single and multiple
 *
 * Single: choosing commits and closes, choosing the current target again only
 * closes, and the host may add a clear action (`clearLabel`). Multiple: each
 * choice toggles and the list stays open, with an optional footer (`done`)
 * that counts the set and closes.
 *
 * Domain-free: every word, the trigger's content (`renderValues`), each
 * value's name (`valueLabel`) and each option's adornment are the caller's.
 * The trigger is named "Edit {label}, currently {values}", or "Set {label}"
 * when nothing is linked, the way the select cells name theirs.
 */
export function InlineReferenceCell({
  values,
  multiple = false,
  options,
  onCommit,
  label,
  renderValues,
  valueLabel,
  search,
  query,
  onQueryChange,
  listStatus,
  listFooter,
  clearLabel,
  done,
  onOpenChange,
  readOnly = false,
  primaryEditor = false,
  className,
}: Readonly<InlineReferenceCellProps>) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<readonly string[]>(values);
  const ledger = useCommitLedger<readonly string[]>(values, sameOrderedValues);
  const dispatch = useSerializedCommit(onCommit);
  const committedKey = JSON.stringify(values);
  const [seenKey, setSeenKey] = useState(committedKey);
  if (seenKey !== committedKey) {
    setSeenKey(committedKey);
    ledger.reset(values);
    setShown(ledger.current());
  }

  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const commit = (next: readonly string[]) => {
    setShown(next);
    ledger.submit(next, dispatch, setShown);
  };
  const choose = (value: string) => {
    const current = ledger.current();
    if (multiple) {
      commit(
        current.includes(value)
          ? current.filter((candidate) => candidate !== value)
          : [...current, value]
      );
      return;
    }
    if (!(current.length === 1 && current[0] === value)) {
      commit([value]);
    }
    changeOpen(false);
  };

  const names = shown.map(valueLabel).join(", ");

  if (readOnly) {
    if (shown.length === 0) {
      return <GridEmptyValue title={`No ${label}`} />;
    }
    return (
      <span className={cn("flex min-w-0 items-center gap-1", className)}>
        {renderValues(shown)}
      </span>
    );
  }

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={names ? `Edit ${label}, currently ${names}` : `Set ${label}`}
          className={cn(TRIGGER_CLASS, className)}
          data-grid-primary-editor={primaryEditor ? "" : undefined}
          type="button"
        >
          {shown.length > 0 ? (
            renderValues(shown)
          ) : (
            <GridEmptyValue title={`Set ${label}`} />
          )}
        </button>
      </PopoverTrigger>
      <InlinePickerContent
        onQueryChange={onQueryChange}
        query={query}
        search={search}
      >
        <CommandList className="max-h-72 p-1">
          {listStatus ??
            options.map((option) => (
              <ReferenceOptionItem
                key={option.value}
                onChoose={choose}
                option={option}
                selected={shown.includes(option.value)}
              />
            ))}
          {listFooter}
        </CommandList>
        {multiple && done && shown.length > 0 ? (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {done.summary(shown.length)}
            </span>
            <Button
              onClick={() => changeOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {done.label}
            </Button>
          </div>
        ) : null}
        {!multiple && clearLabel !== undefined && shown.length > 0 ? (
          <div className="border-t p-2">
            <Button
              className="w-full text-muted-foreground"
              onClick={() => {
                commit([]);
                changeOpen(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {clearLabel}
            </Button>
          </div>
        ) : null}
      </InlinePickerContent>
    </Popover>
  );
}

export type InlineReferenceOption = {
  /** The stored value: the target's id. */
  value: string;
  /** The target's short handle (a slug), set in a monospace face. */
  label: string;
  /** The target's name, beside its handle. */
  description?: string;
  /** Rendered ahead of the handle: a kind glyph. */
  adornment?: ReactNode;
  /** Rendered after the name: a status chip, a relationship. */
  meta?: ReactNode;
};

export type InlineReferenceCellProps = {
  /** The committed targets. One at most when `multiple` is false. */
  values: readonly string[];
  multiple?: boolean;
  /** The targets to offer for the current query, already narrowed by the host. */
  options: readonly InlineReferenceOption[];
  /**
   * Called with the whole next set (`[]` clears). Signal a refusal with a
   * rejected promise or thenable, or a synchronous throw, and the previous set
   * is put back.
   */
  onCommit: (next: readonly string[]) => Promise<unknown> | void;
  /** What is being linked. Names the control. */
  label: string;
  /** The trigger's content for a non-empty set. */
  renderValues: (values: readonly string[]) => ReactNode;
  /** One value's name, for the trigger's accessible name. */
  valueLabel: (value: string) => string;
  /** Names the search box, and its placeholder. */
  search: { label: string; placeholder: string };
  query: string;
  onQueryChange: (query: string) => void;
  /** Rendered in place of the options: loading, failed, nothing found. */
  listStatus?: ReactNode;
  /** Rendered after the options: a "keep typing" hint. */
  listFooter?: ReactNode;
  /** Single only: adds a clear action under this label. */
  clearLabel?: string;
  /** Multiple only: a footer counting the set, with a button that closes. */
  done?: { label: string; summary: (count: number) => ReactNode };
  /** Told when the editor opens and closes, so the host can load and reset. */
  onOpenChange?: (open: boolean) => void;
  readOnly?: boolean;
  /** Marks the trigger as this grid cell's keyboard entry target. */
  primaryEditor?: boolean;
  className?: string;
};

function ReferenceOptionItem({
  onChoose,
  option,
  selected,
}: {
  onChoose: (value: string) => void;
  option: InlineReferenceOption;
  selected: boolean;
}) {
  return (
    <InlinePickerOption
      onSelect={() => onChoose(option.value)}
      selected={selected}
      value={option.value}
    >
      {option.adornment}
      <span className="shrink-0 font-mono text-muted-foreground text-xs">
        {option.label}
      </span>
      {option.description ? (
        <span className="min-w-0 flex-1 truncate">{option.description}</span>
      ) : null}
      {option.meta}
    </InlinePickerOption>
  );
}

/** The select cells' trigger box with the chip-row gap. */
const TRIGGER_CLASS = cn(INLINE_CELL_TRIGGER_CLASS, "gap-1");
