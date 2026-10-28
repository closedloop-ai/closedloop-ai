"use client";

import { useResolvedOrDeadline } from "../hooks/use-resolved-or-deadline";
import type { FeatureFlagAdapter } from "./feature-flag-adapter";
import {
  useFeatureFlagAdapter,
  useFeatureFlagAdapterOptional,
} from "./provider";

/**
 * Whether the named feature flag is enabled for the current surface. Resolves
 * through the injected feature-flag port (PostHog on web; the desktop shell's
 * own adapter), so `@repo/app` stays free of the analytics SDK.
 */
export function useFeatureFlagEnabled(key: string): boolean {
  return useFeatureFlagAdapter().useFeatureFlagEnabled(key);
}

/**
 * Like {@link useFeatureFlagEnabled}, but resolves to `false` (never throws) when
 * no `FeatureFlagAdapterProvider` is mounted. For purely-additive, flag-gated
 * affordances in SHARED components that may render under a mount site without the
 * provider (Storybook, mini-table tests) — they stay off there rather than
 * crashing the subtree, while real product surfaces (which mount the provider)
 * still resolve the flag normally.
 */
export function useFeatureFlagEnabledOptional(key: string): boolean {
  return useFeatureFlagAdapterOptional().useFeatureFlagEnabled(key);
}

/**
 * How long a surface will wait for an unresolved flag before proceeding on its
 * closed default (FEA-1626).
 *
 * The gate below exists to stop a double fetch, not to become a new way for the
 * board to never load: if PostHog fails to initialize the flag stays unresolved
 * forever, and an ungated wait would leave a signed-in user staring at a
 * skeleton. Past this deadline the surface proceeds as flag-off — which is the
 * pre-flag behavior, so a flag-service outage degrades to "the old screen"
 * rather than "no screen".
 */
export const FEATURE_FLAG_RESOLUTION_DEADLINE_MS = 3000;

/** Stand-in for an adapter with no asynchronous resolution to report. */
const alwaysResolved = () => true;

/**
 * Whether the named flag has been resolved yet — as opposed to resolving to
 * `false`. See {@link FeatureFlagAdapter.useFeatureFlagResolved}; an adapter that
 * does not implement it has no unresolved state and reads as resolved.
 */
export function useFeatureFlagResolved(key: string): boolean {
  const adapter = useFeatureFlagAdapter();
  // One hook call either way, and the adapter identity is stable for the life of
  // a mounted tree, so the selected implementation cannot change between
  // renders. Same shape as `useFeatureFlagSafe` in `@repo/analytics/client`.
  const useResolved = adapter.useFeatureFlagResolved ?? alwaysResolved;
  return useResolved(key);
}

/**
 * A flag plus whether it is safe to ACT on it yet — for a surface whose data
 * request depends on the flag's value.
 *
 * `isReady` is false only while the flag is genuinely unresolved and the
 * {@link FEATURE_FLAG_RESOLUTION_DEADLINE_MS} deadline has not passed. Gate the
 * query's `enabled` on it and an enabled user issues ONE request, with the right
 * params, instead of an unbounded read followed by a refetch.
 */
export type FeatureFlagGate = {
  enabled: boolean;
  isReady: boolean;
  isResolved: boolean;
};

export function useFeatureFlagGate(
  key: string,
  deadlineMs: number = FEATURE_FLAG_RESOLUTION_DEADLINE_MS
): FeatureFlagGate {
  const enabled = useFeatureFlagEnabled(key);
  const resolved = useFeatureFlagResolved(key);
  // ISS-4655 extracted the resolve-or-deadline latch so the persisted-view gate
  // shares this exact mechanism rather than re-declaring it. Behavior here is
  // unchanged, except that the latch now resets if a resolved flag goes
  // unresolved again — which `isReady` already masked, since `resolved` alone
  // satisfies it.
  return {
    enabled,
    isReady: useResolvedOrDeadline(resolved, deadlineMs),
    isResolved: resolved,
  };
}

/**
 * Like {@link useFeatureFlagGate}, but resolves to a CLOSED, READY gate when no
 * `FeatureFlagAdapterProvider` is mounted — the {@link useFeatureFlagEnabledOptional}
 * posture, for a SHARED component that keys a data read off a flag and also
 * renders under mount sites without the provider (Storybook, mini-table tests).
 *
 * Both halves matter and they are not interchangeable. Without the optional
 * adapter this throws where the plain `useFeatureFlagEnabledOptional` would have
 * degraded; without the readiness half a consumer keys its request off a flag
 * that reads `false` until PostHog answers, issues the flag-off request anyway,
 * and the later flip only disables a request already in flight — the FEA-1626
 * cost the flag exists to avoid.
 */
export function useFeatureFlagGateOptional(
  key: string,
  deadlineMs: number = FEATURE_FLAG_RESOLUTION_DEADLINE_MS
): FeatureFlagGate {
  const adapter = useFeatureFlagAdapterOptional();
  // Same fixed-hook-order reasoning as `useFeatureFlagResolved` above: the
  // adapter identity is stable for the life of a mounted tree, so the selected
  // implementation cannot change between renders.
  const useResolved = adapter.useFeatureFlagResolved ?? alwaysResolved;
  const resolved = useResolved(key);
  return {
    enabled: adapter.useFeatureFlagEnabled(key),
    isReady: useResolvedOrDeadline(resolved, deadlineMs),
    isResolved: resolved,
  };
}
