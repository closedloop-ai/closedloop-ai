/**
 * ISS-5957 — the EXECUTABLE proof that the db-host admission-lane guard bites.
 *
 * The guard itself is the `satisfies Record<keyof <runtime interface>,
 * DbHostAdmissionLane>` on each namespace map in `db-host-op-lane-registry.ts`:
 * add a method to `AgentSessionSyncSource`, to the contract's `dashboard`
 * member, or to the named Branch read facade, and that map stops compiling until
 * someone types a lane for the new op. That is what closes the hole ISS-5941 and
 * ISS-6027 both fell into, where `BOUNDED_READ_OPS` was a hand-written set whose
 * template-literal typing caught a RENAME but never an ADDITION.
 *
 * This file is compiled by `typecheck:type-tests`, so it runs the decision in
 * CI rather than describing it. It pins TWO properties the `satisfies` alone
 * does not:
 *
 * 1. **Mutual exhaustiveness.** `satisfies` rejects a MISSING key, but it says
 *    nothing about the declared set drifting ahead of the interface — a lane
 *    left behind for a method that was deleted is dead policy that reads like
 *    live policy. Each `…LanesAreExhaustive` below fails in BOTH directions.
 * 2. **A second, INDEPENDENT check that survives the `satisfies` being
 *    relaxed.** A compile-time guard rarely dies by deletion; it dies when
 *    someone under pressure relaxes `Record<K, V>` to `Partial<Record<K, V>>` to
 *    make an unrelated build go green. These assertions compare the DECLARED key
 *    set against the interface directly, so they do not depend on the
 *    `satisfies` still being strict. Verified by hand on ISS-5957: with the
 *    `syncSource` map relaxed to `Partial<Record<…>>` — the guard defeated — an
 *    undeclared op still fails `syncSourceLanesAreExhaustive` here.
 *
 * The `@ts-expect-error` blocks below are the counterfactual: each is driven by
 * a SYNTHETIC undeclared heavy op and REQUIRES the check to reject it. If a
 * future refactor makes an undeclared op acceptable, the directive becomes
 * unused and fails the build. A guard nobody has watched fail is not a guard.
 *
 * The op-name unions are re-derived here from the runtime interfaces rather than
 * imported from the registry, on purpose: importing the registry's own aliases
 * would make this test agree with the registry by construction instead of
 * checking it against the source of truth.
 *
 * For the Branch namespace that source of truth is `BranchReadFacadeMethods` —
 * the single composite the CONTRACT also intersects — and not the leaf facade
 * interfaces this file used to re-intersect. See {@link BranchReadOpName}.
 */

import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { BranchReadFacadeMethods } from "../src/main/database/branch-read-facades.js";
import type {
  DeclaredBranchReadOpName,
  DeclaredDashboardOpName,
  DeclaredSyncSourceOpName,
} from "../src/main/database/db-host/db-host-op-lane-registry.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite-contract.js";

/**
 * `true` only when `Declared` and `Actual` name exactly the same ops. An op on
 * the interface with no declared lane, or a declared lane for an op that no
 * longer exists, collapses this to `never` — which nothing can be assigned to.
 */
type LanesAreExhaustive<Declared extends string, Actual extends string> = [
  Exclude<Actual, Declared>,
  Exclude<Declared, Actual>,
] extends [never, never]
  ? true
  : never;

type SyncSourceOpName = Extract<keyof AgentSessionSyncSource, string>;
type DashboardOpName = Extract<keyof SqliteAgentDatabase["dashboard"], string>;

/**
 * The named Branch read facades, read from the ONE canonical composite the
 * CONTRACT composes them through — not from the leaf interfaces re-intersected
 * here, which is what this file did before the ISS-5957 review.
 *
 * That distinction is the fix. Re-intersecting the leaves checked the registry
 * against the interfaces this file already happened to name, so a THIRD facade
 * composed into `SqliteAgentDatabase` was invisible to BOTH sides at once and
 * reached the proxy ungated. Routing both sides through one composite closes
 * that: a facade added to {@link BranchReadFacadeMethods} fails the assertion
 * below until the registry declares its lane.
 *
 * It closes the composition point, NOT every way in. `BranchReadFacadeMethods`
 * is one of three top-level bundles intersected into `SqliteAgentDatabase`, and
 * only it is exhausted here — a Branch facade intersected into the contract
 * directly, alongside `StoreHealthMethods` and `DiagnosticsMethods`, is callable
 * by name through the proxy with no lane and this file stays green. That is the
 * same honest scope the registry header states: the guard covers the three NAMED
 * namespaces below and nothing else.
 */
type BranchReadOpName = Extract<keyof BranchReadFacadeMethods, string>;

/** The op a future author adds without thinking about admission. */
type UndeclaredHeavyOp = "probeNewHeavyCorpusRead";

export const syncSourceLanesAreExhaustive: LanesAreExhaustive<
  DeclaredSyncSourceOpName,
  SyncSourceOpName
> = true;

export const dashboardLanesAreExhaustive: LanesAreExhaustive<
  DeclaredDashboardOpName,
  DashboardOpName
> = true;

export const branchReadLanesAreExhaustive: LanesAreExhaustive<
  DeclaredBranchReadOpName,
  BranchReadOpName
> = true;

// @ts-expect-error ISS-5957 — a new `syncSource.*` op with no declared lane MUST
// fail the build. If this line ever compiles, the guard has been widened and a
// heavy op can once again reach `dispatchInvoke` with no admission control.
export const undeclaredSyncSourceOpIsRejected: LanesAreExhaustive<
  DeclaredSyncSourceOpName,
  SyncSourceOpName | UndeclaredHeavyOp
> = true;

// @ts-expect-error ISS-5957 — the same, for the `dashboard.*` namespace. This is
// the exact escape ISS-6027 found: ten whole-corpus reads moved onto the shared
// reader pool with no lane, five hours after the lane shipped.
export const undeclaredDashboardOpIsRejected: LanesAreExhaustive<
  DeclaredDashboardOpName,
  DashboardOpName | UndeclaredHeavyOp
> = true;

// @ts-expect-error ISS-5957 — the same, for the named Branch read facades.
export const undeclaredBranchReadOpIsRejected: LanesAreExhaustive<
  DeclaredBranchReadOpName,
  BranchReadOpName | UndeclaredHeavyOp
> = true;

// @ts-expect-error ISS-5957 — the OTHER direction: a lane declared for an op the
// interface no longer has is dead policy, and must not pass silently.
export const staleDeclaredLaneIsRejected: LanesAreExhaustive<
  DeclaredSyncSourceOpName | UndeclaredHeavyOp,
  SyncSourceOpName
> = true;
