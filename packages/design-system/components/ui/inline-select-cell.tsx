"use client";

import { CheckIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { CHIP_FOCUS_RING_CLASS, Chip } from "./chip";
import { Command, CommandInput, CommandItem, CommandList } from "./command";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { GridEmptyValue } from "./grid-table-card";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  CellOverflow,
  useMeasuredCellItems,
} from "./table-cell-list-primitives";
import { sameOrderedValues, useCommitLedger } from "./use-commit-ledger";
import { useSerializedCommit } from "./use-serialized-commit";

/**
 * The shared grid cell for a value the user PICKS from a closed list — a
 * status, a priority, an owner, a single- or multi-select custom field, a
 * label set.
 *
 * ## Why one component for six things
 *
 * ISS-9347's audit found the same dropdown written seven times across the
 * prototype and the app packages: three enum editors, three person editors,
 * two tag editors, and not one of them restores the previous value when the
 * write is refused. They differ only in what renders ahead of each option's
 * label — an avatar, a coloured chip, nothing — so this takes that as
 * {@link InlineSelectOption.adornment}, a `ReactNode` the CALLER supplies.
 * That is also what keeps the champion domain-free: an avatar identity or a
 * `TagChip` is Symphony's, the menu is not, and `packages/design-system` may
 * not import either.
 *
 * ## Refusal is the load-bearing part
 *
 * Every hand-rolled copy in the audit commits optimistically and offers an
 * "Undo" toast. That is a different promise: the toast rolls back because the
 * USER asked, and nothing rolls back when the SERVER refuses — the cell keeps
 * showing a value that was never saved, which is a UI lying about the data.
 * `onCommit` may signal a refusal however it likes (a rejected promise, a
 * cross-realm thenable, a synchronous throw) and the cell falls back to the
 * newest value that was not refused, through the same {@link useCommitLedger}
 * `InlineScalarCell` uses. One ledger, so a scalar cell and a select cell
 * cannot come to disagree about what a rejection restores.
 *
 * ## Naming and keyboard
 *
 * The trigger is named for the FIELD and its current value — "Edit priority,
 * currently Urgent" — because a trigger whose only text is a chip reading
 * "Urgent" does not say what it sets (WCAG 2.4.6), and an empty one says
 * nothing at all. An empty cell is named "Set {label}", for what activating it
 * does. Radix supplies `aria-expanded`, `aria-haspopup`, roving arrow-key
 * focus, Enter or Space to choose, Escape to dismiss, and it returns focus to
 * the trigger on close — which is why this is a menu and not a hand-rolled
 * popover.
 *
 * Dismissal writes nothing by construction: there is no draft and no
 * blur-commit, so this needs no `cancelingRef` interlock. That is the same
 * promise `InlineDateCell` keeps by the same mechanism.
 */
export function InlineSelectCell({
  value,
  options,
  onCommit,
  label,
  readOnly = false,
  primaryEditor = false,
  valueContent,
  valueLabel,
  clearLabel,
  className,
}: Readonly<InlineSelectCellProps>) {
  const [shown, setShown] = useState(value);
  const ledger = useCommitLedger(value);
  const dispatch = useSerializedCommit(onCommit);

  // A committed value that changes underneath us (another user, a refetch) is
  // authoritative: it replaces what is on screen and outranks every commit in
  // flight, so a late rejection cannot roll it back.
  useEffect(() => {
    ledger.reset(value);
    setShown(value);
  }, [value, ledger]);

  // A committed value no option carries is SHOWN as unknown rather than
  // dropped. Dropping it renders an empty cell over a stored value, which is
  // the cell lying about the data — and this one carries the value it cannot
  // name, so the reader can see what is actually stored.
  const displayed = displayOptions([shown], options);
  const selected = displayed.at(0) ?? null;
  // The caller's own rendering and naming of the committed value outrank the
  // option list, because the two can legitimately disagree: an archived or
  // filtered-out option is still what the record HOLDS, and a caller that
  // renders it from the record's own payload knows more than a lookup does.
  // That rendering describes the COMMITTED record, so it is what the cell shows
  // at rest and what it falls back to when a write is refused. The moment the
  // user picks something else the cell owns the display again, or an optimistic
  // pick would be invisible and a rollback indistinguishable from it.
  const atCommitted = shown === value;
  const shownContent =
    (atCommitted ? valueContent : undefined) ??
    (selected ? <OptionContent option={selected} /> : null);
  const shownName =
    (atCommitted ? valueLabel : undefined) ?? selected?.label ?? "";

  const commit = (next: string) => {
    if (next === ledger.current()) {
      return;
    }
    setShown(next);
    ledger.submit(next, dispatch, setShown);
  };

  if (readOnly) {
    if (!shownName) {
      return <GridEmptyValue title={`No ${label}`} />;
    }
    return (
      <span className={cn("flex min-w-0 items-center gap-2", className)}>
        {shownContent}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={
            shownName ? `Edit ${label}, currently ${shownName}` : `Set ${label}`
          }
          className={cn(TRIGGER_CLASS, className)}
          data-grid-primary-editor={primaryEditor ? "" : undefined}
          type="button"
        >
          {shownContent ?? <GridEmptyValue title={`Set ${label}`} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuRadioGroup onValueChange={commit} value={shown}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              className={MENU_ITEM_CLASS}
              key={option.value}
              value={option.value}
            >
              <OptionContent option={option} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {clearLabel === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            {/*
              A plain item, never a fourth radio: clearing is an ACTION, and a
              radio announces as a value and paints a selected indicator while
              the write is in flight. It commits the empty value the cell
              already reads as "no value", so nothing ever renders the word
              "Clear" where the field's value belongs.
            */}
            <DropdownMenuItem onSelect={() => commit("")}>
              {clearLabel}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The multi-select variant. Same trigger, same ledger, same refusal promise;
 * the menu stays open across picks because a multi-select that closes after
 * each one makes setting three labels three visits.
 *
 * Each toggle is its OWN whole-set commit, so this does not batch them behind
 * a "Done" button nobody would press. Two fast picks are DISPATCHED in the
 * order they were clicked, one behind the other — a whole-set replacement that
 * overtakes its predecessor would leave the server holding the obsolete set
 * while the ledger keeps showing the newer one, and nothing could detect it.
 * The ledger still orders what the cell SHOWS, which is a different question
 * and the one refusals turn on.
 */
export function InlineMultiSelectCell({
  values,
  options,
  onCommit,
  label,
  readOnly = false,
  primaryEditor = false,
  valueContent,
  valueLabel,
  search,
  className,
}: Readonly<InlineMultiSelectCellProps>) {
  const [shown, setShown] = useState<readonly string[]>(values);
  const ledger = useCommitLedger<readonly string[]>(values, sameOrderedValues);
  const dispatch = useSerializedCommit(onCommit);
  // The committed set by VALUE rather than by array identity: a caller that
  // rebuilds the array each render would otherwise reset the ledger on every
  // render and throw away the pick still in flight. Adjusted DURING render
  // rather than in an effect, so an authoritative value never paints for a
  // frame as the stale one, and no ref is written from the render body.
  const committedKey = JSON.stringify(values);
  const [seenKey, setSeenKey] = useState(committedKey);
  if (seenKey !== committedKey) {
    setSeenKey(committedKey);
    ledger.reset(values);
    setShown(ledger.current());
  }

  // Every value in the set, in the set's own order, with any value no option
  // carries kept and marked rather than silently dropped: the toggle path
  // below re-submits the whole of `ledger.current()`, so a value hidden from
  // the trigger would go on being persisted with nothing on screen saying so.
  const displayed = displayOptions(shown, options);
  const fit = useMeasuredCellItems(
    displayed.map((option) => option.value),
    true
  );
  // See the single-select cell: caller content describes the committed record,
  // and the cell takes the display back the moment the shown set diverges.
  const atCommitted = JSON.stringify(shown) === committedKey;
  const callerContent = atCommitted ? valueContent : undefined;
  const shownName =
    (atCommitted ? valueLabel : undefined) ??
    displayed.map((option) => option.label).join(", ");

  const toggle = (value: string) => {
    const current = ledger.current();
    const next = current.includes(value)
      ? current.filter((candidate) => candidate !== value)
      : [...current, value];
    setShown(next);
    ledger.submit(next, dispatch, setShown);
  };

  if (readOnly) {
    if (!shownName) {
      return <GridEmptyValue title={`No ${label}`} />;
    }
    if (callerContent) {
      return (
        <span className={cn("flex min-w-0 items-center gap-1", className)}>
          {callerContent}
        </span>
      );
    }
    return (
      <SelectedOptions className={className} fit={fit} options={displayed} />
    );
  }

  const trigger = (
    <button
      aria-label={
        shownName ? `Edit ${label}, currently ${shownName}` : `Set ${label}`
      }
      className={cn(TRIGGER_CLASS, className)}
      data-grid-primary-editor={primaryEditor ? "" : undefined}
      type="button"
    >
      {callerContent ??
        (displayed.length > 0 ? (
          <SelectedOptions fit={fit} options={displayed} />
        ) : (
          <GridEmptyValue title={`Set ${label}`} />
        ))}
    </button>
  );

  if (search) {
    return (
      <SearchablePicker
        onToggle={toggle}
        options={options}
        search={search}
        selected={shown}
        trigger={trigger}
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            checked={shown.includes(option.value)}
            className={MENU_ITEM_CLASS}
            key={option.value}
            onCheckedChange={() => toggle(option.value)}
            // Keep the menu open, so setting three labels is one visit.
            onSelect={(event) => event.preventDefault()}
          >
            <OptionContent option={option} />
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type InlineSelectOption = {
  /** The stored value. Never the display string, which copy may rework. */
  value: string;
  /** What the option reads as, on screen and in the trigger's accessible name. */
  label: string;
  /**
   * Rendered ahead of the label, in the trigger and in the menu alike — an
   * avatar, a swatch, a type glyph. Caller-supplied so a domain identity never
   * has to be imported into the design system.
   */
  adornment?: ReactNode;
  /** Renders the label as a {@link Chip} carrying these classes. */
  chipClassName?: string;
};

export type InlineSelectCellProps = {
  /**
   * The committed value. A value no option carries is rendered as an unknown
   * chip carrying the raw value — never as "no value", which would show an
   * empty cell over something the server is storing.
   */
  value: string;
  options: readonly InlineSelectOption[];
  /**
   * Called only when the user picks a value different from the committed one.
   * Signal a refusal with a rejected promise or thenable, or a synchronous
   * throw, and the previous value is put back.
   */
  onCommit: (next: string) => Promise<unknown> | void;
  /** What is being set ("Priority", "Owner", "Status"). Names the control. */
  label: string;
  /** Renders the selected option as plain content with no control. */
  readOnly?: boolean;
  /**
   * Marks the trigger as this grid cell's entry target for keyboard editing
   * (`data-grid-primary-editor`, read by `lib/grid-cell-keyboard.ts`). A cell
   * holding more than one focusable element has to say which one Enter lands
   * on; outside a grid it means nothing and stays off.
   */
  primaryEditor?: boolean;
  /**
   * What the trigger SHOWS for the committed value, when the caller renders it
   * better than an option lookup can. Supply it whenever the record's own
   * payload is authoritative — an option that has since been archived is still
   * what the row holds, and resolving display from `options` alone would blank
   * a cell that has data in it.
   */
  valueContent?: ReactNode;
  /** The committed value's name for the accessible label, paired with {@link valueContent}. */
  valueLabel?: string;
  /**
   * Adds a separated clear ACTION to the menu under this label. It commits the
   * empty value, which the cell reads as "no value" — never a fourth radio,
   * which would announce a destructive action as one of the field's values.
   */
  clearLabel?: string;
  className?: string;
};

export type InlineMultiSelectCellProps = {
  /**
   * The committed set. Rendered in THIS order, each value matched against
   * `options` for its label and adornment; a value no option carries renders
   * as an unknown chip rather than disappearing from the cell.
   */
  values: readonly string[];
  options: readonly InlineSelectOption[];
  /** Called per toggle with the whole next set. Refusals restore, as above. */
  onCommit: (next: readonly string[]) => Promise<unknown> | void;
  /** What is being set ("Labels", "Collaborators"). Names the control. */
  label: string;
  readOnly?: boolean;
  /** Marks the trigger as this cell's grid-keyboard entry target. */
  primaryEditor?: boolean;
  /** What the trigger SHOWS for the committed set. See the single-select prop. */
  valueContent?: ReactNode;
  /** The committed set's name for the accessible label. */
  valueLabel?: string;
  /**
   * Adds a search box above the options, for a list too long to scan (an
   * organization's people), and opens the options in the same search picker
   * the tag and reference cells use ({@link InlinePickerContent}) instead of
   * the menu. Every word is the caller's.
   */
  search?: InlineSelectSearch;
  className?: string;
};

/** The words a searchable picker shows. The design system holds none of them. */
export type InlineSelectSearch = {
  /** Names the search box. */
  label: string;
  placeholder: string;
  /** Shown when no option's label contains the query. */
  emptyMessage: string;
};

/**
 * Same box as the scalar cell's, so a select column and a text column line up
 * and an empty cell clears the 24px minimum target (WCAG 2.5.8).
 */
export const INLINE_CELL_TRIGGER_CLASS = cn(
  "flex h-7 w-full min-w-0 items-center overflow-hidden rounded-md px-1.5 text-left text-sm hover:bg-muted",
  CHIP_FOCUS_RING_CLASS
);

const TRIGGER_CLASS = cn(INLINE_CELL_TRIGGER_CLASS, "gap-2");

/** The options whose label contains the query, compared case-insensitively. */
function matchingOptions(
  options: readonly InlineSelectOption[],
  query: string
): readonly InlineSelectOption[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") {
    return options;
  }
  return options.filter((option) =>
    option.label.toLowerCase().includes(normalized)
  );
}

/** Radix indents its own indicator; the option's content sits beside it. */
const MENU_ITEM_CLASS = "flex items-center gap-2";

function OptionContent({ option }: { option: InlineSelectOption }) {
  if (option.chipClassName) {
    return (
      <>
        {option.adornment}
        <Chip className={option.chipClassName} variant="outline">
          {option.label}
        </Chip>
      </>
    );
  }
  return (
    <>
      {option.adornment}
      <span className="truncate">{option.label}</span>
    </>
  );
}

/**
 * Renders the picked options, collapsing to `+N` at the container's measured
 * width through the same helper the read-only choice-list cell uses. Without
 * it a `shrink-0` chip row simply overflows the `h-7` trigger into the next
 * column, which is what the prototype's own `ResponsiveChipList` was for.
 */
function SelectedOptions({
  className,
  fit,
  options,
}: {
  className?: string;
  fit: ReturnType<typeof useMeasuredCellItems>;
  options: readonly InlineSelectOption[];
}) {
  const visible = options.slice(0, fit.visibleCount);
  const hidden = options.slice(fit.visibleCount);
  return (
    <span
      className={cn(
        "relative flex w-full min-w-0 items-center gap-1 overflow-hidden",
        className
      )}
      ref={fit.containerRef}
    >
      {visible.map((option) => (
        <OptionItem key={option.value} option={option} />
      ))}
      <CellOverflow labels={hidden.map((option) => option.label)} />
      <span
        aria-hidden
        className="pointer-events-none absolute flex items-center gap-1 opacity-0"
      >
        {options.map((option, index) => (
          <OptionItem
            key={option.value}
            measureRef={(element) => {
              fit.measurementRefs.current[index] = element;
            }}
            option={option}
          />
        ))}
      </span>
    </span>
  );
}

/** One measured, non-shrinking item in the collapsing row. */
function OptionItem({
  measureRef,
  option,
}: {
  measureRef?: (element: HTMLSpanElement | null) => void;
  option: InlineSelectOption;
}) {
  return (
    <span className="flex shrink-0 items-center gap-2" ref={measureRef}>
      <OptionContent option={option} />
    </span>
  );
}

/**
 * `values` shaped for rendering: each one's option where the list carries it,
 * and an explicit unknown entry where it does not.
 *
 * The unknown case is the one a closed list gets wrong. A deleted option, a
 * half-loaded list, or a value from a wider vocabulary than this menu offers
 * all reach here, and filtering them out hides a value the cell goes on
 * PERSISTING on the next toggle. It is marked in WORDS rather than by colour
 * alone (WCAG 1.4.1), and it is never offered in the menu, so it cannot be
 * re-picked and cannot read as a member of the list.
 */
function displayOptions(
  values: readonly string[],
  options: readonly InlineSelectOption[]
): readonly InlineSelectOption[] {
  const byValue = new Map(options.map((option) => [option.value, option]));
  const displayed: InlineSelectOption[] = [];
  for (const value of values) {
    if (value === "") {
      continue;
    }
    const option = byValue.get(value);
    displayed.push(option ?? unknownOption(value));
  }
  return displayed;
}

function unknownOption(value: string): InlineSelectOption {
  return {
    value,
    label: `${value} (unknown)`,
    chipClassName: UNKNOWN_CHIP_CLASS,
  };
}

/**
 * Deliberately not a status colour: an unknown value is not a member of the
 * list, and the word in the label — not this class — is what says so.
 */
const UNKNOWN_CHIP_CLASS = "border-dashed text-muted-foreground";

/**
 * The open half of every searchable inline cell (this multi-select with
 * `search`, `InlineTagCell`, `InlineReferenceCell`): a popover holding a
 * `Command` with its search box on top, so the three open the same picker.
 * cmdk's own filter is off because each cell narrows its own list.
 *
 * Opening lands focus on the search box, not on the first focusable thing in
 * the popover: a cell may render a `header` above it (the tag cell's applied
 * chips, with their remove buttons), and typed text has to reach the query or
 * Enter writes the highlighted option instead.
 */
export function InlinePickerContent({
  children,
  header,
  onQueryChange,
  query,
  search,
}: Readonly<{
  children: ReactNode;
  header?: ReactNode;
  onQueryChange: (query: string) => void;
  query: string;
  /** Names the search box, and its placeholder. */
  search: { label: string; placeholder: string };
}>) {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <PopoverContent
      align="start"
      className="w-80 overflow-hidden p-0"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        searchRef.current?.focus();
      }}
    >
      <Command label={search.label} shouldFilter={false}>
        {header}
        <CommandInput
          onValueChange={onQueryChange}
          placeholder={search.placeholder}
          ref={searchRef}
          value={query}
        />
        {children}
      </Command>
    </PopoverContent>
  );
}

/**
 * One option in an inline picker: the caller's content, then a check when it
 * is in the set. `aria-checked` carries the same state to assistive tech.
 */
export function InlinePickerOption({
  children,
  onSelect,
  selected,
  value,
}: Readonly<{
  children: ReactNode;
  onSelect: () => void;
  selected: boolean;
  /** cmdk's identity for the item: the stored value. */
  value: string;
}>) {
  return (
    <CommandItem aria-checked={selected} onSelect={onSelect} value={value}>
      {children}
      {selected ? <CheckIcon aria-hidden className="ml-auto" /> : null}
    </CommandItem>
  );
}

/** A line in place of the options, for a list with nothing to offer. */
export function InlinePickerMessage({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-6 text-center text-muted-foreground text-sm">
      {children}
    </div>
  );
}

/**
 * The searchable multi-select's picker. Same toggle as the menu, and it stays
 * open across picks the same way; the query starts empty on every open, as the
 * tag cell's does.
 */
function SearchablePicker({
  onToggle,
  options,
  search,
  selected,
  trigger,
}: {
  onToggle: (value: string) => void;
  options: readonly InlineSelectOption[];
  search: InlineSelectSearch;
  selected: readonly string[];
  trigger: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const offered = matchingOptions(options, query);
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <InlinePickerContent
        onQueryChange={setQuery}
        query={query}
        search={search}
      >
        <CommandList className="max-h-72 p-1">
          {offered.map((option) => (
            <InlinePickerOption
              key={option.value}
              onSelect={() => onToggle(option.value)}
              selected={selected.includes(option.value)}
              value={option.value}
            >
              <OptionContent option={option} />
            </InlinePickerOption>
          ))}
          {offered.length === 0 ? (
            <InlinePickerMessage>{search.emptyMessage}</InlinePickerMessage>
          ) : null}
        </CommandList>
      </InlinePickerContent>
    </Popover>
  );
}
