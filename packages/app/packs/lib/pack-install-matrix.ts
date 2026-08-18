/**
 * Per-(compute target × harness × component) install-state model (FEA-4072a).
 *
 * The single-target booleans on `PackView` (`installedByMe` /
 * `installedHarnesses`) collapse install state to one target the moment an org
 * has more than one compute target — which is the norm the manage-across-targets
 * UX (FEA-4072) exists to serve. This module surfaces the multi-target install
 * state that ALREADY lives in storage — `DistributionTargetStatus` rows
 * (per-target `status` / `installedVersion` / `failureReason`) joined to the
 * `ComputeTarget` they belong to — into a stable, surface-agnostic view-model
 * shape that downstream UI (the deferred prototype-first management UX, "4072b")
 * branches from. No new schema: this is a pure projection of storage the
 * distribution platform (FEA-2923) already writes.
 *
 * The axis is (computeTarget × harness × component):
 *  - `component`      — the CatalogItem / pack this matrix belongs to (the
 *                       `PackView`, or one of its child components). Carried as
 *                       the `PackComponentInstallMatrix.componentId`.
 *  - `computeTarget`  — the device the distribution status row targets
 *                       (`DistributionTargetStatusDto.computeTargetId`).
 *  - `harness`        — the harness that target runs (its `selectedHarness`).
 *                       `DistributionTargetStatus` has no harness column, so the
 *                       harness dimension is resolved from the target, not the
 *                       status row.
 *
 * Each (target × harness) cell carries exactly ONE `PackInstallState` from the
 * canonical FEA-4083 vocabulary (`./install-state`), so every packs surface
 * describes a cell with the same words and renders it the same way.
 *
 * Honesty over optimism (the FEA-4072 / FEA-4088 Parker principle):
 *  - An offline / unreachable target is a real `Offline` cell — stale-but-honest,
 *    never silent success. Reachability overrides the last-known install status:
 *    a device that was `installed` but is now offline reads `Offline`, because we
 *    can't confirm the current truth.
 *  - Version-skew safe: a target may run an older desktop and report an unknown
 *    or missing status value. An unknown status maps to `Offline` (unknown, not
 *    installed), never optimistically to `Installed`.
 */

import type { DistributionTargetStatusDto } from "@repo/api/src/types/distribution";
import { DistributionTargetStatusValue } from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";
import { isUpdateAvailable } from "@repo/app/shared/lib/version-utils";
import { PackInstallState } from "./install-state";

/**
 * A resolved compute target the install matrix needs to place a status row on
 * the (target × harness) grid: its display name, the harness it runs, and
 * whether it is currently reachable. Sourced from the org's `ComputeTarget`
 * rows; `harness` is the target's `selectedHarness`. `online` gates the
 * offline-honesty rule — a status row for an unreachable target renders
 * `Offline` regardless of its last-known install status.
 */
export type InstallMatrixTarget = {
  computeTargetId: string;
  computeTargetName: string;
  harness: Harness;
  /**
   * Whether the target is currently reachable. `false` (or a missing target
   * under version skew) forces the cell to `Offline` — its true install state
   * is unknown right now, so the surface shows a stale-but-honest offline cell
   * rather than trusting the last-reported status.
   */
  online: boolean;
  /**
   * Optional predicate that decides whether a given status row belongs to THIS
   * (target × harness) cell. `DistributionTargetStatus` has no harness column,
   * so when a resolver expands one physical device that runs several harnesses
   * into multiple cells sharing a `computeTargetId`, it supplies this predicate
   * to route each status row to the harness cell(s) it actually applies to —
   * preventing a single persisted install row from being relabeled onto every
   * harness of the same device.
   *
   * Additive and back-compat: when omitted (the common single-harness /
   * target-only case, where each device maps to exactly one cell), any status
   * row on the cell's `computeTargetId` matches, preserving the prior
   * target-keyed behavior. The deferred FEA-4072b resolver owns supplying this
   * predicate when it expands multi-harness devices.
   */
  matchesHarness?: (status: DistributionTargetStatusDto) => boolean;
};

/**
 * One (compute target × harness) cell for a single component. Carries the single
 * canonical `PackInstallState` for that cell plus the honest per-target detail
 * (`installedVersion`, `failureReason`) the storage row supplies, so the UI can
 * show what's installed and why an install failed without re-deriving it.
 */
export type PackInstallCell = {
  computeTargetId: string;
  computeTargetName: string;
  harness: Harness;
  state: PackInstallState;
  /** Version installed on this target, when the status row reported one. */
  installedVersion?: string | null;
  /** Failure detail for a `Failed` cell, when the status row reported one. */
  failureReason?: string | null;
};

/**
 * Install state for one component (a pack or one of its child components) across
 * every (compute target × harness) cell. `componentId` is the axis's component
 * dimension — the CatalogItem id.
 */
export type PackComponentInstallMatrix = {
  componentId: string;
  componentName: string;
  cells: PackInstallCell[];
};

/**
 * Map a stored `DistributionTargetStatusValue` to the canonical
 * `PackInstallState` a surface renders. Exhaustive over the status union — a new
 * status value fails typecheck at the `never` guard until it is mapped here, so
 * a newly stored status can never silently fall through to a wrong cell state.
 *
 * `Declined` maps to `NotInstalled`: the user opted out, so the honest cell is
 * "not installed (available to install)", not a failure. `Pending` / `OptedIn`
 * are in-flight → `Converting`.
 *
 * This is the reachable-target mapping; an unreachable target overrides the
 * result to `Offline` in `deriveCellState`, and an unknown wire value (version
 * skew) never reaches this function — `deriveCellState` guards it to `Offline`
 * first.
 */
export function distributionStatusToInstallState(
  status: DistributionTargetStatusValue
): PackInstallState {
  switch (status) {
    case DistributionTargetStatusValue.Installed:
    case DistributionTargetStatusValue.Enabled: {
      return PackInstallState.Installed;
    }
    case DistributionTargetStatusValue.Pending:
    case DistributionTargetStatusValue.OptedIn: {
      return PackInstallState.Converting;
    }
    case DistributionTargetStatusValue.Failed: {
      return PackInstallState.Failed;
    }
    case DistributionTargetStatusValue.Declined: {
      return PackInstallState.NotInstalled;
    }
    default: {
      return assertExhaustiveStatus(status);
    }
  }
}

/**
 * The set of known stored status values, used to detect an unknown wire value
 * (an older/newer desktop reporting a status this build doesn't know). Built
 * once from the const object so it can never drift from the union.
 */
const KNOWN_STATUS_VALUES: ReadonlySet<string> = new Set(
  Object.values(DistributionTargetStatusValue)
);

/**
 * Derive the single `PackInstallState` for one (target × harness) cell from its
 * stored status row and the target's reachability.
 *
 * Precedence (honesty first):
 *  1. Target offline / unresolved → `Offline`. We can't confirm the current
 *     truth, so we show a stale-but-honest offline cell, never optimistic
 *     success.
 *  2. Unknown / missing stored status (version skew) → `Offline`. An older/newer
 *     desktop reporting a status this build can't classify degrades to the safe,
 *     non-optimistic state (never `Installed`). NOTE: `Offline` renders as
 *     "Target offline", which is imprecise for an *online* target carrying an
 *     unclassifiable status — the honest label would be "unknown", but the
 *     FEA-4083 vocabulary (`./install-state`) has no `Unknown` member, so
 *     `Offline` is the closest never-optimistic state today. The only online
 *     path that reaches this branch is a present-but-unknown wire value (a
 *     version-skewed desktop); an online target with NO row is routed to
 *     `NotInstalled` by `resolveCellState` before it can reach here. Adding a
 *     distinct `Unknown`/`Unclassifiable` state to the frozen vocabulary is a
 *     separate slice (see the FEA-4072b resolver work).
 *  3. Otherwise map the known status through
 *     `distributionStatusToInstallState`.
 */
export function deriveCellState(
  status: DistributionTargetStatusDto | null | undefined,
  online: boolean
): PackInstallState {
  if (!online) {
    return PackInstallState.Offline;
  }
  const raw = status?.status;
  if (raw === undefined || !KNOWN_STATUS_VALUES.has(raw)) {
    return PackInstallState.Offline;
  }
  return distributionStatusToInstallState(raw as DistributionTargetStatusValue);
}

/**
 * Build the per-(target × harness) cells for one component from its stored
 * distribution status rows and the org's resolved compute targets.
 *
 * Cell identity is the joint `(computeTargetId, harness)` coordinate, not the
 * target id alone. `DistributionTargetStatus` has no harness column, so each
 * resolved `InstallMatrixTarget` already carries the specific harness its cell
 * describes and matches a status row only through the target's own
 * `matchesHarness` predicate. This is what keeps the model honestly target ×
 * harness rather than target-only: when a caller expands one physical device
 * into several harness cells, a status row is attached to the cell(s) the
 * resolver says it belongs to — a device that switches its selected harness from
 * Claude to Codex does NOT silently relabel the same persisted install row onto
 * the new harness, because the resolver, not this function, owns which
 * harness(es) a status applies to. (How a `ComputeTarget` with multiple
 * available harnesses is expanded into cells is the deferred FEA-4072b resolver;
 * this function stays correct for target-only, single-harness, and
 * fully-expanded inputs alike.)
 *
 * Every target in `targets` gets a cell so the grid is complete and honest — a
 * target with no matching status row for this component reads through
 * `resolveCellState` (offline → `Offline`; online-with-no-row → an explicit
 * `NotInstalled`). Status rows whose `computeTargetId` isn't in the resolved
 * target set (a target that no longer exists, or a null-target row) are skipped:
 * a cell must sit on a real (target × harness) coordinate.
 */
export function buildInstallCells(
  statuses: readonly DistributionTargetStatusDto[],
  targets: readonly InstallMatrixTarget[],
  catalogVersion?: string | null
): PackInstallCell[] {
  const statusesByTarget = new Map<string, DistributionTargetStatusDto[]>();
  for (const status of statuses) {
    if (!status.computeTargetId) {
      continue;
    }
    const bucket = statusesByTarget.get(status.computeTargetId);
    if (bucket) {
      bucket.push(status);
    } else {
      statusesByTarget.set(status.computeTargetId, [status]);
    }
  }

  const cells: PackInstallCell[] = [];
  for (const target of targets) {
    const status = resolveStatusForCell(statusesByTarget, target);
    const installedVersion = status?.installedVersion ?? null;
    const baseState = resolveCellState(status, target.online);
    const state = resolveUpdatableState(
      baseState,
      installedVersion,
      catalogVersion
    );
    cells.push({
      computeTargetId: target.computeTargetId,
      computeTargetName: target.computeTargetName,
      harness: target.harness,
      state,
      installedVersion,
      failureReason: status?.failureReason ?? null,
    });
  }
  return cells;
}

/**
 * Build a `PackComponentInstallMatrix` for one component (a pack or a child
 * component) from its distribution status rows and the resolved compute targets.
 *
 * `catalogVersion` (the component's current catalog/latest version, when known)
 * drives the `Updatable` derivation: an `Installed` cell whose installed version
 * is strictly behind the catalog version reads `Updatable` (FEA-4083). Optional
 * and version-skew safe — an absent or unparseable version leaves the cell
 * `Installed`, never optimistically hiding a real install behind an update
 * prompt or vice versa.
 */
export function buildComponentInstallMatrix(
  component: { id: string; name: string; version?: string | null },
  statuses: readonly DistributionTargetStatusDto[],
  targets: readonly InstallMatrixTarget[]
): PackComponentInstallMatrix {
  return {
    componentId: component.id,
    componentName: component.name,
    cells: buildInstallCells(statuses, targets, component.version),
  };
}

/**
 * Cell state for a target that HAS or LACKS a status row. Differs from
 * `deriveCellState` only for the online-with-no-row case: an online target that
 * a component has no distribution status row for is honestly `NotInstalled`
 * (the pack simply isn't distributed to it), not `Offline`. Offline targets and
 * unknown/version-skewed statuses still resolve through `deriveCellState`.
 */
function resolveCellState(
  status: DistributionTargetStatusDto | undefined,
  online: boolean
): PackInstallState {
  if (online && status === undefined) {
    return PackInstallState.NotInstalled;
  }
  return deriveCellState(status, online);
}

/**
 * Pick the status row for one `(computeTargetId, harness)` cell from the rows
 * bucketed by target id. When the target supplies a `matchesHarness` predicate
 * (a resolver that expanded a multi-harness device into several cells), only a
 * row that predicate accepts belongs to this cell; the first match wins. With no
 * predicate (single-harness / target-only cell), the first row on that target id
 * matches, preserving the prior target-keyed behavior. A cell with no matching
 * row resolves to `NotInstalled` / `Offline` through `resolveCellState`.
 */
function resolveStatusForCell(
  statusesByTarget: ReadonlyMap<string, readonly DistributionTargetStatusDto[]>,
  target: InstallMatrixTarget
): DistributionTargetStatusDto | undefined {
  const rows = statusesByTarget.get(target.computeTargetId);
  if (!rows) {
    return;
  }
  const { matchesHarness } = target;
  if (!matchesHarness) {
    return rows[0];
  }
  return rows.find(matchesHarness);
}

/**
 * Exhaustiveness guard for `distributionStatusToInstallState`. A newly added
 * `DistributionTargetStatusValue` fails typecheck here (`never`) until it is
 * mapped above. At runtime this is only reachable if a boundary casts an unknown
 * wire string to the status type (bypassing the union); it degrades to `Offline`
 * (unknown, not installed) rather than a fabricated `Installed`.
 */
function assertExhaustiveStatus(_status: never): PackInstallState {
  return PackInstallState.Offline;
}

/**
 * Promote an `Installed` cell to `Updatable` when its installed version is
 * strictly behind the component's catalog version. Only `Installed` is eligible
 * — a `Failed` / `Converting` / `Offline` / `NotInstalled` cell keeps its honest
 * state (an update prompt would lie about what's on the box). Version-skew safe:
 * a missing installed or catalog version, or a version this build can't parse,
 * leaves the cell `Installed` (`isUpdateAvailable` returns false), never
 * fabricating an update signal.
 */
function resolveUpdatableState(
  state: PackInstallState,
  installedVersion: string | null,
  catalogVersion: string | null | undefined
): PackInstallState {
  if (
    state === PackInstallState.Installed &&
    catalogVersion &&
    isUpdateAvailable(installedVersion ?? undefined, catalogVersion)
  ) {
    return PackInstallState.Updatable;
  }
  return state;
}
