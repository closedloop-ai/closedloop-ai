/**
 * Member per-machine install-state block model (FEA-4077).
 *
 * The member view of a pack's install state across the machines the member owns.
 * This is a thin projection layer on top of the merged FEA-4072a
 * per-(target × harness) model (`./pack-install-matrix`) and the FEA-4083
 * canonical install-state vocabulary (`./install-state`) — it does NOT introduce
 * a second install-state model. It answers one member question: "on each of my
 * machines, is this pack installed, missing, out of date, or unreachable?"
 *
 * Two read paths feed the same shape:
 *  - DESKTOP reflects LOCAL install state for the one machine the app runs on
 *    (this machine), derived from the preserved `desktopApi.db.catalog*` reads
 *    (`installedHarnesses`). {@link localMachineInstallMatrix} builds that
 *    single-cell matrix.
 *  - WEB (member) reflects the member's REGISTERED NODES — a READ of the
 *    member's own compute targets. {@link memberComputeTargetsToInstallTargets}
 *    resolves those nodes into `InstallMatrixTarget`s that
 *    `catalogItemToPackView` feeds through `buildInstallCells`.
 *
 * Actually installing / uninstalling from either surface's block (the
 * ACT/dispatch path) is the separate self-service-install slice and is NOT built
 * here — this slice is READ-only per-machine state.
 */

import type { DistributionTargetStatusDto } from "@repo/api/src/types/distribution";
import { PackInstallState } from "./install-state";
import {
  buildComponentInstallMatrix,
  type InstallMatrixTarget,
  type PackComponentInstallMatrix,
  type PackInstallCell,
} from "./pack-install-matrix";
import type { PackView } from "./pack-view";

/**
 * The single member-scoped compute target this module needs to resolve a node
 * into an `InstallMatrixTarget`. A structural subset of the API `ComputeTarget`
 * — id, display name, the harness it runs, and its reachability — so this shared
 * package does not depend on the app-only compute-target DTO. The web member
 * surface maps its `ComputeTarget` rows to this shape; a test supplies it
 * directly.
 */
export type MemberComputeTarget = {
  id: string;
  machineName: string;
  /** The harness this node runs (`selectedHarness`); defaults to Claude when absent. */
  selectedHarness?: string | null;
  /** Whether the node is currently reachable — gates the honest offline cell. */
  isOnline: boolean;
};

/** Default harness for a node that reports none, matching the install matrix. */
const DEFAULT_HARNESS = "claude";

/** The synthetic id/name for the desktop "this machine" local cell. */
export const LOCAL_MACHINE_TARGET_ID = "local-machine";
export const LOCAL_MACHINE_TARGET_NAME = "This machine";

/**
 * Resolve the member's registered compute targets into `InstallMatrixTarget`s
 * the FEA-4072a matrix builder places distribution status rows onto. Each node
 * becomes one (target × harness) cell keyed on its own id and `selectedHarness`;
 * `isOnline` drives the honest offline cell. This is the WEB member read path —
 * a projection of the member's own nodes, no dispatch.
 */
export function memberComputeTargetsToInstallTargets(
  targets: readonly MemberComputeTarget[]
): InstallMatrixTarget[] {
  return targets.map((target) => ({
    computeTargetId: target.id,
    computeTargetName: target.machineName,
    harness: target.selectedHarness ?? DEFAULT_HARNESS,
    online: target.isOnline,
  }));
}

/**
 * Build the WEB member per-machine install matrix for one pack from the member's
 * registered nodes and any distribution status rows keyed on those nodes.
 *
 * Reuses the canonical FEA-4072a `buildComponentInstallMatrix` so the member
 * surface derives exactly the same per-(target × harness) `PackInstallState`
 * cells as the admin matrix — no second install-state model. Passing an empty
 * `statuses` (the common member read, where the org-visible `GET /distributions`
 * list carries no per-member `targetStatuses`) still yields honest cells: an
 * online node with no status row reads `NotInstalled`, an offline node reads
 * `Offline`. Returns an EMPTY array (not `null`) when the member has no
 * registered nodes, so the web member block renders its honest "no machines"
 * empty state rather than falling back to a fabricated desktop-local row (a
 * present-but-empty matrix is the web read's "ran, found no nodes" signal —
 * distinct from an absent matrix, which is the desktop local read).
 */
export function memberInstallMatrix(
  pack: Pick<PackView, "id" | "name">,
  targets: readonly MemberComputeTarget[],
  statuses: readonly DistributionTargetStatusDto[] = []
): PackComponentInstallMatrix[] {
  if (targets.length === 0) {
    return [];
  }
  return [
    buildComponentInstallMatrix(
      { id: pack.id, name: pack.name },
      statuses,
      memberComputeTargetsToInstallTargets(targets)
    ),
  ];
}

/**
 * Build the DESKTOP local "this machine" install cells for a pack from its
 * locally-installed harnesses (`desktopApi.db.catalog*`). One cell per harness
 * the pack supports, keyed on the synthetic local-machine id: `Installed` when
 * that harness is locally installed, `NotInstalled` otherwise. The local machine
 * is, by definition, the one the desktop app is running on, so it is always
 * online — there is no offline local cell.
 *
 * A pack that lists no harnesses still gets one cell (the default harness) so the
 * member always sees a concrete per-machine row rather than an empty block.
 */
export function localMachineInstallMatrix(pack: PackView): PackInstallCell[] {
  const supported =
    pack.harnesses.length > 0 ? pack.harnesses : [DEFAULT_HARNESS];
  const installed = new Set<string>(pack.installedHarnesses);
  return supported.map((harness) => ({
    computeTargetId: LOCAL_MACHINE_TARGET_ID,
    computeTargetName: LOCAL_MACHINE_TARGET_NAME,
    harness,
    state: installed.has(harness)
      ? PackInstallState.Installed
      : PackInstallState.NotInstalled,
    installedVersion: installed.has(harness) ? (pack.version ?? null) : null,
    failureReason: null,
  }));
}

/**
 * The flattened per-machine cells the member block renders for a pack.
 *
 * Source resolution distinguishes the two read paths by the `installMatrix`
 * field's presence, which the surfaces set deliberately:
 *  - A NON-EMPTY `installMatrix` — the web member read resolved the member's
 *    registered nodes into cells. Rendered as-is.
 *  - An EMPTY `installMatrix` (`[]`) — the web member read ran and found the
 *    member has NO registered nodes. Returns `[]` so the block shows its honest
 *    "no machines" empty state; it must NOT fall back to a fabricated local
 *    "this machine" row, because the web has no local machine.
 *  - An ABSENT `installMatrix` (`null` / `undefined`) — no member matrix was
 *    built (the desktop local read, which never loads one). Falls back to the
 *    desktop LOCAL "this machine" cells from the pack's installed-harness state.
 *
 * Cells across all components of the pack are flattened; the member block groups
 * them by machine, not by component, so a single-component pack (the common
 * case) reads as one row per machine.
 */
export function memberTargetCells(pack: PackView): PackInstallCell[] {
  const matrix = pack.installMatrix;
  if (matrix) {
    return matrix.flatMap((component) => component.cells);
  }
  return localMachineInstallMatrix(pack);
}
