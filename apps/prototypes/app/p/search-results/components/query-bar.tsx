"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { cn } from "@repo/design-system/lib/utils";
import { AlertCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import {
  activeTypeKinds,
  type EntityKind,
  FILTER_KEYS,
  type FilterKeyMeta,
  matchKeyValueToken,
  spliceTokenAtCaret,
  toggleTypeToken,
  tokenSpanAtCaret,
} from "../search-model";
import { TypeControl } from "./type-control";

type QueryBarProps = {
  /** The current query string (bar value). */
  value: string;
  /** Emitted on every edit and on each committed suggestion. */
  onChange: (next: string) => void;
  /** Emitted on Enter / the Search button - the parent re-runs the query. */
  onSubmit: (query: string) => void;
  /**
   * A safe-to-show message for an invalid filter token, rendered inline under
   * the bar (the query problem lives with the query, not floating over results).
   */
  filterErrorMessage?: string;
};

// A suggestion the popover offers: either a whole filter key (to start a token)
// or a value for the key the caret is inside.
type Suggestion = {
  /** The text that replaces the caret's token when committed. */
  insert: string;
  /** Primary label in the row. */
  label: string;
  /** Secondary hint (a plain-language explainer for a key, nothing for a value). */
  hint?: string;
  /**
   * A completed value gets a trailing space so the caret is ready for the next
   * token; a bare key prefix does NOT, so the value composes onto the same
   * token (`type:` then `session` → `type:session`, never `type: session`).
   */
  withTrailingSpace: boolean;
};

// No suggestion is pre-selected: Enter runs the search until the user explicitly
// arrows into an option, so plain text and completed values submit as typed.
const NO_ACTIVE_INDEX = -1;

// The JQL-look editable query bar. It reuses the flat key:value grammar SHAPE:
// the token the CARET sits in decides whether we suggest filter KEYS (no colon
// yet) or VALUES (after `key:` / `key<op>`). Committing splices that token in
// place. Mock only - no real parser or fetch.
export function QueryBar({
  value,
  onChange,
  onSubmit,
  filterErrorMessage,
}: QueryBarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(NO_ACTIVE_INDEX);
  const [caret, setCaret] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  const suggestions = useMemo(
    () => buildSuggestions(value, caret),
    [value, caret]
  );
  const activeKinds = activeTypeKinds(value);
  const showListbox = isOpen && suggestions.length > 0;
  const hasActiveOption = activeIndex >= 0 && activeIndex < suggestions.length;

  const syncCaret = () => {
    const position = inputRef.current?.selectionStart;
    setCaret(typeof position === "number" ? position : value.length);
  };

  const commit = (suggestion: Suggestion) => {
    const spliced = spliceTokenAtCaret(
      value,
      caret,
      suggestion.insert,
      suggestion.withTrailingSpace
    );
    onChange(spliced.query);
    setActiveIndex(NO_ACTIVE_INDEX);
    setCaret(spliced.caret);
    const input = inputRef.current;
    if (input) {
      input.focus();
      // Restore the caret after React writes the new value, so the next token
      // composes from where the insert ended rather than the string tail.
      requestAnimationFrame(() => {
        input.setSelectionRange(spliced.caret, spliced.caret);
      });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      if (showListbox && hasActiveOption) {
        event.preventDefault();
        commit(suggestions[activeIndex]);
        return;
      }
      setIsOpen(false);
      onSubmit(value);
      return;
    }
    if (!showListbox) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => nextIndex(index, suggestions.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => prevIndex(index, suggestions.length));
    } else if (event.key === "Escape") {
      setIsOpen(false);
      setActiveIndex(NO_ACTIVE_INDEX);
    }
  };

  const onToggleKind = (kind: EntityKind) => {
    const next = toggleTypeToken(value, kind);
    onChange(next);
    onSubmit(next);
  };

  const clear = () => {
    onChange("");
    onSubmit("");
    setCaret(0);
    inputRef.current?.focus();
  };

  const hasError = Boolean(filterErrorMessage);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          {/* Single ARIA combobox on the catalog Input: the listbox is reached
              via aria-activedescendant, not as a tab stop, matching the product
              typeahead. Only the editor-grade height + icon padding are the
              delta from the DS input; focus/invalid tokens come from Input. */}
          <Input
            aria-activedescendant={
              showListbox && hasActiveOption ? optionId(activeIndex) : undefined
            }
            aria-autocomplete="list"
            aria-controls={showListbox ? listboxId : undefined}
            aria-expanded={showListbox}
            aria-invalid={hasError}
            aria-label="Search query"
            autoComplete="off"
            className="h-11 pr-10 pl-9 text-base md:text-base"
            onBlur={() => setIsOpen(false)}
            onChange={(event) => {
              onChange(event.target.value);
              setIsOpen(true);
              setActiveIndex(NO_ACTIVE_INDEX);
              setCaret(
                event.target.selectionStart ?? event.target.value.length
              );
            }}
            onClick={syncCaret}
            onFocus={() => setIsOpen(true)}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            placeholder="Search, or type a filter: type:session status:DONE @me"
            ref={inputRef}
            role="combobox"
            type="text"
            value={value}
          />
          {value.length > 0 ? (
            <button
              aria-label="Clear query"
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={clear}
              type="button"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </button>
          ) : null}

          {showListbox ? (
            <ul
              aria-label="Query suggestions"
              className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-auto rounded-md border border-border bg-popover py-1 shadow-md"
              id={listboxId}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: intentional ARIA combobox listbox popup; focus stays on the input via aria-activedescendant.
              role="listbox"
            >
              {suggestions.map((suggestion, index) => (
                <SuggestionOption
                  id={optionId(index)}
                  isActive={index === activeIndex}
                  key={suggestion.insert}
                  onCommit={() => commit(suggestion)}
                  suggestion={suggestion}
                />
              ))}
            </ul>
          ) : null}
        </div>

        <TypeControl activeKinds={activeKinds} onToggleKind={onToggleKind} />
        <Button className="h-11" onClick={() => onSubmit(value)} type="button">
          Search
        </Button>
      </div>

      {hasError ? (
        <Alert variant="error">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription>{filterErrorMessage}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

// One suggestion row. The <li role="option"> is reached via the input's
// aria-activedescendant (not a tab stop), matching the product intellisense
// overlay; the interactive target is the inner button. Commit on mousedown, so
// the click lands before the input's blur closes the overlay.
function SuggestionOption({
  suggestion,
  id,
  isActive,
  onCommit,
}: Readonly<{
  suggestion: Suggestion;
  id: string;
  isActive: boolean;
  onCommit: () => void;
}>) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: reached via aria-activedescendant, not a tab stop.
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: required ARIA listbox child; interactivity is the inner button.
    <li aria-selected={isActive} id={id} role="option">
      <button
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
          isActive ? "bg-muted" : "hover:bg-muted"
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          onCommit();
        }}
        tabIndex={-1}
        type="button"
      >
        <span className="shrink-0 font-medium text-foreground text-sm">
          {suggestion.label}
        </span>
        {suggestion.hint ? (
          <span className="truncate text-muted-foreground text-xs">
            {suggestion.hint}
          </span>
        ) : null}
      </button>
    </li>
  );
}

// Faked "dynamic" value sets (project / owner) so the popover feels complete
// without a fetch. Keyed by prefix; the real UI fetches these from endpoints.
const DYNAMIC_VALUE_STUBS: Record<string, readonly string[]> = {
  "project:": ["mikes-workspace", "platform-engineering", "search-redesign"],
  "@": ["mike", "parker", "chris", "night-crew"],
};

// Suggest filter KEYS while the caret's token has no key/operator yet; suggest
// that key's VALUES once the token opens a `key:` or `key<op>`.
function buildSuggestions(query: string, caret: number): Suggestion[] {
  const token = tokenSpanAtCaret(query, caret).text;

  const keyValue = matchKeyValueToken(token);
  if (keyValue) {
    return valueSuggestions(
      keyValue.meta,
      keyValue.operator,
      keyValue.valuePrefix
    );
  }

  return keySuggestions(token);
}

function keySuggestions(token: string): Suggestion[] {
  const needle = token.toLowerCase();
  return FILTER_KEYS.filter(
    (meta) =>
      needle.length === 0 ||
      meta.prefix.startsWith(needle) ||
      meta.label.toLowerCase().startsWith(needle)
  ).map((meta) => ({
    insert: meta.prefix,
    label: meta.label,
    // A plain-language explainer, not the raw operator glyphs — operators are
    // only useful once the key is committed and the user is choosing a value.
    hint: meta.hint,
    withTrailingSpace: false,
  }));
}

function valueSuggestions(
  meta: FilterKeyMeta,
  operator: string,
  valuePrefix: string
): Suggestion[] {
  const typed = valuePrefix.toLowerCase();
  const values = meta.staticValues ?? DYNAMIC_VALUE_STUBS[meta.prefix] ?? [];
  // Preserve the operator the user committed to (`priority>=HIGH`), falling back
  // to the colon-equality form for the default `=` operator.
  const head = operator === "=" ? meta.prefix : `${meta.key}${operator}`;
  return values
    .filter((value) => value.toLowerCase().includes(typed))
    .map((value) => ({
      insert: `${head}${value}`,
      label: value,
      withTrailingSpace: true,
    }));
}

function nextIndex(current: number, length: number): number {
  if (current < 0) {
    return 0;
  }
  return (current + 1) % length;
}

function prevIndex(current: number, length: number): number {
  if (current < 0) {
    return length - 1;
  }
  return (current - 1 + length) % length;
}
