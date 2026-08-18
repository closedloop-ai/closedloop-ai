"use client";

import { useCallback, useMemo, useState } from "react";
import type { MemberTargetsInstall } from "../components/member-targets-block";
import { memberInstallCellKey } from "../components/member-targets-block";
import {
  type MemberInstallDispatchCopy,
  memberInstallDispatchCopy,
  memberInstallRequestFailureCopy,
} from "../lib/member-install-dispatch-copy";
import { useMemberPackInstall } from "./use-member-pack-install";

/**
 * The ACT half of the member per-machine block, wired to the cloud dispatch
 * (ISS-5125).
 *
 * Owns the three things the presentational block deliberately does not: the
 * mutation, which cell is in flight, and what the LAST dispatch onto each cell
 * proved. Returns `null` when the surface should stay read-only, so a caller
 * spreads it straight onto `MemberTargetsBlock`/`PackDetail` with no branching
 * of its own.
 *
 * ## The two honesty rules encoded here
 *
 * 1. **A resolved POST is not an installed pack.** The cell's own
 *    `PackInstallState` keeps saying where the pack STANDS; this hook's outcome
 *    line says only what the dispatch proved. Nothing here rewrites a cell to
 *    `Installed`, and nothing here invalidates the per-machine read on success —
 *    a refetch that early would repaint the row to `Not installed` and read as
 *    "your click did nothing".
 * 2. **Outcomes are keyed per cell, and cleared when a cell is re-dispatched.**
 *    A member installing onto three machines keeps three separate answers; the
 *    stale one for a cell being retried is dropped at click time so the row can
 *    never show last attempt's failure next to this attempt's spinner.
 * 3. **One install per cell, and answers never outlive their pack.** In-flight
 *    cells are a SET, so starting an install on a second machine cannot silently
 *    re-enable the first machine's button while its dispatch is still
 *    outstanding; and every key is scoped to the pack it describes, so switching
 *    packs cannot inherit the previous pack's outcomes onto the same rows. Both
 *    failure modes ended in the same place — a duplicate install of a pack onto
 *    a node that was already installing it.
 */

type UseMemberTargetsInstallOptions = {
  /**
   * The selected pack. `null` (nothing selected) yields a null result — there
   * is nothing to install.
   */
  readonly packId: string | null;
  /**
   * Whether this surface offers the affordance at all: the closed-by-default
   * `member-self-service-install` flag AND a surface whose targets are the
   * member's own registered nodes. False → `null`, i.e. the read-only block.
   */
  readonly enabled: boolean;
};

/**
 * The hook's whole mutable state, held as ONE object so the pack it describes
 * and the per-cell answers about that pack can never be updated apart and drift
 * out of agreement.
 */
type MemberInstallDispatchState = {
  /** The pack every key below belongs to; `null` before the first dispatch. */
  readonly packId: string | null;
  /** Cell keys with a dispatch currently in flight. */
  readonly pendingCellKeys: readonly string[];
  /** Last settled dispatch outcome per cell key. */
  readonly dispatchByCellKey: Readonly<
    Record<string, MemberInstallDispatchCopy>
  >;
};

export function useMemberTargetsInstall({
  packId,
  enabled,
}: UseMemberTargetsInstallOptions): MemberTargetsInstall | null {
  const install = useMemberPackInstall();
  // `mutateAsync`, NOT `mutate`, and the difference is load-bearing for the
  // per-cell guarantee this hook advertises. `useMutation` yields ONE observer,
  // and `MutationObserver.mutate` both overwrites its `#mutateOptions` and
  // calls `#currentMutation.removeObserver(this)` (query-core 5.100.9,
  // mutationObserver.js:57-58). So a member who starts an install on a second
  // machine before the first settles detaches the first mutation from the
  // observer AND replaces its callbacks: the first dispatch's per-call
  // `onSuccess`/`onError` never fire, its cell key is never removed from
  // `pendingCellKeys`, and that machine's button stays disabled on a spinner
  // forever with no outcome line. The promise `mutateAsync` returns belongs to
  // the individual mutation, not to the observer, so every dispatch settles its
  // own cell no matter how many run concurrently.
  const { mutateAsync } = install;
  // Both maps are scoped to the pack they describe. A cell key is
  // (machine × harness) — it carries no pack — and the machine set is identical
  // for every pack, so without this scoping selecting a different pack would
  // inherit the previous pack's outcomes on the very same rows: the new pack
  // would show "Install started on Laptop." and, because a `Dispatched` outcome
  // is deliberately non-retryable, its Install button would be withdrawn
  // entirely. Keying the state by pack keeps each pack's answers its own.
  const [state, setState] = useState<MemberInstallDispatchState>({
    packId: null,
    pendingCellKeys: [],
    dispatchByCellKey: {},
  });

  // Reading the reset during render (rather than in an effect) means the block
  // never paints one frame of the previous pack's outcomes before an effect
  // clears them.
  const scoped =
    state.packId === packId
      ? state
      : { packId, pendingCellKeys: [], dispatchByCellKey: {} };

  const recordOutcome = useCallback(
    (forPackId: string, cellKey: string, copy: MemberInstallDispatchCopy) => {
      setState((previous) => {
        // A dispatch that resolves after the member moved to another pack is
        // discarded: its sentence describes a pack this surface is no longer
        // showing, and the cell it names belongs to the new pack's rows now.
        if (previous.packId !== forPackId) {
          return previous;
        }
        return {
          packId: previous.packId,
          pendingCellKeys: previous.pendingCellKeys.filter(
            (key) => key !== cellKey
          ),
          dispatchByCellKey: { ...previous.dispatchByCellKey, [cellKey]: copy },
        };
      });
    },
    []
  );

  const onInstall = useCallback<MemberTargetsInstall["onInstall"]>(
    ({ computeTargetId, computeTargetName, harness }) => {
      if (!packId) {
        return;
      }
      const cellKey = memberInstallCellKey(computeTargetId, harness);
      let alreadyInFlight = false;
      setState((previous) => {
        const base =
          previous.packId === packId
            ? previous
            : { packId, pendingCellKeys: [], dispatchByCellKey: {} };
        // Guard the double dispatch at the source. The button is disabled while
        // a cell is pending, but a disabled button is a UI affordance, not a
        // concurrency control — a second call must not start a second install.
        if (base.pendingCellKeys.includes(cellKey)) {
          alreadyInFlight = true;
          return base;
        }
        // Drop the previous outcome for THIS cell only. Leaving it would pair
        // the last attempt's sentence with this attempt's spinner; clearing the
        // whole map would erase the other machines' answers, which are still
        // true.
        const { [cellKey]: _dropped, ...rest } = base.dispatchByCellKey;
        return {
          packId,
          pendingCellKeys: [...base.pendingCellKeys, cellKey],
          dispatchByCellKey: rest,
        };
      });
      if (alreadyInFlight) {
        return;
      }
      mutateAsync({ computeTargetId, packId, harness }).then(
        (response) =>
          recordOutcome(
            packId,
            cellKey,
            memberInstallDispatchCopy(
              response.state,
              computeTargetName,
              response.reason
            )
          ),
        (error: unknown) =>
          recordOutcome(
            packId,
            cellKey,
            memberInstallRequestFailureCopy(error, computeTargetName)
          )
      );
    },
    [packId, mutateAsync, recordOutcome]
  );

  const { pendingCellKeys, dispatchByCellKey } = scoped;

  return useMemo(() => {
    if (!(enabled && packId)) {
      return null;
    }
    return { onInstall, pendingCellKeys, dispatchByCellKey };
  }, [enabled, packId, onInstall, pendingCellKeys, dispatchByCellKey]);
}
