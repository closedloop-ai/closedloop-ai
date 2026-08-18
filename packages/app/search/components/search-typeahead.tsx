"use client";

import type { SearchHit } from "@repo/api/src/types/search";
import { SearchMode } from "@repo/api/src/types/search";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { SidebarSearchForm } from "../../shared/components/sidebar-search-form";
import { useUnifiedSearch } from "../hooks/use-search";
import { useSearchIntellisense } from "../hooks/use-search-intellisense";
import { searchHitOrgRelativeRoute } from "../lib/search-display";
import { SearchFtsDropdown } from "./search-fts-dropdown";
import { SearchIntellisenseOverlay } from "./search-intellisense-overlay";

/** How many prefix-mode suggestions to surface in the dropdown. */
const TYPEAHEAD_LIMIT = 6;

/**
 * Build the per-instance listbox + option ids from a `useId` seed. Scoping the
 * ids per instance keeps two mounted typeaheads (the sidebar box and the
 * `/search` page bar) from sharing `aria-controls`/`aria-activedescendant`
 * targets, so one combobox can never claim the other's popup or options.
 */
function typeaheadIds(seed: string): {
  listboxId: string;
  optionId: (index: number) => string;
} {
  return {
    listboxId: `${seed}-listbox`,
    optionId: (index: number) => `${seed}-option-${index}`,
  };
}

type SearchTypeaheadProps = {
  /** Controlled input text. */
  value: string;
  /** Adapter-owned native form target for pre-hydration/no-JS submits. */
  nativeAction?: string;
  /** Adapter-owned native form method. */
  nativeMethod?: "get" | "post";
  /** Adapter-owned native query field name. */
  nativeInputName?: string;
  /** Whether the clear affordance should render. */
  showClear: boolean;
  /** Full-query submit (Enter / native submit). */
  onSubmit: (value: string) => void;
  /** Controlled input change. */
  onValueChange: (value: string) => void;
  /** Clear affordance activated. */
  onClear: () => void;
  /** Called after a suggestion is chosen (e.g. to close/reset the input). */
  onSelectHit?: (hit: SearchHit) => void;
  /**
   * Suppress the free-text FTS suggestion dropdown, leaving ONLY the `:`/`@`
   * intellisense overlay. Used by a surface that already renders its own inline
   * unified results list (the mobile search sheet) so the floating dropdown does
   * not stack on top of that list. The intellisense overlay stays available
   * because it edits the query in place rather than being a second result view.
   */
  suppressFtsDropdown?: boolean;
};

/**
 * FEA-3873/FEA-3930 sidebar search box. Composes the shared
 * {@link SidebarSearchForm} with two mutually-exclusive combobox popups:
 *   1. an INTELLISENSE overlay (FEA-3930) that reads the caret position and, when
 *      it sits inside a `:filter` token or an `@mention`, surfaces the filter
 *      keys / enum values / org members that complete it, committing a
 *      suggestion rewrites the input token and applies the structured filter;
 *   2. a prefix-mode ({@link SearchMode.Prefix}) FTS suggestion dropdown for free
 *      text, surfacing ranked cross-entity hits with a deep link.
 * The input is a single ARIA combobox; `aria-activedescendant`, arrow-key nav,
 * Enter-to-commit and Escape-to-close drive whichever popup is open. Shared
 * across the web app and the desktop renderer via `@repo/app`.
 */
export function SearchTypeahead({
  value,
  nativeAction,
  nativeMethod,
  nativeInputName,
  showClear,
  onSubmit,
  onValueChange,
  onClear,
  onSelectHit,
  suppressFtsDropdown = false,
}: SearchTypeaheadProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [caret, setCaret] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigation = useNavigation();
  const buildOrgPath = useOrgPath();
  // Per-instance ARIA ids so two mounted typeaheads never collide.
  const { listboxId, optionId } = typeaheadIds(useId());

  // The intellisense state machine reads the live value + caret to decide which
  // structured surface (keys/values/members) to show, and gates its own dynamic
  // fetches on the active surface.
  const intellisense = useSearchIntellisense(value, caret);
  const intellisenseOpen = isFocused && intellisense.isOpen;

  // The FTS suggestion query fires only when the box is focused, past the 2-char
  // floor, AND the intellisense overlay is NOT taking the popup slot, the two
  // popups are mutually exclusive, so an idle/structured box issues no FTS
  // request. `suppressFtsDropdown` turns the free-text dropdown off entirely so
  // a surface with its own inline results list issues no redundant query. An
  // explicit `enabled` overrides the hook's gate, so re-assert the floor here.
  const ftsEnabled =
    !suppressFtsDropdown &&
    isFocused &&
    !intellisenseOpen &&
    value.trim().length >= MIN_TYPEAHEAD_QUERY_LENGTH;
  const { data, isLoading, isError } = useUnifiedSearch(
    { query: value, mode: SearchMode.Prefix, limit: TYPEAHEAD_LIMIT },
    { enabled: ftsEnabled }
  );

  const suggestions = data?.results ?? [];
  const ftsOpen =
    !(suppressFtsDropdown || intellisenseOpen) &&
    isFocused &&
    value.trim().length >= MIN_TYPEAHEAD_QUERY_LENGTH;

  // The row count of whichever popup is open, so keyboard nav wraps within it.
  const optionCount = intellisenseOpen
    ? intellisense.rows.length
    : suggestions.length;

  // Clamp a stale keyboard cursor if the option set shrank out from under it so
  // aria-activedescendant and Enter never point past the current list.
  const boundedActiveIndex = activeIndex >= optionCount ? -1 : activeIndex;

  const closeDropdown = () => {
    setIsFocused(false);
    setActiveIndex(-1);
  };

  const syncCaret = () => {
    const next = inputRef.current?.selectionStart;
    if (next !== null && next !== undefined) {
      setCaret(next);
    }
  };

  const selectHit = (hit: SearchHit) => {
    closeDropdown();
    onSelectHit?.(hit);
  };

  // Commit an intellisense row: rewrite the input token, move the caret past it,
  // and keep the box focused so the user keeps typing (a chosen `key:` opens the
  // value surface next).
  const commitIntellisense = (index: number) => {
    const result = intellisense.commitRow(index);
    if (!result) {
      return;
    }
    onValueChange(result.text);
    setActiveIndex(-1);
    // Restore focus + caret after the controlled re-render applies the new text.
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.setSelectionRange(result.caret, result.caret);
        setCaret(result.caret);
      }
    });
  };

  // Commit a highlighted FTS suggestion on Enter: navigate to it instead of
  // submitting the raw query. Only hits that build a safe route navigate — a hit
  // missing its route fields yields a null route, so the native submit keeps
  // Enter and the query is submitted rather than landing on a dead route
  // (mirrors the plain-row rendering in UnifiedSearchResults).
  const commitFtsHit = (event: KeyboardEvent<HTMLInputElement>) => {
    const hit = suggestions[boundedActiveIndex];
    const route = hit ? searchHitOrgRelativeRoute(hit) : null;
    if (hit && route !== null) {
      event.preventDefault();
      selectHit(hit);
      navigation.navigate(buildOrgPath(route));
    }
  };

  const handleEnterKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (boundedActiveIndex < 0) {
      return;
    }
    if (intellisenseOpen) {
      event.preventDefault();
      commitIntellisense(boundedActiveIndex);
      return;
    }
    commitFtsHit(event);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      closeDropdown();
      return;
    }
    if (!(intellisenseOpen || ftsOpen) || optionCount === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % optionCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + optionCount) % optionCount);
      return;
    }
    if (event.key === "Enter") {
      handleEnterKey(event);
    }
  };

  const isOpen = intellisenseOpen || ftsOpen;
  const activeDescendant =
    isOpen && boundedActiveIndex >= 0
      ? optionId(boundedActiveIndex)
      : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus-out tracking only closes the dropdown; the input and result links carry the interactivity.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: focus-out tracking only closes the dropdown; the input and result links carry the interactivity.
    <div
      className="relative"
      onBlur={(event) => {
        // Close the dropdown when focus leaves the whole typeahead (input +
        // dropdown) to anywhere else on the page. `isFocused` is only ever set
        // true (on input change), so without this it stays stuck open after a
        // click elsewhere. `relatedTarget` null (blur to a non-focusable target)
        // also counts as leaving.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          closeDropdown();
        }
      }}
    >
      <SidebarSearchForm
        comboboxProps={{
          "aria-activedescendant": activeDescendant,
          "aria-controls": listboxId,
          "aria-expanded": isOpen,
        }}
        inputRef={inputRef}
        nativeAction={nativeAction}
        nativeInputName={nativeInputName}
        nativeMethod={nativeMethod}
        onClear={onClear}
        onInputKeyDown={handleInputKeyDown}
        onInputSelect={syncCaret}
        onSubmit={(submitted) => {
          closeDropdown();
          onSubmit(submitted);
        }}
        onValueChange={(next) => {
          setActiveIndex(-1);
          setIsFocused(true);
          onValueChange(next);
          // The controlled value updates on the same tick; read the caret after
          // so the intellisense surface tracks where the user is typing.
          requestAnimationFrame(syncCaret);
        }}
        showClear={showClear}
        value={value}
      />

      {isOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: focus-within tracking only toggles the popup; the input and result rows carry the interactivity.
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: focus-within tracking only toggles the popup; the input and result rows carry the interactivity.
        <div
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              closeDropdown();
            }
          }}
        >
          {intellisenseOpen ? (
            <SearchIntellisenseOverlay
              activeIndex={boundedActiveIndex}
              listboxId={listboxId}
              onSelect={commitIntellisense}
              optionId={optionId}
              view={intellisense}
            />
          ) : (
            <SearchFtsDropdown
              activeIndex={boundedActiveIndex}
              isError={isError}
              isLoading={isLoading}
              listboxId={listboxId}
              onSelectHit={selectHit}
              optionId={optionId}
              suggestions={suggestions}
            />
          )}
        </div>
      )}
    </div>
  );
}

const MIN_TYPEAHEAD_QUERY_LENGTH = 2;
