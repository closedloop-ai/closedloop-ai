"use client";

import { useMemo } from "react";
import {
  commitFilterKey,
  commitFilterValue,
  commitMemberMention,
  type FilterKeySuggestion,
  filterKeySuggestions,
  filterStaticValues,
  IntellisenseMode,
  type IntellisenseState,
  intellisenseStateAt,
} from "../lib/search-intellisense";
import {
  filterSuggestionOptions,
  type SuggestionOption,
  type SuggestionsResult,
  useMemberSuggestions,
  useProjectSuggestions,
} from "./use-search-suggestions";

/**
 * FEA-3930 Slice 5, the controller that turns the raw input + caret into the
 * intellisense overlay's rendered rows, its async state, and a commit action.
 * It runs the pure {@link intellisenseStateAt} state machine, fetches the
 * dynamic value source only when the active surface needs it (`@` members /
 * `:project` list), and exposes a single flat list of rows the overlay renders
 * and the keyboard handler selects across. The caller owns the caret (a ref to
 * the input) and the raw value; this hook is presentation-agnostic.
 */

/**
 * One overlay row, discriminated by which surface produced it. A `member` row
 * commits as an `@handle` mention; a `dynamic-value` row is a fetched value for a
 * `:key=` filter (a project), so it commits as `key:value` like a static value,
 * NOT as a mention.
 */
export type IntellisenseRow =
  | { kind: "key"; suggestion: FilterKeySuggestion }
  | { kind: "value"; value: string }
  | { kind: "dynamic-value"; option: SuggestionOption }
  | { kind: "member"; option: SuggestionOption };

/** The full overlay view-model for the current caret position. */
export type IntellisenseView = {
  /** True when a structured surface is active and has something to show. */
  isOpen: boolean;
  /** Which surface is active, drives the header/aria labels. */
  mode: IntellisenseState["mode"];
  rows: IntellisenseRow[];
  /** True while a dynamic source (members/projects) is fetching. */
  isLoading: boolean;
  /** True when a dynamic source settled in error. */
  isError: boolean;
  /**
   * Rewrite the input for the row at `index`. Returns the new raw text and the
   * caret to place, or null when the index is out of range. The caller applies
   * the value + moves the caret.
   */
  commitRow: (index: number) => { text: string; caret: number } | null;
};

const DYNAMIC_VALUE_LIMIT = 8;
const STATIC_VALUE_LIMIT = 8;

/**
 * Whether the active surface is a dynamic member source, used to gate the
 * members fetch so it only fires while the `@` overlay is open.
 */
function isMemberMode(state: IntellisenseState): boolean {
  return state.mode === IntellisenseMode.Members;
}

/**
 * Whether the active surface is the dynamic project value source, used to gate
 * the projects fetch so it only fires while the `:project` overlay is open.
 */
function isProjectMode(state: IntellisenseState): boolean {
  return state.mode === IntellisenseMode.DynamicValues;
}

function keyRows(filter: string): IntellisenseRow[] {
  return filterKeySuggestions(filter).map((suggestion) => ({
    kind: "key" as const,
    suggestion,
  }));
}

function staticValueRows(state: IntellisenseState): IntellisenseRow[] {
  const values = filterStaticValues(state.staticValues ?? [], state.filter);
  return values.slice(0, STATIC_VALUE_LIMIT).map((value) => ({
    kind: "value" as const,
    value,
  }));
}

function memberRows(
  options: SuggestionOption[],
  filter: string
): IntellisenseRow[] {
  return filterSuggestionOptions(options, filter)
    .slice(0, DYNAMIC_VALUE_LIMIT)
    .map((option) => ({ kind: "member" as const, option }));
}

function dynamicValueRows(
  options: SuggestionOption[],
  filter: string
): IntellisenseRow[] {
  return filterSuggestionOptions(options, filter)
    .slice(0, DYNAMIC_VALUE_LIMIT)
    .map((option) => ({ kind: "dynamic-value" as const, option }));
}

/**
 * Build the flat overlay rows for the active surface. Dynamic surfaces read from
 * the already-fetched `dynamic` source; static/key surfaces are computed purely.
 */
function buildRows(
  state: IntellisenseState,
  dynamic: SuggestionsResult
): IntellisenseRow[] {
  switch (state.mode) {
    case IntellisenseMode.FilterKeys:
      return keyRows(state.filter);
    case IntellisenseMode.StaticValues:
      return staticValueRows(state);
    case IntellisenseMode.DynamicValues:
      return dynamicValueRows(dynamic.options, state.filter);
    case IntellisenseMode.Members:
      return memberRows(dynamic.options, state.filter);
    default:
      return [];
  }
}

/**
 * Commit the chosen row back into the raw input. Value/member rows carry the
 * key meta + operator from the intellisense state so the rewrite rebuilds the
 * full `key<op>value` / `@handle` token; a key row rewrites to the `key:` prefix
 * so the value surface opens next.
 */
function commitRowAt(
  raw: string,
  state: IntellisenseState,
  rows: IntellisenseRow[],
  index: number
): { text: string; caret: number } | null {
  const row = rows[index];
  if (!row) {
    return null;
  }
  if (row.kind === "key") {
    return commitFilterKey(raw, state.token, row.suggestion.meta);
  }
  if (row.kind === "member") {
    return commitMemberMention(raw, state.token, row.option.value);
  }
  // A static `value` or a fetched `dynamic-value` (project) both commit as
  // `key<op>value` using the key meta + operator the state resolved. The value
  // is the enum member (static) or the resolvable slug/name (dynamic).
  if (!(state.keyMeta && state.operator)) {
    return null;
  }
  const value = row.kind === "value" ? row.value : row.option.value;
  return commitFilterValue(
    raw,
    state.token,
    state.keyMeta,
    state.operator,
    value
  );
}

export function useSearchIntellisense(
  raw: string,
  caret: number
): IntellisenseView {
  const state = useMemo(() => intellisenseStateAt(raw, caret), [raw, caret]);

  // Gate each dynamic source on its surface being active so an idle box (or a
  // static/key surface) issues no member/project request.
  const members = useMemberSuggestions(isMemberMode(state));
  const projects = useProjectSuggestions(isProjectMode(state));
  const dynamic = isMemberMode(state) ? members : projects;

  const rows = useMemo(() => buildRows(state, dynamic), [state, dynamic]);

  const isDynamic =
    state.mode === IntellisenseMode.Members ||
    state.mode === IntellisenseMode.DynamicValues;
  const isLoading = isDynamic && dynamic.isLoading;
  const isError = isDynamic && dynamic.isError;

  // A structured surface is "open" when it is one of the intellisense modes and
  // it has rows OR is still resolving/erroring a dynamic source (so the overlay
  // can show the loading/error/empty state honestly). FreeText never opens the
  // structured overlay, the caller falls back to FTS suggestions there.
  const isStructured = state.mode !== IntellisenseMode.FreeText;
  const isOpen = isStructured && (rows.length > 0 || isLoading || isError);

  return {
    isOpen,
    mode: state.mode,
    rows,
    isLoading,
    isError,
    commitRow: (index: number) => commitRowAt(raw, state, rows, index),
  };
}
