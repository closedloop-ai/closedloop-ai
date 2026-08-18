/**
 * @file db-host-op-lane-registry.ts
 * @description ISS-5957 — the db-host op → admission-lane REGISTRY, and the
 * compile-time guard that makes declaring a lane mandatory.
 *
 * ## Why this file exists
 *
 * FEA-3150 built a correct memory-aware admission governor. ISS-5941 routed the
 * heavy `syncSource.*` reads through it. ISS-6027 then found that ISS-5938 had
 * moved the whole-corpus `dashboard.*` reads onto the same reader pool five
 * hours later, with no lane at all — a second escape of exactly the same shape
 * as the first, found only because a nightly reviewer happened to read both
 * diffs.
 *
 * The recurrence mechanism was that {@link BOUNDED_READ_OPS} was a HAND-WRITTEN
 * set. Its members were typed against the runtime's method names, so a RENAME
 * failed `tsc` — but an ADDITION did not. A new heavy op compiled, shipped, and
 * ran ungated, and nothing anywhere had to notice.
 *
 * This file inverts that. The lane is declared per OP, in a map that
 * `satisfies Record<keyof <the runtime interface>, DbHostAdmissionLane>`, and
 * {@link BOUNDED_READ_OPS} is DERIVED from those maps rather than restated. Add
 * a method to `AgentSessionSyncSource`, to the contract's `dashboard` member, or
 * to the Branch read facade, and `tsc` fails here until someone types a lane for
 * it. The mechanism is the one ISS-5712 already uses for boundary schemas
 * (`satisfies Record<keyof T, z.ZodTypeAny>`), applied to admission instead of
 * serialization.
 *
 * Declaring {@link DbHostAdmissionLane.Ungated} is a legitimate answer — most
 * ops are cheap and must stay ungated so the UI never queues behind a corpus
 * read. What the guard buys is that the answer is now a deliberate, reviewed
 * keystroke instead of an omission nobody could see.
 *
 * ## What the guard does NOT cover, stated plainly
 *
 * The db-host invoke surface is a PROXY (`db-host-agent-database.ts`): any
 * dotted property path is callable, including the entire Prisma delegate
 * namespace as `prisma.client.<model>.<method>` and raw
 * `prisma.read`/`$queryRawUnsafe` paths. That key space is open-ended, so no
 * `keyof` guard can enumerate it, and the heavy Branch corpus reads in
 * `database/branch-reads.ts` (`readLocalBranchLinkRows`,
 * `readBranchTokenAggregateRows`, …) arrive that way and remain UNGATED. ISS-5941
 * recorded that as needing "a separate mechanism"; it still does. The guard
 * covers the three NAMED namespaces where both escapes actually happened, and
 * nothing else. Do not read a green `tsc` as proof that every heavy read is
 * classified.
 *
 * `store:` ops are also out of scope here: they are dispatched by op-name STRING
 * through `db-host-store-op-registry.ts`, a different key space, and keep their
 * own {@link HEAVY_STORE_OPS} set in `db-host-op-lanes.ts`.
 */

import type { AgentSessionSyncSource } from "../../agent-sync/agent-session-sync-source.js";
import type { BranchReadFacadeMethods } from "../branch-read-facades.js";
import type { SqliteAgentDatabase } from "../sqlite-contract.js";

/**
 * Which admission lane an op takes on the db-host's generic invoke path.
 *
 * All three are ROUTED from this registry. `Exclusive` takes a different seam
 * from the other two — `dispatchDbHostInvoke` matches it against
 * {@link EXCLUSIVE_OPS} ahead of `runInvokeOp` and hands it to the width-1 gate
 * behind the FEA-2055 result cache — but the decision is still this map's, not a
 * literal restated in the dispatcher.
 */
export const DbHostAdmissionLane = {
  /** The shared semaphore in `db-host-op-lanes.ts` (`BOUNDED_READ_OP_LIMIT`). */
  BoundedRead: "boundedRead",
  /** The width-1 mutex, entered by `dispatchDbHostInvoke`, not by `runInvokeOp`. */
  Exclusive: "exclusive",
  /** Runs immediately. Correct for cheap, interactive, and write-path ops. */
  Ungated: "ungated",
} as const;
export type DbHostAdmissionLane =
  (typeof DbHostAdmissionLane)[keyof typeof DbHostAdmissionLane];

/**
 * The lanes `runInvokeOp` itself can route. `Exclusive` is deliberately absent:
 * it is reached through the insights result cache, which single-flights the
 * recompute and hands one value to every concurrent requester, so an op cannot
 * be given that lane without also being given that caching semantics.
 */
type InvokeRoutableLane = Exclude<
  DbHostAdmissionLane,
  typeof DbHostAdmissionLane.Exclusive
>;

/** Method names reachable as `syncSource.<name>` on the invoke surface. */
type SyncSourceOpName = Extract<keyof AgentSessionSyncSource, string>;

/** Method names reachable as `dashboard.<name>` on the invoke surface. */
type DashboardOpName = Extract<keyof SqliteAgentDatabase["dashboard"], string>;

/**
 * The ONE op that may carry {@link DbHostAdmissionLane.Exclusive}.
 *
 * `satisfies DashboardOpName` ties the literal to the contract, so renaming the
 * method fails `tsc` here rather than silently un-classifying it.
 */
const EXCLUSIVE_DASHBOARD_OP_NAME = "getInsights" satisfies DashboardOpName;

/**
 * Lane map for the `dashboard.*` namespace, and the constraint that makes
 * `Exclusive` a ROUTING FACT rather than a label.
 *
 * `Exclusive` is not a lane an author can hand to an arbitrary op: the seam that
 * implements it is the FEA-2055 insights result cache, which single-flights one
 * recompute across every concurrent requester. Declaring it on a second op would
 * have produced a registry that says "width-1 mutex" about an op nothing routes
 * there — the exact "declared but not load-bearing" state this ticket exists to
 * remove. So the type pins it to {@link EXCLUSIVE_DASHBOARD_OP_NAME} in both
 * directions: that op MUST be `Exclusive`, and no other op may be.
 */
type DashboardOpLaneMap = {
  [K in DashboardOpName]: K extends typeof EXCLUSIVE_DASHBOARD_OP_NAME
    ? typeof DbHostAdmissionLane.Exclusive
    : InvokeRoutableLane;
};

/**
 * The TOP-LEVEL Branch read facades on the contract. Unlike the raw Branch
 * corpus reads (which are `prisma.client.*` paths and unreachable by op name),
 * these are named methods the main-process Branch API calls through the proxy,
 * so each is its own invoke and each is selectable here.
 *
 * Derived from {@link BranchReadFacadeMethods} — the ONE canonical composite the
 * CONTRACT also composes these facades through — never from a hand-written
 * `Pick` of the names and never from the leaf interfaces re-intersected here.
 *
 * Both alternatives are allowlists wearing a `keyof`'s clothes. A `Pick` tracks
 * a RENAME but not an ADDITION. Re-intersecting the leaves is worse in a way
 * that is easy to miss: it exhausts whatever interfaces THIS file happens to
 * name, so a THIRD facade composed into `SqliteAgentDatabase` reached the proxy
 * with this map still compiling — the same addition-shaped escape ISS-5941 and
 * ISS-6027 both took. Sharing the composite makes the contract and the registry
 * enumerate the same surface by construction: a facade cannot reach the contract
 * without entering the composite, and entering the composite fails `tsc` here
 * until someone declares its lane.
 */
type BranchReadOpName = Extract<keyof BranchReadFacadeMethods, string>;

/**
 * Lane for every `syncSource.*` op.
 *
 * The four bounded members are corpus-scale reads the Sessions surface fans out
 * concurrently; the membership criterion is PEAK ALLOCATION WHILE HOLDING THE
 * WORKER, not result-set size (see {@link BOUNDED_READ_OPS} below for why those
 * two come apart).
 *
 * `aggregateAnalytics` is the ISS-5957 addition, and is the op ISS-5941 named as
 * its own top-ranked residual. It is the analytics twin of `aggregateUsage`: an
 * all-corpus SQL rollup (byTool / byAgentType / byRepository) that folds its
 * rows in JS through a shared attribution cache while holding a reader
 * connection. It is not a marginal case — `SessionsView.tsx` records it measured
 * at 27.1s for ONE call on a real 4,285-session corpus, the longest single hold
 * of any op in this map.
 *
 * It does NOT fire on every Sessions poll, and the lane must not be justified as
 * if it did: ISS-5273 gated the read on `needsAnalyticsRepositoryFallback`, so a
 * usage summary that already owns repositories issues none at all. What earns it
 * a permit is the shape of the call when it DOES fire — a whole-corpus scan on
 * the reader pool, landing on a page turn, concurrent with whatever else that
 * surface has in flight.
 *
 * Everything else is `Ungated` on purpose. The sync cursor reads
 * (`list*CursorRows`, `listSessionCursorPage`) are the narrow keyset probes the
 * heavy hydrations exist to avoid, `countSessions` is a grouped `COUNT(*)`, the
 * outbox/sync-state members are small bookkeeping writes, and gating any of them
 * would queue the sync lane and the UI behind corpus reads for no memory win.
 */
const SYNC_SOURCE_OP_LANES = {
  advanceSyncState: DbHostAdmissionLane.Ungated,
  aggregateAnalytics: DbHostAdmissionLane.BoundedRead,
  aggregateUsage: DbHostAdmissionLane.BoundedRead,
  clearAcknowledgedInvocationSyncPart: DbHostAdmissionLane.Ungated,
  clearOutboxEntries: DbHostAdmissionLane.Ungated,
  close: DbHostAdmissionLane.Ungated,
  countSessions: DbHostAdmissionLane.Ungated,
  deadLetterInvocationSyncPart: DbHostAdmissionLane.Ungated,
  enqueueOutboxEntries: DbHostAdmissionLane.Ungated,
  findExistingSessionIds: DbHostAdmissionLane.Ungated,
  findLocallyOversizedSessions: DbHostAdmissionLane.Ungated,
  listAllSessionCursorRows: DbHostAdmissionLane.Ungated,
  listComponentCursorRows: DbHostAdmissionLane.Ungated,
  listRepositoryScopedSessionIds: DbHostAdmissionLane.Ungated,
  listSessionCursorPage: DbHostAdmissionLane.Ungated,
  listTopSessionCursorRows: DbHostAdmissionLane.Ungated,
  listUpdatedSessionCursorRows: DbHostAdmissionLane.Ungated,
  loadComponentRows: DbHostAdmissionLane.Ungated,
  loadPendingOutboxIds: DbHostAdmissionLane.Ungated,
  loadPendingOutboxRetryState: DbHostAdmissionLane.Ungated,
  loadReadyInvocationSyncParts: DbHostAdmissionLane.Ungated,
  loadSessionBranchLinkKeys: DbHostAdmissionLane.Ungated,
  loadSessionDocumentArtifactRefs: DbHostAdmissionLane.Ungated,
  loadSessionEventCounts: DbHostAdmissionLane.Ungated,
  loadSessionTokenEvents: DbHostAdmissionLane.Ungated,
  loadSyncState: DbHostAdmissionLane.Ungated,
  loadSyncedSessions: DbHostAdmissionLane.BoundedRead,
  loadUsageSessions: DbHostAdmissionLane.BoundedRead,
  markOutboxDeadLettered: DbHostAdmissionLane.Ungated,
  prepareInvocationSyncTarget: DbHostAdmissionLane.Ungated,
  reEnqueueRecoveredDeadLetter: DbHostAdmissionLane.Ungated,
  readSyncBurndown: DbHostAdmissionLane.Ungated,
  recordInvocationSyncRetry: DbHostAdmissionLane.Ungated,
  recordOutboxRetry: DbHostAdmissionLane.Ungated,
} satisfies Record<SyncSourceOpName, InvokeRoutableLane>;

/**
 * The `syncSource.*` names the registry actually DECLARES a lane for.
 *
 * Exported for `type-tests/db-host-op-lane-coverage.ts`, which asserts this is
 * mutually exhaustive with {@link SyncSourceOpName} in BOTH directions. The
 * `satisfies` above already rejects a missing key; the type test additionally
 * catches the guard being WIDENED (to `Partial<Record<…>>`, or to a bare
 * `Record<string, …>`), which is the way a compile-time guard actually dies.
 */
export type DeclaredSyncSourceOpName = keyof typeof SYNC_SOURCE_OP_LANES;

/**
 * Lane for every `dashboard.*` op — the ten ISS-6027 admitted, unchanged.
 *
 * `getInsights` is `Exclusive`, and that declaration is what ROUTES it:
 * `dispatchDbHostInvoke` matches {@link EXCLUSIVE_OPS} — derived from this map —
 * and hands the op to the width-1 gate behind the FEA-2055 result cache,
 * returning before `runInvokeOp` is reached. It must NOT appear in
 * {@link BOUNDED_READ_OPS}, where membership would be dead code, and
 * {@link DashboardOpLaneMap} is what stops any other op claiming this lane.
 */
const DASHBOARD_OP_LANES = {
  getAnalytics: DbHostAdmissionLane.BoundedRead,
  getCoreFeatures: DbHostAdmissionLane.BoundedRead,
  getInsights: DbHostAdmissionLane.Exclusive,
  getPacks: DbHostAdmissionLane.BoundedRead,
  getPlans: DbHostAdmissionLane.BoundedRead,
  getPullRequests: DbHostAdmissionLane.BoundedRead,
  getSkills: DbHostAdmissionLane.BoundedRead,
  getSubAgents: DbHostAdmissionLane.BoundedRead,
  getTokenAnalytics: DbHostAdmissionLane.BoundedRead,
  getTools: DbHostAdmissionLane.BoundedRead,
  getWorkflowData: DbHostAdmissionLane.BoundedRead,
} satisfies DashboardOpLaneMap;

/** The `dashboard.*` names declared here. See {@link DeclaredSyncSourceOpName}. */
export type DeclaredDashboardOpName = keyof typeof DASHBOARD_OP_LANES;

/**
 * Lane for the two named Branch read facades — the ISS-5957 addition.
 *
 * Both qualify on the same PEAK-ALLOCATION axis as the `dashboard.*` members,
 * and by the same ISS-6027 argument that admitted those: each drives a
 * whole-eligible-corpus scan through `prisma.read` and materializes its result
 * set in JS while occupying the worker, so an ungated one can hold a slot in the
 * 2-connection reader pool while a gated `aggregateUsage` holds a lane permit
 * and executes no SQL at all — the exact state
 * `BOUNDED_READ_OP_LIMIT`'s value is chosen to avoid. `branch-metric-event-
 * provenance.ts` already calls its own facade a "clone-safe HEAVY-READ facade".
 *
 * **This is deliberately NOT the thing `shared-branches-api.ts` warns against.**
 * That standing warning forbids re-adding SERIALIZATION to the raw `Promise.all`
 * Branch reads on the strength of the corrected "exit code 5 = V8 heap OOM"
 * theory. Those raw reads are `prisma.client.*` paths, they are untouched, and
 * they stay ungated. This is a concurrency CEILING on two named ops, resting on
 * the reader-pool contention argument above rather than on exit-code 5.
 *
 * The queueing cost to the Branches surface itself is ZERO by derivation: see
 * `BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS`, which is 1. The cost is purely
 * cross-surface, and is the same cost ISS-6027 already accepted for dashboard.
 */
const BRANCH_READ_OP_LANES = {
  readBranchCanonicalActivityRows: DbHostAdmissionLane.BoundedRead,
  readBranchMetricEventEvidence: DbHostAdmissionLane.BoundedRead,
} satisfies Record<BranchReadOpName, InvokeRoutableLane>;

/** The named Branch read facades declared here. See {@link DeclaredSyncSourceOpName}. */
export type DeclaredBranchReadOpName = keyof typeof BRANCH_READ_OP_LANES;

/**
 * The whole registry, keyed by the dotted-path PREFIX each map's names sit
 * under. The empty prefix is the contract's top level.
 *
 * Exported so a test can drive the real declaration rather than a copy: the
 * lane of every classified op is readable from here, and
 * {@link BOUNDED_READ_OPS} is built from it by {@link boundedOpPaths} with no
 * second hand-written list to drift.
 */
export const DB_HOST_OP_LANE_REGISTRY: ReadonlyArray<
  readonly [
    prefix: string,
    lanes: Readonly<Record<string, DbHostAdmissionLane>>,
  ]
> = [
  ["syncSource", SYNC_SOURCE_OP_LANES],
  ["dashboard", DASHBOARD_OP_LANES],
  ["", BRANCH_READ_OP_LANES],
];

/**
 * Dotted invoke paths that take the bounded READ lane, DERIVED from
 * {@link DB_HOST_OP_LANE_REGISTRY}.
 *
 * Never hand-edit this — add the op to its namespace's map above. The whole
 * point of ISS-5957 is that there is one place to declare a lane and no second
 * list that can silently disagree with it.
 *
 * ## Membership policy (ISS-5941 / ISS-6027 / ISS-5957)
 *
 * All members are heavy reads that the Sessions/dashboard/Branches surfaces fan
 * out concurrently. They are deliberately NOT in {@link HEAVY_STORE_OPS}:
 * serializing them against a running backfill would freeze those surfaces for
 * the backfill's whole duration. They need a concurrency CEILING, not exclusivity.
 *
 * The membership criterion is PEAK ALLOCATION WHILE HOLDING THE WORKER, not
 * result-set size — the two come apart, and conflating them picks the wrong ops:
 *
 * - `loadSyncedSessions` qualifies on result size: it hydrates whole session
 *   objects (agents, events, token_events, artifact_links) into JS.
 * - `aggregateUsage` returns only grouped SUM/COUNT rows — a TINY result. It
 *   qualifies on the other axis: it is an all-time SQL scan over the token
 *   tables that holds a reader connection and allocates through the fold, and
 *   the Sessions surface fires up to five of them at once (the page-data read
 *   plus one per filtered facet). Judged on result size alone it would have been
 *   left out, and it is half of the fan-out this ticket is about.
 *
 * - `loadUsageSessions` qualifies the same way `loadSyncedSessions` does: it
 *   materializes every resolved session into JS, capped only at
 *   `MAX_WORKING_SET_SESSIONS` (5000), and it is the fallback the usage half
 *   takes whenever `canUseAggregateSessionFilters` is false — on the same 2s
 *   page-data poll that fires the aggregates. An earlier revision left it out
 *   because nothing had measured it; that was the wrong call. Leaving the
 *   fallback ungated meant every cost/model/harness-filtered Sessions request
 *   re-created exactly the unbounded working set the gated path had just
 *   stopped, on the polling cadence.
 *
 * Genuinely cheap reads — `countSessions`, cursor paging — stay ungated so the
 * UI stays snappy, and those are the real counter-examples.
 *
 * ISS-6027 — the `dashboard.*` members are here for the same reason, and were
 * missing because two changes landed five hours apart without accounting for
 * each other: ISS-5941 sized this lane's ceiling reasoning around a reader pool
 * it treated as effectively private to the three `syncSource.*` ops, and
 * ISS-5938 then moved every heavy dashboard raw read onto that same pool without
 * declaring a lane. So a `getPlans` could occupy a reader slot while an
 * `aggregateUsage` held a permit and executed no SQL at all, waiting on the
 * adapter's per-connection mutex — precisely the state
 * {@link BOUNDED_READ_OP_LIMIT} says a ceiling of 2 avoids.
 *
 * They qualify on the same PEAK-ALLOCATION axis, which is the criterion above
 * and NOT "holds a reader connection throughout": each drives at least one
 * all-corpus aggregation/window/CTE scan through `prisma.read` and allocates
 * through its fold while occupying the worker. Several are the MIXED shape
 * `loadSyncedSessions` already is — `getWorkflowData` and `getAnalytics` run
 * their typed counts on the writer client first (FEA-2211), so they hold a
 * permit for a stretch in which they occupy no reader connection. That cost is
 * the one {@link BOUNDED_READ_OP_LIMIT} already records, not a disqualification.
 *
 * Three qualify through INTERNAL calls rather than their own SQL, and are in the
 * lane for exactly that reason — an internal call never re-enters `runInvokeOp`,
 * so it takes NO permit of its own and leaving the outer op out would leave its
 * reads entirely ungated: `getPacks` is `buildPacksFromSkills(getSkills())`,
 * `getAnalytics` folds `getTokenAnalytics` together with two more pool reads,
 * and `getCoreFeatures` fans out five corpus reads concurrently. Gating the
 * outer op is the only seam available; what it buys is bounding how many such
 * bundles run at once, not bounding one bundle's own peak.
 *
 * `dashboard.getInsights` is deliberately absent: `dispatchDbHostInvoke` routes
 * it to the EXCLUSIVE lane behind the FEA-2055 result cache and returns before
 * `runInvokeOp` is reached, so membership here would be dead. `getSummary` is
 * absent too — it is metadata-only typed counts on the writer client and never
 * touches the reader pool.
 *
 * ISS-5957 adds two more on the same PEAK-ALLOCATION axis: `aggregateAnalytics`
 * (the analytics twin of `aggregateUsage`, and ISS-5941's own top-ranked
 * residual) and the two named Branch read facades. The Branch pair is NOT the
 * serialization `shared-branches-api.ts` warns against — that warning guards the
 * raw `prisma.client.*` Branch reads, which stay ungated and untouched. See
 * {@link BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS} for why admitting them costs
 * the Branches surface no self-queueing at all.
 *
 * One known gap, recorded rather than hidden: **the lane keys on the op NAME**,
 * so `loadSyncedSessions` call sites whose cost differs by orders of magnitude
 * take the same permit — a one-session detail read queues like a whole
 * cloud-sync batch. Only the corpus-scale callers justify the bound; the small
 * ones pay a queueing cost they did not earn, and (see "What this does not fix"
 * in the header) the interactive one can end up behind the batch. Sizing by
 * `ids.length` would need the arguments, which the routing decision
 * deliberately does not inspect.
 *
 * The SET is declared in `db-host-op-lane-registry.js` and imported here, not
 * re-exported: one binding, one import path, nothing that can disagree. This
 * policy lives with the LANE it governs; each op's own justification lives with
 * its declaration.
 */
export const BOUNDED_READ_OPS: ReadonlySet<string> = new Set(
  opPathsForLane(DbHostAdmissionLane.BoundedRead)
);

/**
 * Dotted invoke paths that take the EXCLUSIVE width-1 lane, derived from
 * {@link DB_HOST_OP_LANE_REGISTRY} exactly as {@link BOUNDED_READ_OPS} is.
 *
 * `dispatchDbHostInvoke` matches against THIS set rather than a literal of its
 * own, which is what makes the `Exclusive` declaration load-bearing: before
 * ISS-5957's review the dispatcher hard-coded `"dashboard.getInsights"` and the
 * registry's `Exclusive` was a comment with a type annotation — the two could
 * have disagreed and nothing would have failed.
 *
 * It is a SET, not a single value, only so the derivation matches its bounded
 * sibling; {@link DashboardOpLaneMap} pins its membership to exactly one op, and
 * that is load-bearing for the dispatcher — the branch behind this set applies
 * the insights result cache, whose single-flight semantics are not generic.
 */
export const EXCLUSIVE_OPS: ReadonlySet<string> = new Set(
  opPathsForLane(DbHostAdmissionLane.Exclusive)
);

/**
 * The one dotted path in {@link EXCLUSIVE_OPS}. Exported so the dispatcher and
 * its tests name the op through the registry instead of restating the literal.
 */
export const DB_HOST_EXCLUSIVE_OP =
  `dashboard.${EXCLUSIVE_DASHBOARD_OP_NAME}` as const;

/** Every dotted path across the registry whose declared lane is `lane`. */
function opPathsForLane(lane: DbHostAdmissionLane): string[] {
  return DB_HOST_OP_LANE_REGISTRY.flatMap(([prefix, lanes]) =>
    laneOpPaths(prefix, lanes, lane)
  );
}

/** Dotted paths in one namespace map whose declared lane is `lane`. */
function laneOpPaths(
  prefix: string,
  lanes: Readonly<Record<string, DbHostAdmissionLane>>,
  lane: DbHostAdmissionLane
): string[] {
  return Object.entries(lanes)
    .filter(([, declared]) => declared === lane)
    .map(([name]) => (prefix === "" ? name : `${prefix}.${name}`));
}
