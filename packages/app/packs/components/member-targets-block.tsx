"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { MonitorIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment, useMemo } from "react";
import type { MemberInstallAction } from "../lib/member-install-action";
import type { MemberInstallDispatchCopy } from "../lib/member-install-dispatch-copy";
import { memberTargetCells } from "../lib/member-targets";
import type { PackInstallCell } from "../lib/pack-install-matrix";
import type { PackView } from "../lib/pack-view";
import { InstallStateStatus } from "./install-state-status";
import { MemberInstallControl } from "./member-install-control";
import { harnessLabel } from "./pack-meta";
import { PageSection } from "./page-section";

/**
 * Member per-machine install-state block (FEA-4077).
 *
 * The member's own view of where a pack stands on each of their machines: one
 * honest `PackInstallState` row per (machine × harness), rendered through the
 * shared {@link InstallStateStatus} so it reads with the same words and treatment
 * as every other packs surface (installed / not installed / update available /
 * installing / offline / not supported / failed — never color alone).
 *
 * The READ half: DESKTOP reflects local install state ("This machine", via
 * `desktopApi.db.catalog*`); the WEB member surface reflects the member's
 * registered nodes.
 *
 * ISS-5125 adds the ACT half, which FEA-4077 deferred. When the surface supplies
 * {@link MemberTargetsBlockProps.install}, each cell also renders its
 * {@link MemberInstallControl} — the member's own install of this pack onto that
 * (machine × harness). The block stays a pure presentational component: it owns
 * no transport and no permission logic. The surface decides whether the ACT half
 * exists at all (it is closed by default behind the
 * `member-self-service-install` flag on both shells) and supplies the dispatch;
 * the org role model already grants every member this capability
 * (`PackAdminCapability.InstallToOwnMachines`) and the API enforces node
 * ownership, so nothing here widens who may install.
 *
 * Honest states, per the FEA-4088 Parker principle:
 *  - `isLoading` → per-row skeletons (the block is coming, not empty).
 *  - `error`     → an in-block error state (never a silent absence, never a lie
 *                  that the pack is "not installed" when the read actually failed).
 *  - no machines → an honest empty state pointing the member at their nodes.
 *  - an offline machine renders its real `Offline` cell — stale-but-honest.
 */

/**
 * The ACT half of the block, supplied only by a surface that can actually
 * dispatch a member install. Absent (the default, and what every pre-ISS-5125
 * caller passes) the block renders exactly the read-only rows it always did.
 */
export type MemberTargetsInstall = {
  /**
   * Dispatch an install of this pack onto one (machine × harness). The surface
   * owns the transport — the web member surface POSTs to
   * `/compute-targets/{id}/member-installs`; the desktop surface runs its
   * existing local catalog install.
   */
  readonly onInstall: (input: {
    computeTargetId: string;
    /**
     * Carried alongside the id so the surface can write honest outcome copy
     * ("mbp-ci-runner is offline…") without a second lookup against a list it
     * may no longer hold — and so the name in the outcome is provably the same
     * one the member clicked, not a re-resolution that could drift.
     */
    computeTargetName: string;
    harness: string;
    action: MemberInstallAction;
  }) => void;
  /**
   * The cell keys (`${computeTargetId}:${harness}`) whose dispatches are in
   * flight. Keyed per CELL rather than a single boolean so one pending install
   * disables its own button instead of every button in the block.
   *
   * A COLLECTION, not a single key: a member can start an install on one
   * machine and click another before the first resolves. With a single scalar
   * the second click silently re-enabled the first cell's button while its
   * dispatch was still outstanding, inviting a duplicate install of the same
   * pack onto the same node — the exact thing the per-cell keying exists to
   * prevent.
   */
  readonly pendingCellKeys?: readonly string[];
  /**
   * Last dispatch outcome per cell key. A map rather than a single "last
   * result" so a member who installs onto two machines keeps both answers —
   * a shared slot would silently overwrite the first machine's outcome with the
   * second's and attribute it to the wrong row.
   */
  readonly dispatchByCellKey?: Readonly<
    Record<string, MemberInstallDispatchCopy>
  >;
};

type MemberTargetsBlockProps = {
  readonly pack: PackView;
  /** The per-machine read is in flight — render skeleton rows. */
  readonly isLoading?: boolean;
  /** The per-machine read failed — render the honest error state. */
  readonly error?: boolean;
  /**
   * Section description override. Web (registered nodes) and desktop (this
   * machine) tell slightly different stories; the surface passes the honest one.
   */
  readonly description?: string;
  /** ISS-5125 ACT half. Omitted → the block stays read-only. */
  readonly install?: MemberTargetsInstall | null;
};

const DEFAULT_DESCRIPTION = "Where this pack stands on each of your machines.";

/** A machine group: one device, its resolved harness cells sorted by harness. */
type MachineGroup = {
  readonly computeTargetId: string;
  readonly computeTargetName: string;
  readonly cells: PackInstallCell[];
};

/** Group the flattened install cells by machine so each device reads as one row. */
function groupCellsByMachine(
  cells: readonly PackInstallCell[]
): MachineGroup[] {
  const byMachine = new Map<string, MachineGroup>();
  for (const cell of cells) {
    const existing = byMachine.get(cell.computeTargetId);
    if (existing) {
      existing.cells.push(cell);
    } else {
      byMachine.set(cell.computeTargetId, {
        computeTargetId: cell.computeTargetId,
        computeTargetName: cell.computeTargetName,
        cells: [cell],
      });
    }
  }
  const groups = [...byMachine.values()];
  for (const group of groups) {
    group.cells.sort((a, b) => a.harness.localeCompare(b.harness));
  }
  return groups.sort((a, b) =>
    a.computeTargetName.localeCompare(b.computeTargetName)
  );
}

// Mirror the resolved list's shape (one bordered `ul` with `divide-y` rows) so
// the container does not visibly change shape when the read settles.
const LoadingRows = () => (
  <ul
    className="divide-y divide-border rounded-lg border border-border"
    data-testid="member-targets-skeleton"
  >
    {[0, 1, 2].map((row) => (
      <li
        className="flex items-center justify-between gap-4 px-4 py-3"
        key={row}
      >
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-28" />
      </li>
    ))}
  </ul>
);

const LoadError = () => (
  <EmptyState
    description="We couldn't load the install state for your machines. Check your connection and try again."
    icon={TriangleAlertIcon}
    size="compact"
    title="Couldn't load your machines"
  />
);

const NoMachines = () => (
  <EmptyState
    description="No machines are registered to your account yet. Connect a desktop node to see this pack's install state per machine."
    icon={MonitorIcon}
    size="compact"
    title="No machines yet"
  />
);

// The status column is right-aligned but given a fixed harness-label column
// (a two-column grid per harness cell) so states stack in a straight vertical
// line down the list — scanning "which machine has this" stays fast even when
// harness labels and status words vary in width.
const MachineRow = ({
  group,
  packName,
  install,
}: {
  group: MachineGroup;
  packName: string;
  install?: MemberTargetsInstall | null;
}) => (
  <li
    className="flex items-start justify-between gap-4 px-4 py-3"
    data-testid="member-target-row"
  >
    <span className="flex min-w-0 items-center gap-2">
      <MonitorIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="truncate font-medium text-sm">
        {group.computeTargetName}
      </span>
    </span>
    <span
      className={cn(
        "grid shrink-0 auto-rows-min items-center gap-x-3 gap-y-1",
        // The ACT column only exists when the surface can dispatch. Without it
        // the row keeps its original two-column rhythm rather than reserving a
        // permanently empty third column that reads as a missing control.
        install ? "grid-cols-[auto_auto_auto]" : "grid-cols-[auto_auto]"
      )}
    >
      {group.cells.map((cell) => {
        const cellKey = memberInstallCellKey(
          cell.computeTargetId,
          cell.harness
        );
        return (
          <Fragment key={cellKey}>
            <span className="text-right text-muted-foreground text-xs">
              {harnessLabel(cell.harness)}
            </span>
            <InstallStateStatus state={cell.state} />
            {install ? (
              <MemberInstallControl
                computeTargetName={cell.computeTargetName}
                dispatch={install.dispatchByCellKey?.[cellKey] ?? null}
                harnessLabel={harnessLabel(cell.harness)}
                isPending={install.pendingCellKeys?.includes(cellKey) ?? false}
                onAction={(action) =>
                  install.onInstall({
                    computeTargetId: cell.computeTargetId,
                    computeTargetName: cell.computeTargetName,
                    harness: cell.harness,
                    action,
                  })
                }
                packName={packName}
                state={cell.state}
              />
            ) : null}
          </Fragment>
        );
      })}
    </span>
  </li>
);

export const MemberTargetsBlock = ({
  pack,
  isLoading = false,
  error = false,
  description = DEFAULT_DESCRIPTION,
  install = null,
}: MemberTargetsBlockProps) => {
  const groups = useMemo(
    () => groupCellsByMachine(memberTargetCells(pack)),
    [pack]
  );

  const body = () => {
    if (isLoading) {
      return <LoadingRows />;
    }
    if (error) {
      return <LoadError />;
    }
    if (groups.length === 0) {
      return <NoMachines />;
    }
    return (
      <ul className="divide-y divide-border rounded-lg border border-border">
        {groups.map((group) => (
          <MachineRow
            group={group}
            install={install}
            key={group.computeTargetId}
            packName={pack.name}
          />
        ))}
      </ul>
    );
  };

  return (
    <PageSection description={description} title="Your machines">
      {body()}
    </PageSection>
  );
};

/**
 * The stable per-cell identity used for pending state and dispatch outcomes.
 * A machine appears once per harness, so (target, harness) is the narrowest key
 * that cannot collide — keying on the machine alone would render a Claude
 * install's outcome on that same machine's Codex row.
 */
export function memberInstallCellKey(
  computeTargetId: string,
  harness: string
): string {
  return `${computeTargetId}:${harness}`;
}
