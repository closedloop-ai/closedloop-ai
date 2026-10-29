"use client";

import { useMemo } from "react";
import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";
import { useFeatureFlagGateOptional } from "../feature-flags/use-feature-flag-enabled";
import { ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import { orgScopedViewStateKey } from "../lib/org-scoped-view-state-key";
import { useResolvedOrDeadline } from "./use-resolved-or-deadline";

/**
 * How long a surface gating a data request on `isViewReady` waits for auth to
 * hydrate before proceeding on the DEFAULT view (ISS-4655).
 *
 * `authLoaded` is the one input to `isViewReady` that can stall indefinitely: if
 * Clerk never initializes it stays false forever. {@link useResolvedOrDeadline}
 * carries the mechanism and the reasoning; this is only the duration, kept
 * separate from FEA-1626's `FEATURE_FLAG_RESOLUTION_DEADLINE_MS` because the two
 * answer to different services and should be tunable apart, even though both are
 * 3s today.
 */
export const VIEW_RESTORE_AUTH_DEADLINE_MS = 3000;

/**
 * The keys/latch a persisted table view is read and written under.
 * `storageKey` is the WRITE key (null ⇒ persistence is off); `restoreStorageKey`
 * is the first READ key; `fallbackStorageKeys` are ordered seed/migration reads
 * for a newly active identity; and `authSettled` is the bounded wait that lets
 * `isViewReady` open.
 */
export type TableViewStorageKeys = {
  storageKey: string | null;
  restoreStorageKey: string | null;
  fallbackStorageKeys: readonly string[];
  authSettled: boolean;
};

/**
 * Resolve where one persisted table view lives, for the surface identified by
 * `keyPrefix` + `persistKey`.
 *
 * Branches named-view collections deliberately do not use this rollout key:
 * their saved owner/repository filters remain org-scoped throughout rollout.
 * ISS-10209 removed their control and automatic application, so the live table
 * can keep this resolver's user-to-org migration without reading an invisible
 * named arrangement before the list request.
 *
 * Extracted from `usePersistedTableViewState` (ISS-9450) so the server-backed
 * sync in `useGridPreferenceRemote` reads the SAME key this hook writes.
 */
export function useTableViewStorageKey(options: {
  persistKey?: string;
  keyPrefix: string;
}): TableViewStorageKeys {
  const { persistKey, keyPrefix } = options;

  const { userId, orgId, isLoaded: authLoaded } = useOptionalAuthSnapshot();
  const orgScopedGate = useFeatureFlagGateOptional(
    ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY,
    VIEW_RESTORE_AUTH_DEADLINE_MS
  );
  const baseStorageKey = useMemo(() => {
    return persistKey ? `${keyPrefix}${persistKey}` : null;
  }, [persistKey, keyPrefix]);
  const orgScopedStorageKey = useMemo(() => {
    if (!baseStorageKey) {
      return null;
    }
    return orgScopedViewStateKey(baseStorageKey, userId, orgId);
  }, [baseStorageKey, userId, orgId]);

  const hasSignedInIdentity = hasStorageIdentity(userId);

  // ISS-4655 / ISS-10091: bound the wait on every input needed to choose the
  // storage identity. After the deadline an unresolved flag acts closed, while
  // an enabled org-scoped path with no organization id stays memory-only.
  const authSettled = useResolvedOrDeadline(
    !baseStorageKey ||
      (authLoaded &&
        orgScopedGate.isReady &&
        (!(orgScopedGate.enabled && hasSignedInIdentity) ||
          orgScopedStorageKey !== null)),
    VIEW_RESTORE_AUTH_DEADLINE_MS
  );

  const keys = useMemo((): Omit<TableViewStorageKeys, "authSettled"> => {
    if (!(baseStorageKey && authSettled)) {
      return NO_STORAGE_KEYS;
    }
    if (!authLoaded) {
      return {
        fallbackStorageKeys: NO_FALLBACK_STORAGE_KEYS,
        restoreStorageKey: baseStorageKey,
        storageKey: null,
      };
    }
    if (!hasSignedInIdentity) {
      return {
        fallbackStorageKeys: NO_FALLBACK_STORAGE_KEYS,
        restoreStorageKey: baseStorageKey,
        storageKey: baseStorageKey,
      };
    }
    const userStorageKey = userScopedTableViewStorageKey(
      baseStorageKey,
      userId
    );
    if (orgScopedGate.enabled && orgScopedGate.isResolved) {
      if (!orgScopedStorageKey) {
        return NO_STORAGE_KEYS;
      }
      return {
        fallbackStorageKeys: [userStorageKey, baseStorageKey],
        restoreStorageKey: orgScopedStorageKey,
        storageKey: orgScopedStorageKey,
      };
    }
    return {
      fallbackStorageKeys: [baseStorageKey],
      restoreStorageKey: userStorageKey,
      storageKey: userStorageKey,
    };
  }, [
    authLoaded,
    authSettled,
    baseStorageKey,
    hasSignedInIdentity,
    orgScopedGate.enabled,
    orgScopedGate.isResolved,
    orgScopedStorageKey,
    userId,
  ]);

  return { authSettled, ...keys };
}

const NO_FALLBACK_STORAGE_KEYS: readonly string[] = [];

const NO_STORAGE_KEYS: Omit<TableViewStorageKeys, "authSettled"> = {
  fallbackStorageKeys: NO_FALLBACK_STORAGE_KEYS,
  restoreStorageKey: null,
  storageKey: null,
};

function hasStorageIdentity(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function userScopedTableViewStorageKey(
  baseStorageKey: string,
  userId: string
): string {
  return `${baseStorageKey}:u:${userId}`;
}
