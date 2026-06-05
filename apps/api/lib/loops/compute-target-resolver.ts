import {
  ComputePreference,
  type ComputeTarget,
} from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
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
  const targets = await computeTargetsService.listAvailableForOrg(
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
 * When no hint is given, online targets are sorted by lastSeenAt descending.
 * If preferredComputeTargetId matches one of the online targets, that target is
 * resolved directly. Otherwise, the most recently active online target is
 * auto-selected. Returns an appropriate failure reason only when there are zero
 * targets or no online targets.
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
  preferredComputeMode?: string | null,
  fallbackToCloud?: boolean,
  preferredComputeTargetId?: string
): Promise<ResolveComputeTargetResult> {
  log.info("[compute-target-resolver] Resolving compute target", {
    organizationId,
    userId,
    hasHint: !!computeTargetIdHint,
    preferredComputeMode: preferredComputeMode ?? "none",
    fallbackToCloud,
    preferredComputeTargetId,
  });

  if (preferredComputeMode === ComputePreference.Cloud) {
    log.info("[compute-target-resolver] Resolved: cloud (user preference)");
    return { reason: "cloud_resolved" };
  }

  if (computeTargetIdHint) {
    // Check owned targets first, then shared targets in the org
    const target =
      (await computeTargetsService.findOwnedById(
        computeTargetIdHint,
        organizationId,
        userId
      )) ??
      (await computeTargetsService.findAccessibleById(
        computeTargetIdHint,
        organizationId,
        userId
      ));

    if (!target) {
      return { reason: "hint_not_found" };
    }

    if (!target.isOnline) {
      return { reason: "hint_offline", target };
    }

    return { reason: "resolved", target };
  }

  const targets = await computeTargetsService.listAvailableForOrg(
    organizationId,
    userId
  );

  if (targets.length === 0) {
    return { reason: "no_targets" };
  }

  const onlineTargets = targets
    .filter((t) => t.isOnline)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

  if (onlineTargets.length === 0) {
    if (fallbackToCloud) {
      log.info(
        "[compute-target-resolver] No online targets, falling back to cloud"
      );
      return { reason: "cloud_resolved" };
    }
    log.warn("[compute-target-resolver] No online targets found", {
      totalTargets: targets.length,
      targetIds: targets.map((t) => t.id),
    });
    return { reason: "no_online_targets" };
  }

  if (onlineTargets.length > 1) {
    if (preferredComputeTargetId) {
      const preferredTarget = onlineTargets.find(
        (t) => t.id === preferredComputeTargetId
      );
      if (preferredTarget) {
        log.info(
          "[compute-target-resolver] Resolved to preferred target among multiple online targets",
          {
            targetId: preferredTarget.id,
            machineName: preferredTarget.machineName,
          }
        );
        return { reason: "resolved", target: preferredTarget };
      }
    }
    const mostRecentTarget = onlineTargets[0];
    log.info(
      "[compute-target-resolver] Multiple online targets — auto-selecting most recently active",
      {
        targetId: mostRecentTarget.id,
        machineName: mostRecentTarget.machineName,
        lastSeenAt: mostRecentTarget.lastSeenAt,
        totalOnline: onlineTargets.length,
      }
    );
    return { reason: "resolved", target: mostRecentTarget };
  }

  log.info("[compute-target-resolver] Resolved to single online target", {
    targetId: onlineTargets[0].id,
    machineName: onlineTargets[0].machineName,
  });
  return { reason: "resolved", target: onlineTargets[0] };
}

export type UserComputePreferences = {
  preferredComputeMode: string | undefined;
  preferredComputeTargetId: string | undefined;
};

export async function fetchUserComputePreferences(
  userId: string
): Promise<UserComputePreferences> {
  const user = await withDb((db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { preferredComputeMode: true, preferredComputeTargetId: true },
    })
  );
  return {
    preferredComputeMode: user?.preferredComputeMode ?? undefined,
    preferredComputeTargetId: user?.preferredComputeTargetId ?? undefined,
  };
}
