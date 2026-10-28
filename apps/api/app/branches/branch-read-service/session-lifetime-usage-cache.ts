import type {
  SessionBranchIdentityEvidence,
  SessionUsage,
  SessionUsageDateWindow,
} from "./session-usage-window";

type BranchLifetimeUsage = {
  windowed: Map<string, SessionUsage>;
  lifetime: Map<string, SessionUsage>;
};

type CachedBranchLifetimeUsage = BranchLifetimeUsage & {
  identityEvidence: SessionBranchIdentityEvidence[];
};

type CacheSlot = {
  promise: Promise<CachedBranchLifetimeUsage>;
  settledAt: number | null;
};

type CacheEntry = {
  withIdentity: CacheSlot | undefined;
  withoutIdentity: CacheSlot | undefined;
};

type ReadCachedBranchLifetimeUsageInput = {
  organizationId: string;
  branchIds: readonly string[];
  dateWindow: SessionUsageDateWindow | undefined;
  includeLifecycleEvents: boolean;
  includeSessionPhaseSegments: boolean;
  needsIdentityEvidence: boolean;
  read: (
    identityEvidenceOut: SessionBranchIdentityEvidence[] | undefined
  ) => Promise<BranchLifetimeUsage>;
};

const BRANCH_LIFETIME_USAGE_CACHE_TTL_MS = 5000;
const BRANCH_LIFETIME_USAGE_CACHE_MAX_ENTRIES = 32;
const BRANCH_LIFETIME_USAGE_CACHE_MIN_BRANCHES = 1500;

const lifetimeUsageCache = new Map<string, CacheEntry>();

/** Share identical large Branch lifetime-usage reads across split list/cards. */
export function readCachedBranchLifetimeUsage({
  organizationId,
  branchIds,
  dateWindow,
  includeLifecycleEvents,
  includeSessionPhaseSegments,
  needsIdentityEvidence,
  read,
}: ReadCachedBranchLifetimeUsageInput): Promise<CachedBranchLifetimeUsage> {
  if (
    branchIds.length < BRANCH_LIFETIME_USAGE_CACHE_MIN_BRANCHES ||
    !dateWindow?.cacheScopeKey
  ) {
    return readUncached(read, needsIdentityEvidence);
  }
  const now = Date.now();
  pruneLifetimeUsageCache(now);
  const key = lifetimeUsageCacheKey(
    organizationId,
    branchIds,
    dateWindow,
    includeLifecycleEvents,
    includeSessionPhaseSegments
  );
  const entry = lifetimeUsageCache.get(key);
  const cached = needsIdentityEvidence
    ? entry?.withIdentity
    : (entry?.withIdentity ?? entry?.withoutIdentity);
  if (cached) {
    return cached.promise;
  }
  const slot = createLifetimeUsageCacheSlot(read, needsIdentityEvidence, key);
  const nextEntry = entry ?? {
    withIdentity: undefined,
    withoutIdentity: undefined,
  };
  if (needsIdentityEvidence) {
    nextEntry.withIdentity = slot;
  } else {
    nextEntry.withoutIdentity = slot;
  }
  lifetimeUsageCache.set(key, nextEntry);
  evictOldestLifetimeUsageCacheEntries();
  return slot.promise;
}

export function clearBranchLifetimeUsageCacheForTests(): void {
  lifetimeUsageCache.clear();
}

function readUncached(
  read: ReadCachedBranchLifetimeUsageInput["read"],
  needsIdentityEvidence: boolean
): Promise<CachedBranchLifetimeUsage> {
  const identityEvidence: SessionBranchIdentityEvidence[] = [];
  return read(needsIdentityEvidence ? identityEvidence : undefined).then(
    (result) => ({
      ...result,
      identityEvidence,
    })
  );
}

function createLifetimeUsageCacheSlot(
  read: ReadCachedBranchLifetimeUsageInput["read"],
  needsIdentityEvidence: boolean,
  key: string
): CacheSlot {
  const identityEvidence: SessionBranchIdentityEvidence[] = [];
  const slot: CacheSlot = {
    promise: read(needsIdentityEvidence ? identityEvidence : undefined).then(
      (result) => ({
        ...result,
        identityEvidence,
      })
    ),
    settledAt: null,
  };
  slot.promise.then(
    () => {
      slot.settledAt = Date.now();
    },
    () => {
      deleteLifetimeUsageCacheSlot(key, needsIdentityEvidence);
    }
  );
  return slot;
}

function deleteLifetimeUsageCacheSlot(
  key: string,
  needsIdentityEvidence: boolean
): void {
  const entry = lifetimeUsageCache.get(key);
  if (!entry) {
    return;
  }
  if (needsIdentityEvidence) {
    entry.withIdentity = undefined;
  } else {
    entry.withoutIdentity = undefined;
  }
  if (!(entry.withIdentity || entry.withoutIdentity)) {
    lifetimeUsageCache.delete(key);
  }
}

function pruneLifetimeUsageCache(now: number): void {
  for (const [key, entry] of lifetimeUsageCache) {
    pruneLifetimeUsageCacheSlot(entry, "withIdentity", now);
    pruneLifetimeUsageCacheSlot(entry, "withoutIdentity", now);
    if (!(entry.withIdentity || entry.withoutIdentity)) {
      lifetimeUsageCache.delete(key);
    }
  }
}

function pruneLifetimeUsageCacheSlot(
  entry: CacheEntry,
  field: keyof CacheEntry,
  now: number
): void {
  const slot = entry[field];
  if (
    slot?.settledAt !== null &&
    slot?.settledAt !== undefined &&
    now - slot.settledAt > BRANCH_LIFETIME_USAGE_CACHE_TTL_MS
  ) {
    entry[field] = undefined;
  }
}

function evictOldestLifetimeUsageCacheEntries(): void {
  while (lifetimeUsageCache.size > BRANCH_LIFETIME_USAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = lifetimeUsageCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    lifetimeUsageCache.delete(oldestKey);
  }
}

function lifetimeUsageCacheKey(
  organizationId: string,
  branchIds: readonly string[],
  dateWindow: SessionUsageDateWindow | undefined,
  includeLifecycleEvents: boolean,
  includeSessionPhaseSegments: boolean
): string {
  return [
    organizationId,
    includeLifecycleEvents ? "events" : "no-events",
    includeSessionPhaseSegments ? "segments" : "no-segments",
    dateWindow?.cacheScopeKey ?? "",
    dateWindow?.startDate?.toISOString() ?? "",
    dateWindow?.endDate?.toISOString() ?? "",
    [...new Set(branchIds)].sort().join(","),
  ].join("|");
}
