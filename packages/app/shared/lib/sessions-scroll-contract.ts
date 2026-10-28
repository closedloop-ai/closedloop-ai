// PLN-1950 slice 5 / ISS-9555 decision 7: the Sessions list keeps TWO scroll
// restore mechanisms, deliberately not merged. `apps/app`'s Sessions route owns
// its own scroll container and persists position in `history.state` (see
// `sessions-route-state.ts`), because that container is route-scoped and the
// History API is already the source of truth for the page it is on. On desktop
// the store belongs to the App SHELL and serves every route, keyed by href in a
// module-level LRU map (`use-content-scroll-restoration.ts`); the Sessions view
// does not own it, it only publishes the element that actually scrolls -- the
// grid band -- for the shell to measure (ISS-12471, which fixed a shell that
// was measuring its own content viewport on a route that cannot overflow).
// Desktop
// also uses no History API (no `pushState`, no `popstate`, no `history.state`
// read), so the web hook would compile, run, and restore nothing there. Both
// mechanisms are shipped and tested; two of them writing the same `scrollTop`
// would be a bug, not a merge target. This module owns only the pieces the two
// happen to already agree on -- do not "fix" the remaining duplication into a
// shared implementation; that would either break desktop (no history state to
// read) or make web's route-scoped position leak into the App-shell's
// every-route cache.
//
// What this module declares once and BOTH hosts genuinely call through it:
// the retry-attempt ceiling and the scrollHeight/clientHeight clamp math.
// `hasStoredScrollPosition` below is declared here too, but only desktop's
// content-scroll-restoration hook (`use-content-scroll-restoration.ts`)
// actually imports and calls it -- web's route keeps
// its own independently-written, narrower inline gate
// (`sessions-route-state.ts`) that happens to produce compatible results
// today, not a check layered on top of this function. What is NOT unified,
// on purpose:
// - The retry loop's own continuation predicate. Web stops scheduling more
//   frames as soon as the container has grown scrollable (`maxScrollTop > 0`)
//   and applies the clamp exactly once; desktop applies the clamp on every
//   attempt and keeps retrying only while its own assignment didn't take
//   (`element.scrollTop <= 0` after assigning). They converge to the same
//   attempt ceiling, not the same loop shape.
// - Web's own gate additionally treats a remembered position of exactly 0 as
//   "nothing to restore" (narrower than "a value exists"); desktop has no
//   such narrowing. `hasStoredScrollPosition` below covers only the wider,
//   common case, and only desktop currently runs it.
// - Web's restore is further gated by an external `restoreWhen` readiness
//   signal (pending/placeholder query state) supplied by its caller; desktop
//   has no equivalent concept at the App-shell level, so no such gate exists
//   there. Recorded as a divergence, not invented for desktop.
// - The scroll key's construction. Web composes an explicit
//   `org:<org>:sessions:page:<index>` string; desktop keys by the App-shell's
//   full href, a broader keyspace covering every route that happens to vary by
//   page for Sessions because the page index lives in the URL. Neither
//   construction is shared -- only the invariant that a key names one rendered
//   page-view, never a whole route or a whole session, is declared once below.

/** Retry ceiling for a bounded rAF-driven scroll-restore attempt, shared by both hosts' independent retry loops. */
export const SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS = 30;

/**
 * Identifies exactly one rendered page-view whose scroll position is
 * remembered -- never a whole route and never a whole session. Each host
 * constructs its own key (see the module header); this alias exists so a
 * caller can name the invariant without repeating this comment.
 */
export type SessionsScrollKey = string;

/** The furthest a container can scroll today, given its current layout. */
export function computeMaxScrollTop(
  scrollHeight: number,
  clientHeight: number
): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Clamps a remembered scroll target to what the container can currently hold.
 * A container that has not grown scrollable yet (`maxScrollTop <= 0`) passes
 * the desired value through unclamped -- callers that only assign once the
 * container IS scrollable (web) never observe this branch; a caller that
 * assigns unconditionally on every retry attempt (desktop) relies on it.
 */
export function clampScrollRestoreTarget(
  desiredScrollTop: number,
  maxScrollTop: number
): number {
  return maxScrollTop > 0
    ? Math.min(desiredScrollTop, maxScrollTop)
    : desiredScrollTop;
}

/**
 * The one restore-gate invariant both hosts' production behavior agrees on:
 * never attempt to restore when nothing was remembered for the key. Desktop's
 * content-scroll-restoration hook (`use-content-scroll-restoration.ts`) calls
 * this function directly. Web's route (`sessions-route-state.ts`) does NOT
 * call it -- it keeps its own independently-written, narrower gate (a
 * remembered `0` also counts as nothing to restore there, and it is further
 * gated by an external readiness signal) that happens to satisfy the same
 * invariant today. That the two diverge exactly at 0 -- this function accepts
 * it, web's `hasWebStoredScrollPosition` rejects it -- is pinned by a
 * dedicated assertion beside the web conformance block in
 * `sessions-route-state.test.tsx`; update it if either gate's semantics
 * change.
 */
export function hasStoredScrollPosition(
  value: number | null | undefined
): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * One host's view of the contract, wired to whatever it actually runs in
 * production (its own re-export of the shared bound/functions, or a thin
 * test-only reflection of a gate this module does not own). The conformance
 * factory below asserts against this shape so the same assertions execute in
 * both hosts' own vitest lanes.
 */
export type SessionsScrollContractAdapter = {
  /** Names which host is being checked, for a failing assertion's message. */
  hostLabel: string;
  maxRestoreAttempts: number;
  computeMaxScrollTop: (scrollHeight: number, clientHeight: number) => number;
  clampScrollRestoreTarget: (
    desiredScrollTop: number,
    maxScrollTop: number
  ) => number;
  hasStoredScrollPosition: (value: number | null | undefined) => boolean;
};

/**
 * Runs the shared sessions-scroll conformance assertions against one host's
 * adapter: the retry bound matches this module's constant, a restore is never
 * attempted with nothing remembered, one is attempted when something is, and
 * the clamp math agrees with {@link clampScrollRestoreTarget} across a battery
 * of scrollable, overflowing, non-scrollable, and zero-target cases. Throws on
 * the first mismatch rather than depending on a test-framework `expect`, so
 * this stays importable from a pure module with no test-runner dependency.
 */
export function runSessionsScrollContractConformance(
  adapter: SessionsScrollContractAdapter
): void {
  assertContractEqual(
    adapter.maxRestoreAttempts,
    SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS,
    `${adapter.hostLabel}: retry bound must match the shared contract`
  );

  assertContractEqual(
    adapter.hasStoredScrollPosition(undefined),
    false,
    `${adapter.hostLabel}: must never attempt a restore when nothing is remembered`
  );
  assertContractEqual(
    adapter.hasStoredScrollPosition(null),
    false,
    `${adapter.hostLabel}: must never attempt a restore when nothing is remembered`
  );
  assertContractEqual(
    adapter.hasStoredScrollPosition(120),
    true,
    `${adapter.hostLabel}: must attempt a restore when a position is remembered`
  );

  const clampCases: ReadonlyArray<{
    desiredScrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    expected: number;
  }> = [
    {
      desiredScrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 600,
      expected: 400,
    },
    {
      desiredScrollTop: 900,
      scrollHeight: 1000,
      clientHeight: 600,
      expected: 400,
    },
    {
      desiredScrollTop: 50,
      scrollHeight: 300,
      clientHeight: 600,
      expected: 50,
    },
    { desiredScrollTop: 0, scrollHeight: 1000, clientHeight: 600, expected: 0 },
  ];
  for (const testCase of clampCases) {
    const maxScrollTop = adapter.computeMaxScrollTop(
      testCase.scrollHeight,
      testCase.clientHeight
    );
    const result = adapter.clampScrollRestoreTarget(
      testCase.desiredScrollTop,
      maxScrollTop
    );
    assertContractEqual(
      result,
      testCase.expected,
      `${adapter.hostLabel}: clamp mismatch for desired=${testCase.desiredScrollTop} scrollHeight=${testCase.scrollHeight} clientHeight=${testCase.clientHeight}`
    );
  }
}

function assertContractEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message} (expected ${String(expected)}, got ${String(actual)})`
    );
  }
}
