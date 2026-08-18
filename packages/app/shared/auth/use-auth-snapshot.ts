"use client";

import type { AuthAdapter, AuthSnapshot } from "./auth-adapter";
import { useAuthAdapter, useOptionalAuthAdapter } from "./provider";

/**
 * Live auth snapshot for the current surface. The minimal identity surface
 * shared feature code may depend on; anything needing the full auth SDK is
 * shell-specific and stays in the app.
 */
export function useAuthSnapshot(): AuthSnapshot {
  return useAuthAdapter().useAuthSnapshot();
}

// Stable signed-out-but-loaded snapshot used when no auth provider is mounted.
// Module-level so the reference is stable across renders (safe in a dependency
// array). `isLoaded` is true so a provider-less consumer resolves immediately to
// the signed-out branch rather than waiting forever.
const NO_AUTH_SNAPSHOT: AuthSnapshot = {
  isLoaded: true,
  userId: null,
  orgId: null,
  getToken: () => Promise.resolve(null),
};

// Fallback adapter whose hook returns the stable signed-out snapshot without
// touching context. Selected in place of a missing provider so exactly one
// `useAuthSnapshot` hook is always called (rules-of-hooks), regardless of
// whether a real adapter is mounted.
const NO_AUTH_ADAPTER: AuthAdapter = {
  useAuthSnapshot: () => NO_AUTH_SNAPSHOT,
};

/**
 * Non-throwing counterpart to {@link useAuthSnapshot}: the live snapshot when a
 * provider is mounted, else a stable signed-out default. For shared machinery
 * that can degrade gracefully without an identity (e.g. per-user namespacing a
 * persisted view). The adapter is selected unconditionally, then its snapshot
 * hook is called once, so hook order never varies.
 */
export function useOptionalAuthSnapshot(): AuthSnapshot {
  const adapter = useOptionalAuthAdapter() ?? NO_AUTH_ADAPTER;
  return adapter.useAuthSnapshot();
}
