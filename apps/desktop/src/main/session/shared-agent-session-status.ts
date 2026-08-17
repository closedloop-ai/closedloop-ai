/**
 * ISS-4556 / ISS-4559: the desktop Local lane's DISPLAYED-status vocabulary —
 * ONE derivation behind the Sessions row's Status cell and the Status column
 * SORT, and the projection the Status FACET (`matchesStatusFilter` in
 * `session-status-filter-match.ts`) is written to agree with.
 *
 * Extracted from `shared-agent-sessions-api.ts` (a shrink-only grandfathered
 * over-ceiling file) because these helpers are one cohesive responsibility, and
 * because the whole point of ISS-4556/ISS-4559 is that the three derivations must
 * be one statement rather than three parallel ones that drift. FEA-4301 added the
 * projection and wired it into the sort only; the row status kept reading the raw
 * canonical value (ISS-4556) and the ACTIVE facet kept an awaiting-input
 * exclusion the projection had no counterpart for (ISS-4559), which hid an
 * ended + awaiting-input row from BOTH the Active and Waiting facets.
 *
 * The status VOCABULARY itself (`canonicalSharedStatus`,
 * {@link TERMINAL_SHARED_STATUSES}) is imported from the facet matcher rather
 * than restated here, so the projection and the facet cannot disagree about what
 * "terminal" or "canonical" means.
 *
 * The cloud mirror of this module is
 * `apps/api/app/agent-sessions/service/session-status-projection.ts` plus
 * `buildStatusFacetPredicate` in `query-builder.ts`.
 */

import {
  DISPLAYED_SESSION_STATUS,
  isDisplayOnlySessionStatus,
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { isDisplayedStatusParityEnabled } from "./displayed-status-parity-gate.js";
import { servedSessionActivityAt } from "./session-activity-anchor.js";
import { parseNullableSessionDate } from "./session-instant.js";
import {
  canonicalSharedStatus,
  TERMINAL_SHARED_STATUSES,
} from "./session-status-filter-match.js";

// FEA-4301 / ISS-4586 (desktop parity): the lifecycle rank of each DISPLAYED
// shared status, mirroring the cloud `DISPLAYED_STATUS_RANK`. The six keys below
// are the whole map: ISS-5592 retired `completed`/`abandoned` and then the
// `running`/`failed` aliases, so none of them keys this and a row carrying one
// degrades to {@link UNKNOWN_SHARED_STATUS_RANK} like any other unrecognized
// value — which matches the Unknown badge it renders. A header click orders the
// Status column identically in desktop Local mode and the cloud.
//
// ISS-4556: `stale` and `unknown` carry the ranks the cloud
// `DISPLAYED_STATUS_RANK` gives them, because the projection below now PRODUCES
// both. Neither is a lifecycle stage, so both rank after `error` and stay out of
// the way; `stale` sorts ahead of `unknown` because it is at least a statement
// about the session. `isKnownSharedStatus` still reports them as not-known, so
// their placement remains direction-independent (FEA-4330) — the rank only
// orders them relative to each other inside that trailing group.
const DISPLAYED_SHARED_STATUS_RANK: Record<string, number | undefined> = {
  active: 0,
  waiting: 1,
  inactive: 2,
  error: 3,
  stale: 4,
  unknown: 5,
};
const UNKNOWN_SHARED_STATUS_RANK = Object.keys(
  DISPLAYED_SHARED_STATUS_RANK
).length;

/**
 * FEA-4301 (desktop parity): the DISPLAYED status of a local session — the
 * canonical-shared status, EXCEPT a non-terminal row awaiting user input
 * (`awaitingInputSince` set, not yet ended) DISPLAYS as Waiting. This mirrors the
 * cloud `projectDisplayedSessionStatus` so the Status column, the Status filter,
 * and the Status SORT all key off the same displayed vocabulary. Desktop stores
 * waiting as a timestamp on a non-terminal `active` row, never as a persisted
 * status.
 *
 * ISS-4556 / ISS-4559: this is now the SINGLE statement all three read. The row
 * status projects through it (`mapListItem`), the sort ranks its output
 * (`session-working-set-sort.ts`), and the Status facet's `displaysAsWaiting`
 * clause is byte-for-byte this condition — so a row can no longer render one
 * status, sort under a second, and be returned by the facet of a third.
 *
 * ISS-4556 (gated): past the Waiting projection this DELEGATES to the shared
 * {@link resolveDisplayedSessionStatus}, exactly as the cloud
 * `projectDisplayedSessionStatus` has since ISS-5366. Without that delegation
 * "the SINGLE statement all three read" was not true of the two DISPLAY-ONLY
 * values: a long-silent `active` row served `active` here while the cloud served
 * `stale`, and the Status SORT ranked it 0 (Active) against the cloud's 4 —
 * under a badge that reads "Stale" on both surfaces, because the shared table row
 * applies the same fold client-side (`session-table-row.ts`). The Status FACET
 * (`matchesStatusFilter`) already answered `stale` for that row, so the sort and
 * the served value were the two derivations left out of the SSOT.
 *
 * Only the two honesty folds are adopted, for the reason the cloud states: the
 * shared resolver also collapses the legacy terminals (`completed`/`abandoned` →
 * `inactive`) and the aliases, and adopting THAT would change what this read
 * RETURNS for rows the wire contract still expects to carry their raw spelling.
 *
 * @param displayedStatusParity - the `sessions-displayed-status-parity` gate.
 *   Defaults false (the module's fail-closed convention): OFF, this returns the
 *   pre-ISS-4556 projection byte-for-byte, so the row status and the Status sort
 *   keep today's ungated behavior.
 */
export function projectDisplayedSharedStatus(
  session: SyncedAgentSession,
  displayedStatusParity = false,
  now?: Date
): string {
  const canonical = canonicalSharedStatus(session.status);
  const isAwaitingInput =
    !TERMINAL_SHARED_STATUSES.has(canonical) &&
    Boolean(session.awaitingInputSince) &&
    !session.endedAt;
  if (isAwaitingInput) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
  if (!displayedStatusParity) {
    return canonical;
  }
  const displayed = resolveDisplayedSessionStatus({
    status: canonical,
    // The SAME `lastActivityAt ?? startedAt` anchor the facet matcher and the
    // cloud projection use: a row with no activity timestamp has no evidence of
    // recent life, so falling back to the start time keeps the least-evidenced
    // rows from being the ones exempted from the fold.
    lastActivityAt: session.lastActivityAt,
    startedAt: session.startedAt,
    // ISS-6270: the caller's instant, not an ambient clock read. The staleness
    // fold happens HERE when the gate is on, so a caller that pins one instant
    // for a whole sort (`sessionDurationMs`) would otherwise have its row
    // judged against `Date.now()` on the gate-ON path and against its own
    // `now` on the gate-OFF path — two clocks for one verdict. Undefined keeps
    // the pre-existing ambient read for every caller that passes nothing.
    now,
  });
  if (isDisplayOnlySessionStatus(displayed)) {
    return displayed;
  }
  return canonical;
}

/**
 * ISS-6270: the status a Local list row is actually SERVED with — the one value
 * `mapListItem` puts on the wire and therefore the one the renderer's shared
 * mapper folds on top of.
 *
 * Owned here rather than restated at each call site because it is not the same
 * thing as {@link projectDisplayedSharedStatus}: with the
 * `sessions-displayed-status-parity` gate OFF this serves the raw canonical
 * status with NO Waiting projection, which is today's ungated behavior. A second
 * copy of that ternary is how a consumer ends up keying off a value the producer
 * never served — the class of drift ISS-6270 exists to close.
 *
 * @see resolveDisplayedSharedSessionStatus for what the RENDERER then makes of
 * this value.
 */
export function servedSharedSessionStatus(
  session: SyncedAgentSession,
  now?: Date
): string {
  return isDisplayedStatusParityEnabled()
    ? projectDisplayedSharedStatus(session, true, now)
    : canonicalSharedStatus(session.status);
}

/**
 * ISS-6270: the status a Local row DISPLAYS — {@link servedSharedSessionStatus}
 * with the renderer's own fold applied on top, which is precisely the pipeline
 * behind the Sessions cells: `mapListItem` serves a status, and
 * `agentSessionToSessionTableRow` resolves the displayed one from it
 * (`packages/app/agents/lib/session-table-row.ts`).
 *
 * That client-side fold has run UNGATED since ISS-5366 retired
 * `sessions-honest-unknown-states`, so the answer here is gate-INDEPENDENT for
 * the staleness case: gate off the fold turns a long-silent `active` into
 * `stale`, gate on the producer has already done it and the fold is idempotent.
 * A main-process consumer that reads the served value alone therefore disagrees
 * with the rendered cell for exactly the population ISS-6270 is about.
 *
 * The Status column SORT deliberately does NOT route through here: its ranking
 * is inside the closed-by-default ISS-4556 rollout and must stay byte-identical
 * while the gate is off. Duration has no such rollout — its cell has folded
 * ungated all along, so its sort key must too, or the column orders by a number
 * the row does not render.
 */
export function resolveDisplayedSharedSessionStatus(
  session: SyncedAgentSession,
  now?: Date
): string {
  // ISS-6270 (wongk, #5111 review): the renderer's awaiting-input projection
  // runs AHEAD of the staleness fold, so this mirror has to as well. Without it
  // a row stored `active` with `awaitingInputSince` set and silent past the
  // cutoff renders "Waiting" with a live, growing Duration cell
  // (`resolveSessionDurationLifecycle(waiting)` is Running) while this read
  // folded it to `stale` and blanked its sort key — the same cell-disagrees-with
  // -comparator defect ISS-6270 closes, recreated in the opposite direction. The
  // desktop Status FACET already gathers that population under Waiting with the
  // gate OFF (`displaysAsWaiting`), so this restores agreement rather than
  // enabling any part of the gated rollout.
  const servedStatus = servedSharedSessionStatus(session, now);
  if (servedRowAwaitsInput(session) && isLiveSharedStatus(servedStatus)) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
  return resolveDisplayedSessionStatus({
    // wongk (#5111): the anchor `mapListItem` SERVES, not the raw strings.
    // `resolveDisplayedSessionStatus` resolves the first PARSEABLE of
    // `lastActivityAt`/`startedAt`, so handing it the raw pair SKIPPED a
    // malformed `lastActivityAt` and judged the row by its (recent) start time —
    // while the wire value the renderer folds is that same malformed string
    // already parsed to the epoch, which reads Stale. The row's Duration cell
    // rendered blank while this key kept growing against the clock. One
    // projection, so the two cannot answer differently; `startedAt` is not
    // passed because the shared anchor has already floored on it.
    lastActivityAt: servedSessionActivityAt(session),
    // The SERVED status, resolved ONCE above: `now` reaches that projection too,
    // because with the parity gate on the staleness fold runs inside it rather
    // than in this client fold, and passing `now` only here would leave the
    // gate-ON path on a second clock.
    status: servedStatus,
    now,
  });
}

/**
 * FEA-4301 (desktop parity): the lifecycle rank of a DISPLAYED shared status,
 * ordered Active → Waiting → Inactive → Error — the SAME
 * lifecycle order the cloud `displayedStatusRank` uses. ISS-5592 removed the
 * desktop `failed` alias, so this map is now key-for-key identical to the
 * cloud's. An unknown (future/legacy) status ranks
 * last. Sorting the Status column by this rank rather than by the raw canonical
 * string (`localeCompare`) keeps a header click ordered identically in desktop
 * Local mode and the cloud.
 */
export function displayedSharedStatusRank(displayedStatus: string): number {
  const rank = DISPLAYED_SHARED_STATUS_RANK[displayedStatus];
  return rank ?? UNKNOWN_SHARED_STATUS_RANK;
}

/**
 * FEA-4301 (desktop parity): whether a displayed shared status is a known
 * lifecycle value (has a rank) rather than a future/legacy one. Lets the status
 * comparator keep unknown statuses last in BOTH directions, mirroring the cloud
 * comparator's direction-independent unknown-last placement.
 *
 * ISS-4556: the DISPLAY-ONLY members (`stale`, `unknown`) are reported as
 * not-known, mirroring the cloud `isKnownDisplayedStatus`. That is what keeps
 * their placement direction-INDEPENDENT now that the projection PRODUCES them:
 * they were pinned last in both directions only because they missed the rank
 * table, and naming them there would otherwise let a flipped `dir` promote
 * "Unknown" to the FRONT of a descending page — the exact FEA-4330 regression.
 */
export function isKnownSharedStatus(displayedStatus: string): boolean {
  if (isDisplayOnlySessionStatus(displayedStatus)) {
    return false;
  }
  return displayedStatus in DISPLAYED_SHARED_STATUS_RANK;
}

/**
 * ISS-6270: does the row `mapListItem` SERVES carry awaiting-input evidence —
 * the desktop main-process reading of the renderer's
 * `classifyAwaitingInputEvidence`
 * (`packages/app/agents/lib/session-displayed-status-with-waiting.ts`).
 *
 * It reads the SERVED timestamps, not the raw stored strings, for the reason
 * {@link servedSessionActivityAt} exists: the local producer puts both fields on
 * the wire through `parseNullableSessionDate`, which collapses an UNPARSEABLE
 * value to the same `null` as an absent one. So the renderer's third verdict
 * (`Unreadable`, which badges Unknown) is unreachable for a locally-served row —
 * it cannot see a corrupt instant here — and mirroring the served pair is what
 * keeps this read answering what the renderer was actually handed.
 *
 * A VALID `endedAt` settles it: the run is over (ISS-4654), so a straggler
 * `awaitingInputSince` beside it is not a claim that anyone is still waiting.
 *
 * The shared helper itself cannot be imported, and the reason is the BUNDLE, not
 * typecheck resolution: `apps/desktop/tsconfig.json` has set
 * `moduleResolution: "Bundler"` since PLN-999, so `tsc` would resolve
 * `@repo/app` source fine. What it cannot survive is packaging —
 * `packages/app/package.json` declares no `exports`, no `main`, and no `types`,
 * and `@repo/app` is absent from `WORKSPACE_INLINE` in
 * `apps/desktop/electron.vite.config.ts`, so main externalizes it and packaged
 * main would be left asking Node to load `.ts` source at runtime.
 * `DURATION_SORT_PARITY_CASES` is what holds the two readings together instead —
 * its awaiting-input case is pinned against the real renderer mapper in
 * `packages/app` and asserted against this comparator in
 * `apps/desktop/test/session-duration-sort-displayed-status.test.ts`.
 */
function servedRowAwaitsInput(session: SyncedAgentSession): boolean {
  if (parseNullableSessionDate(session.endedAt) !== null) {
    return false;
  }
  return parseNullableSessionDate(session.awaitingInputSince) !== null;
}

/**
 * ISS-6270: does this build read `status` as a LIVE run — the desktop mirror of
 * the renderer's `projectLiveWaiting` recognition test.
 *
 * Deliberately NARROWER than the facet's `!TERMINAL_SHARED_STATUSES.has(...)`,
 * and that difference is load-bearing rather than drift. The facet asks "is this
 * row not finished"; this asks "does this build know the status means the run is
 * running", which is what the renderer asks before it exempts a row from the
 * staleness fold. A version-skewed spelling the fold answers `unknown` for is
 * non-terminal but NOT live: the renderer leaves it Unknown with a blank
 * Duration cell, so projecting Waiting here would start timing a run neither
 * surface can measure — the fail-open
 * `session-displayed-status-with-waiting.ts` documents at length.
 *
 * The recognition test is {@link resolveDisplayedSessionStatus} with NO
 * timestamps: that applies the unrecognized fold while leaving the staleness
 * fold no anchor to fire on.
 *
 * Pinned by "keys an UNRECOGNIZED status awaiting input to the blank its served
 * row displays" in `apps/desktop/test/session-duration-sort-displayed-status.test.ts`,
 * which is the only shape where narrow and wide answer differently. That case
 * cannot live in `DURATION_SORT_PARITY_CASES` — the shared table states one
 * displayed span per shape, and this shape's differs between the gate-OFF
 * producer and both wide producers (cloud, and desktop gate-ON); the test says
 * so at length.
 */
function isLiveSharedStatus(status: string): boolean {
  const recognized = resolveDisplayedSessionStatus({ status });
  return (
    recognized === SESSION_STATUS.ACTIVE ||
    recognized === DISPLAYED_SESSION_STATUS.WAITING
  );
}
