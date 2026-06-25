"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { hasEffectiveCommandSigningSupport } from "@/lib/desktop-command-signing/command-signer";

let targetsById = new Map<string, ComputeTarget>();

/**
 * Replaces the browser signing snapshot with the latest full `/compute-targets`
 * response so stale conflict-row capability hints cannot authorize signing.
 */
export function cacheComputeTargetsForSigning(targets: ComputeTarget[]): void {
  targetsById = new Map(targets.map((target) => [target.id, target]));
}

/** Returns the latest cached full compute-target row for signing decisions. */
export function getCachedComputeTargetForSigning(
  targetId: string
): ComputeTarget | null {
  return targetsById.get(targetId) ?? null;
}

/**
 * Returns true only when the latest browser-known target snapshot has both
 * Desktop-local and server-side command-signing support explicitly enabled.
 */
export function isCachedComputeTargetSigningEffective(
  targetId: string
): boolean {
  const target = getCachedComputeTargetForSigning(targetId);
  return target ? hasEffectiveCommandSigningSupport(target) : false;
}
