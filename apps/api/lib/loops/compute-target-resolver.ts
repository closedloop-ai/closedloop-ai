import {
  ComputePreference,
  type ComputeTarget,
} from "@repo/api/src/types/compute-target";
import type { PreferredComputeMode } from "@repo/database";
import { computeTargetsService } from "@/app/compute-targets/service";

export type ResolveComputeTargetResult =
  | { reason: "resolved"; target: ComputeTarget }
  | { reason: "no_targets" }
  | { reason: "no_online_targets" }
  | { reason: "multiple_targets"; targets: ComputeTarget[] }
  | { reason: "hint_offline"; target: ComputeTarget }
  | { reason: "hint_not_found" }
  | { reason: "cloud_resolved" };

/**
 * Determines the effective compute preference for a user by checking whether
 * they have any online local compute targets. Returns Local if any target is
 * online, Cloud otherwise.
 */
export async function resolveEffectiveComputePreference(
  userId: string,
  organizationId: string
): Promise<ComputePreference> {
  const targets = await computeTargetsService.listByOwner(
    organizationId,
    userId
  );

  const hasOnlineTarget = targets.some((t) => t.isOnline);
  return hasOnlineTarget ? ComputePreference.Local : ComputePreference.Cloud;
}

/**
 * Resolve which compute target to use for a loop launch.
 *
 * When a hint (computeTargetId) is provided, the target must belong to both
 * the organization and the user (findOwnedById) — an org-only check would
 * permit cross-user dispatch.
 *
 * When no hint is given, the resolver auto-selects the single online target
 * owned by the user, or returns an appropriate failure reason if there are
 * zero, multiple online, or no online targets.
 *
 * If preferredComputeMode is CLOUD (or resolves to CLOUD via effective
 * preference), returns { reason: 'cloud_resolved' } immediately.
 *
 * If no online targets exist and fallbackToCloud is true, also returns
 * { reason: 'cloud_resolved' }.
 */
export async function resolveComputeTarget(
  organizationId: string,
  userId: string,
  computeTargetIdHint?: string,
  preferredComputeMode?: PreferredComputeMode | null,
  fallbackToCloud?: boolean
): Promise<ResolveComputeTargetResult> {
  if (preferredComputeMode === "CLOUD") {
    return { reason: "cloud_resolved" };
  }

  if (computeTargetIdHint) {
    const target = await computeTargetsService.findOwnedById(
      computeTargetIdHint,
      organizationId,
      userId
    );

    if (!target) {
      return { reason: "hint_not_found" };
    }

    if (!target.isOnline) {
      return { reason: "hint_offline", target };
    }

    return { reason: "resolved", target };
  }

  const targets = await computeTargetsService.listByOwner(
    organizationId,
    userId
  );

  if (targets.length === 0) {
    return { reason: "no_targets" };
  }

  const onlineTargets = targets.filter((t) => t.isOnline);

  if (onlineTargets.length === 0) {
    if (fallbackToCloud) {
      return { reason: "cloud_resolved" };
    }
    return { reason: "no_online_targets" };
  }

  if (onlineTargets.length > 1) {
    return { reason: "multiple_targets", targets: onlineTargets };
  }

  return { reason: "resolved", target: onlineTargets[0] };
}
