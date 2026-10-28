"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { PlusIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { CommandItem, CommandList } from "./command";
import { GridEmptyValue } from "./grid-table-card";
import {
  INLINE_CELL_TRIGGER_CLASS,
  InlinePickerContent,
  InlinePickerMessage,
  InlinePickerOption,
} from "./inline-select-cell";
import { Popover, PopoverTrigger } from "./popover";
import { sameOrderedValues, useCommitLedger } from "./use-commit-ledger";
import { useSerializedCommit } from "./use-serialized-commit";

/**
 * The shared grid cell for an OPEN list of labels: tags the user picks from
 * what exists or creates by typing one that does not.
 *
 * ## Why it is not the multi-select
 *
 * `InlineMultiSelectCell` is a closed list: every value it can commit is an
 * option it was handed, and a value it does not know is marked unknown. A tag
 * set is the opposite. Typing a label nobody has used is how a tag comes to
 * exist, so this cell offers a create action for any query no option matches,
 * and a value no option carries is just a tag, not an error.
 *
 * ## Refusal is the load-bearing part
 *
 * Same promise as every other champion: `onCommit` receives the whole next
 * set, and a refusal (a rejected promise or thenable, or a synchronous throw)
 * puts back the newest set that was not refused, through the same
 * {@link useCommitLedger} the scalar and select cells read. Commits are
 * dispatched one behind the other ({@link useSerializedCommit}), so two quick
 * toggles reach the server in the order they were made.
 *
 * ## Domain-free
 *
 * The design system holds none of the words and none of the tag identity. The
 * caller renders the committed set (`renderValues`), each chip in the editor
 * header (`renderSelected`), each option (`InlineTagOption.content`), and what
 * follows a create (`createdContent`, a colour picker in the app); it supplies
 * every string through `search`. The trigger is named the way the select cells
 * name theirs: "Edit {label}, currently {values}", or "Set {label}" when the
 * set is empty.
 *
 * Built on `Popover` and `Command` through {@link InlinePickerContent}, the
 * picker the reference cell and the searchable multi-select open too, so the
 * search box, arrow-key movement, Enter to choose and Escape to dismiss are the
 * catalog's, not this file's.
 * Dismissal writes nothing: a pick or a create IS the write.
 */
export function InlineTagCell({
  values,
  options,
  onCommit,
  label,
  renderValues,
  renderSelected,
  search,
  onCreate,
  createdContent,
  readOnly = false,
  primaryEditor = false,
  className,
}: Readonly<InlineTagCellProps>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [shown, setShown] = useState<readonly string[]>(values);
  const ledger = useCommitLedger<readonly string[]>(values, sameOrderedValues);
  const dispatch = useSerializedCommit(onCommit);
  // The committed set by VALUE, adjusted during render, for the reason
  // `InlineMultiSelectCell` gives: a caller rebuilding the array each render
  // must not reset the ledger and throw away a pick in flight.
  const committedKey = JSON.stringify(values);
  const [seenKey, setSeenKey] = useState(committedKey);
  if (seenKey !== committedKey) {
    setSeenKey(committedKey);
    ledger.reset(values);
    setShown(ledger.current());
  }

  const commit = (next: readonly string[]) => {
    setShown(next);
    ledger.submit(next, dispatch, setShown);
  };
  const toggle = (value: string) => {
    const current = ledger.current();
    commit(
      current.includes(value)
        ? current.filter((candidate) => candidate !== value)
        : [...current, value]
    );
    setQuery("");
  };
  const create = (value: string) => {
    onCreate?.(value);
    const current = ledger.current();
    if (!current.includes(value)) {
      commit([...current, value]);
    }
    setCreated(value);
    setQuery("");
  };

  const names = shown.map((value) => optionLabel(options, value)).join(", ");

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
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setCreated(null);
        }
      }}
      open={open}
    >
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
        header={
          renderSelected && shown.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
              {shown.map((value) => (
                <Fragment key={value}>
                  {renderSelected(value, () => toggle(value))}
                </Fragment>
              ))}
            </div>
          ) : null
        }
        onQueryChange={setQuery}
        query={query}
        search={search}
      >
        {created !== null && createdContent ? (
          createdContent(created, () => setCreated(null))
        ) : (
          <TagOptionList
            onCreate={create}
            onToggle={toggle}
            options={options}
            query={query}
            search={search}
            shown={shown}
          />
        )}
      </InlinePickerContent>
    </Popover>
  );
}

export type InlineTagOption = {
  /** The stored value. */
  value: string;
  /** What the option reads as, in the trigger's name and in search. */
  label: string;
  /** Rendered in the list in place of the plain label: a coloured chip. */
  content?: ReactNode;
};

/** Every word the editor shows. The design system holds none of them. */
export type InlineTagSearch = {
  /** Names the search box. */
  label: string;
  placeholder: string;
  /** The create action for a query no option matches. */
  createLabel: (query: string) => ReactNode;
  /** Shown when there is no option and nothing typed. */
  emptyMessage: ReactNode;
};

export type InlineTagCellProps = {
  /** The committed set, in the order it renders. */
  values: readonly string[];
  /** The labels that exist. A value none of them carries is still a tag. */
  options: readonly InlineTagOption[];
  /**
   * Called with the whole next set on every toggle and create. Signal a
   * refusal with a rejected promise or thenable, or a synchronous throw, and
   * the previous set is put back.
   */
  onCommit: (next: readonly string[]) => Promise<unknown> | void;
  /** What is being set ("tags"). Names the control. */
  label: string;
  /** The trigger's content for a non-empty set: the caller's chips. */
  renderValues: (values: readonly string[]) => ReactNode;
  /**
   * One applied value in the editor's header, with the action that removes
   * it. Omitted, the header is not rendered and a value is removed from the
   * list instead.
   */
  renderSelected?: (value: string, remove: () => void) => ReactNode;
  search: InlineTagSearch;
  /**
   * Called before a created value is committed, so the host can register the
   * new label (and, in the app, give it a colour).
   */
  onCreate?: (value: string) => void;
  /**
   * Replaces the list after a create until `finish` is called or the editor
   * closes: where the host asks what the new label looks like.
   */
  createdContent?: (value: string, finish: () => void) => ReactNode;
  readOnly?: boolean;
  /** Marks the trigger as this grid cell's keyboard entry target. */
  primaryEditor?: boolean;
  className?: string;
};

/**
 * The options, the applied values no option carries, and the create action,
 * narrowed to the query. Matching trims and ignores case, so "  plat " finds
 * "Platform" and "design" never offers to create "Design" twice.
 */
function TagOptionList({
  onCreate,
  onToggle,
  options,
  query,
  search,
  shown,
}: {
  onCreate: (value: string) => void;
  onToggle: (value: string) => void;
  options: readonly InlineTagOption[];
  query: string;
  search: InlineTagSearch;
  shown: readonly string[];
}) {
  const trimmed = query.trim();
  const normalized = trimmed.toLowerCase();
  const known = new Set(options.map((option) => option.value));
  const every: readonly InlineTagOption[] = [
    ...options,
    ...shown
      .filter((value) => !known.has(value))
      .map((value): InlineTagOption => ({ value, label: value })),
  ];
  const offered = every.filter((option) =>
    option.label.toLowerCase().includes(normalized)
  );
  const exactMatch = every.some(
    (option) => option.label.toLowerCase() === normalized
  );
  const canCreate = trimmed !== "" && !exactMatch;

  return (
    <CommandList className="max-h-64 p-1">
      {offered.map((option) => (
        <InlinePickerOption
          key={option.value}
          onSelect={() => onToggle(option.value)}
          selected={shown.includes(option.value)}
          value={option.value}
        >
          {option.content ?? <span className="truncate">{option.label}</span>}
        </InlinePickerOption>
      ))}
      {canCreate ? (
        <CommandItem
          onSelect={() => onCreate(trimmed)}
          value={`${CREATE_ITEM_VALUE}${trimmed}`}
        >
          <PlusIcon aria-hidden />
          {search.createLabel(trimmed)}
        </CommandItem>
      ) : null}
      {offered.length === 0 && trimmed === "" ? (
        <InlinePickerMessage>{search.emptyMessage}</InlinePickerMessage>
      ) : null}
    </CommandList>
  );
}

function optionLabel(options: readonly InlineTagOption[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * The create item's cmdk identity. A NUL can never be typed into the search
 * box, so it cannot collide with a stored value.
 */
const CREATE_ITEM_VALUE = "\u0000create:";

/** The select cells' trigger box with the chip-row gap. */
const TRIGGER_CLASS = cn(INLINE_CELL_TRIGGER_CLASS, "gap-1");
