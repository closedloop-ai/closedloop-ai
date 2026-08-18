// Pure view-state model for the prototype, kept out of the page so the sandbox's
// node-only test suite can exercise the expand/collapse and detail/back
// transitions directly (the suite has no jsdom/testing-library by design).
//
// Both the phase-expansion state and the "show all" state live ABOVE the
// breakdown/detail view switch (in the page), so opening a session and coming
// back does not collapse the phases the user had expanded.

export const BreakdownViewKind = {
  Breakdown: "breakdown",
  Session: "session",
} as const;
export type BreakdownViewKind =
  (typeof BreakdownViewKind)[keyof typeof BreakdownViewKind];

export type BreakdownView =
  | { kind: typeof BreakdownViewKind.Breakdown }
  | { kind: typeof BreakdownViewKind.Session; sessionId: string };

export const BREAKDOWN_VIEW: BreakdownView = {
  kind: BreakdownViewKind.Breakdown,
};

/** Add or remove a key from a set-like ordered list, without mutating it. */
export function toggleKey(
  keys: readonly string[],
  key: string
): readonly string[] {
  return keys.includes(key)
    ? keys.filter((entry) => entry !== key)
    : [...keys, key];
}

export function openSessionView(sessionId: string): BreakdownView {
  return { kind: BreakdownViewKind.Session, sessionId };
}

/** The session id to return keyboard focus to after leaving the detail view. */
export function focusTargetOnBack(view: BreakdownView): string | null {
  return view.kind === BreakdownViewKind.Session ? view.sessionId : null;
}
