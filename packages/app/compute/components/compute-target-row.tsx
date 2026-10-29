"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { Button } from "@repo/design-system/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { formatLastSeen } from "../lib/format-last-seen";
import { ComputeTargetCard } from "./compute-target-card";
import {
  DesktopSecurityBadge,
  DesktopUpdateDownloadButton,
  getTargetSecurity,
  requiresDesktopUpdateAction,
} from "./desktop-security";

/**
 * ONE registered Desktop, as both Settings trees render it (PLN-1915 D9).
 *
 * Extracted from `LocalComputeTargetsCard`, which was 519 lines and rendered
 * its own heading and its own empty state, so it could not be mounted as a v2
 * panel body — and folded a failed read into an empty list, which is the exact
 * defect the v2 data-state contract exists to fix. The legacy card and the v2
 * panel now compose this instead, so the security badge, the last-seen
 * subtitle, the update affordance, the ownership predicate and the Delete
 * control cannot drift between them.
 *
 * The SLOT is what could not move: the update-and-restart button needs the
 * web-owned `@/hooks/queries/use-compute-targets` dispatch hooks. Each host
 * passes its own; this module decides only WHERE it goes.
 *
 * OWNERSHIP IS THE GATE, not role (D4). `/compute-targets/{id}` DELETE is
 * `deleteOwned`, and the list marks a target the viewer does not own by
 * populating `ownerName` — so a row for somebody else's machine renders no
 * Delete and no actions at all, rather than offering controls the server would
 * refuse. It is the same predicate both callers filter their lists on, held
 * here so the controls cannot outlive the filter. The API stopped listing other
 * members' targets in ISS-12617; the `ownerName` branch stays until no older
 * API that still lists them can serve this bundle (ISS-12450).
 */

export type ComputeTargetRowProps = {
  target: ComputeTarget;
  /** Where a manual desktop download goes, when the security state needs one. */
  desktopUpdateUrl: string | null;
  isDesktopReleaseLoading: boolean;
  /** True while an update-and-restart is in flight for this target. */
  isBusy?: boolean;
  isRemoving?: boolean;
  onRemove?: () => void;
  updateAction?: ReactNode;
};

export function ComputeTargetRow({
  target,
  desktopUpdateUrl,
  isDesktopReleaseLoading,
  isBusy = false,
  isRemoving = false,
  onRemove,
  updateAction,
}: Readonly<ComputeTargetRowProps>) {
  const security = getTargetSecurity(target);
  const isOwned = !target.ownerName;

  return (
    <ComputeTargetCard
      actions={
        isOwned ? (
          <>
            {requiresDesktopUpdateAction(security) && (
              <DesktopUpdateDownloadButton
                downloadUrl={desktopUpdateUrl}
                isLoading={isDesktopReleaseLoading}
              />
            )}
            {updateAction}
            <Button
              disabled={isRemoving || isBusy}
              onClick={onRemove}
              size="sm"
              variant="outline"
            >
              {isRemoving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete
            </Button>
          </>
        ) : null
      }
      isOnline={target.isOnline}
      name={target.machineName}
      securityBadge={<DesktopSecurityBadge security={security} />}
      subtitle={
        <>
          {target.platform} - Last seen {formatLastSeen(target.lastSeenAt)}
        </>
      }
    />
  );
}
