import {
  ComputePreference,
  type ComputePreferenceResponse,
  type ComputeTarget,
} from "@repo/api/src/types/compute-target";
import { sortByDateDesc } from "@repo/app/shared/lib/table-utils";

export type EffectiveComputeTargetSelection = {
  currentPreference: ComputePreference | null;
  needsSelection: boolean;
  onlineTargets: ComputeTarget[];
  effectiveTargetId: string | null;
  effectiveTarget: ComputeTarget | null;
  notInstalled: boolean;
  allOffline: boolean;
};

/**
 * Resolves the user-facing local compute target from the persisted compute
 * preference and the current target inventory. This mirrors the picker and is
 * shared by Settings so status checks target the same machine the user chose.
 */
export function resolveEffectiveComputeTargetSelection({
  preference,
  requireExplicitSelection = false,
  targets,
}: {
  preference: ComputePreferenceResponse | undefined;
  requireExplicitSelection?: boolean;
  targets: ComputeTarget[];
}): EffectiveComputeTargetSelection {
  const onlineTargets = targets.filter((target) => target.isOnline);
  if (requireExplicitSelection && preference?.isExplicit !== true) {
    return {
      currentPreference: null,
      needsSelection: true,
      onlineTargets,
      effectiveTargetId: null,
      effectiveTarget: null,
      notInstalled: targets.length === 0,
      allOffline:
        targets.length > 0 && targets.every((target) => !target.isOnline),
    };
  }

  const currentPreference =
    preference?.preferredComputeMode ?? ComputePreference.Cloud;
  const persistedTargetId = preference?.computeTargetId;
  const persistedIsOnline =
    persistedTargetId !== undefined &&
    onlineTargets.some((target) => target.id === persistedTargetId);
  const effectiveTargetId = persistedIsOnline
    ? persistedTargetId
    : (sortByDateDesc(onlineTargets, "lastSeenAt")[0]?.id ?? null);
  const effectiveTarget =
    currentPreference === ComputePreference.Local && effectiveTargetId !== null
      ? (targets.find((target) => target.id === effectiveTargetId) ?? null)
      : null;

  return {
    currentPreference,
    needsSelection: false,
    onlineTargets,
    effectiveTargetId,
    effectiveTarget,
    notInstalled: targets.length === 0,
    allOffline:
      targets.length > 0 && targets.every((target) => !target.isOnline),
  };
}
