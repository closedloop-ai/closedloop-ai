"use client";

import type { MemberComputeTarget } from "@repo/app/packs/lib/member-targets";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useMemo } from "react";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";

/**
 * The member per-machine block's data half, on the web surface (FEA-4077).
 *
 * Composes the two reads that block depends on — the member's own compute
 * targets and `/me` — into the exact shape `usePackDashboardSelection` and
 * `PacksWorkspace` consume. Extracted from `CatalogDashboard` (ISS-5125) so the
 * dashboard component keeps one job: it was already at the cognitive-complexity
 * ceiling, and the member-surface branching is a cohesive unit that belongs
 * together rather than interleaved with catalog authoring state.
 *
 * The `isAdmin` split is load-bearing in three different ways, which is why it
 * cannot be reduced to one boolean at the call site:
 *  - neither query runs at all for an admin (no wasted reads, no other member's
 *    machines ever fetched);
 *  - `targets` is `undefined` for an admin, which is what tells the selection
 *    hook to KEEP the admin distribution matrix rather than overwrite it with an
 *    empty member matrix;
 *  - `[]` (member, but no resolvable identity or no nodes) is a DIFFERENT
 *    signal: it means the read ran and found no machines, so the block shows its
 *    honest "no machines" empty state.
 */

export type MemberPackTargetsState = {
  /**
   * The member's own registered nodes, or `undefined` on the admin surface. See
   * the `undefined` vs `[]` distinction above — they are not interchangeable.
   */
  readonly targets: MemberComputeTarget[] | undefined;
  /** Either underlying read is still in flight. */
  readonly isLoading: boolean;
  /**
   * A read failed AND left no usable cached rows — i.e. an initial-load
   * failure. TanStack Query keeps the last data alongside a background-refetch
   * error, so a transient refetch failure must keep the previously-loaded
   * machines visible instead of discarding them for an error state. `/me` gates
   * the same way, since its failure is what collapses `targets` to an empty
   * list.
   */
  readonly hasErrored: boolean;
  /** The resolved member id, for surfaces that scope other reads by it. */
  readonly currentUserId: string | undefined;
};

export function useMemberPackTargets(isAdmin: boolean): MemberPackTargetsState {
  const {
    data: currentUser,
    error: currentUserError,
    isLoading: currentUserLoading,
  } = useCurrentUser({ enabled: !isAdmin });
  const computeTargets = useComputeTargets({ enabled: !isAdmin });

  const targets = useMemo<MemberComputeTarget[] | undefined>(() => {
    if (isAdmin) {
      return;
    }
    if (!currentUser?.id) {
      return [];
    }
    return (computeTargets.data ?? [])
      .filter((target) => target.userId === currentUser.id)
      .map((target) => ({
        id: target.id,
        machineName: target.machineName,
        selectedHarness: target.selectedHarness,
        isOnline: target.isOnline,
      }));
  }, [isAdmin, currentUser?.id, computeTargets.data]);

  return {
    targets,
    isLoading: !isAdmin && (computeTargets.isLoading || currentUserLoading),
    hasErrored:
      !isAdmin &&
      ((Boolean(computeTargets.error) && computeTargets.data === undefined) ||
        (Boolean(currentUserError) && currentUser === undefined)),
    currentUserId: currentUser?.id,
  };
}
