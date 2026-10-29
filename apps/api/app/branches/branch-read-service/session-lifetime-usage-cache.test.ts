import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearBranchLifetimeUsageCacheForTests,
  readCachedBranchLifetimeUsage,
} from "./session-lifetime-usage-cache";
import type { SessionBranchIdentityEvidence } from "./session-usage-window";

type CacheReadInput = Parameters<typeof readCachedBranchLifetimeUsage>[0];

/**
 * One entry per term of `lifetimeUsageCacheKey`. Each override changes that
 * term and nothing else relative to {@link cacheKeyBaseInput}.
 */
const CACHE_KEY_TERM_VARIANTS: {
  term: string;
  override: Partial<Omit<CacheReadInput, "read">>;
}[] = [
  { term: "organizationId", override: { organizationId: "org-2" } },
  {
    term: "includeLifecycleEvents",
    override: { includeLifecycleEvents: false },
  },
  {
    term: "includeSessionPhaseSegments",
    override: { includeSessionPhaseSegments: false },
  },
  {
    term: "dateWindow.cacheScopeKey",
    override: {
      dateWindow: { ...dateWindow("sample-a"), cacheScopeKey: "sample-b" },
    },
  },
  {
    term: "dateWindow.startDate",
    override: {
      dateWindow: {
        ...dateWindow("sample-a"),
        startDate: new Date("2026-08-16T00:00:00.000Z"),
      },
    },
  },
  {
    term: "dateWindow.endDate",
    override: {
      dateWindow: {
        ...dateWindow("sample-a"),
        endDate: new Date("2026-08-24T23:59:59.999Z"),
      },
    },
  },
  {
    term: "branchIds",
    override: { branchIds: [...largeBranchIds().slice(0, -1), "branch-other"] },
  },
];

describe("readCachedBranchLifetimeUsage", () => {
  afterEach(() => {
    clearBranchLifetimeUsageCacheForTests();
    vi.useRealTimers();
  });

  it("reuses an identity-enriched large read with matching lifecycle shape", async () => {
    const read = vi.fn(
      (identityEvidenceOut: SessionBranchIdentityEvidence[] | undefined) => {
        identityEvidenceOut?.push(identityEvidence());
        return Promise.resolve(emptyUsage());
      }
    );

    const listRead = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-a"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: true,
      read,
    });
    const analyticsRead = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: [...largeBranchIds()].reverse(),
      dateWindow: dateWindow("sample-a"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    await expect(Promise.all([listRead, analyticsRead])).resolves.toEqual([
      { ...emptyUsage(), identityEvidence: [identityEvidence()] },
      { ...emptyUsage(), identityEvidence: [identityEvidence()] },
    ]);
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps identity reads separate from an existing non-identity read", async () => {
    const read = vi.fn(
      (identityEvidenceOut: SessionBranchIdentityEvidence[] | undefined) => {
        identityEvidenceOut?.push(identityEvidence());
        return Promise.resolve(emptyUsage());
      }
    );

    const analyticsRead = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-a"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    const listRead = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-a"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: true,
      read,
    });

    await Promise.all([analyticsRead, listRead]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[0]).toBeUndefined();
    expect(Array.isArray(read.mock.calls[1]?.[0])).toBe(true);
  });

  it("does not cache large reads without a page evaluation scope", async () => {
    const read = vi.fn(() => Promise.resolve(emptyUsage()));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: undefined,
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: undefined,
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(CACHE_KEY_TERM_VARIANTS)(
    "separates cached reads that differ only in $term",
    async ({ override }) => {
      const read = vi.fn(() => Promise.resolve(emptyUsage()));
      const base = cacheKeyBaseInput(read);
      const variant = { ...base, ...override };

      await readCachedBranchLifetimeUsage(base);
      await readCachedBranchLifetimeUsage(variant);
      expect(read).toHaveBeenCalledTimes(2);

      // Replaying both inputs reads nothing new, so each call above was
      // cache-eligible and the second read came from the key term alone.
      await readCachedBranchLifetimeUsage(base);
      await readCachedBranchLifetimeUsage(variant);
      expect(read).toHaveBeenCalledTimes(2);
    }
  );

  it("retries a rejected solo cache slot instead of reusing its dead promise", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(emptyUsage());

    const first = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-solo"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: true,
      read,
    });
    await expect(first).rejects.toThrow("read failed");

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-solo"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: true,
      read,
    });

    // The failed slot must not linger as a cached rejection: a second request
    // for the identical key issues a fresh read rather than reusing it.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected solo non-identity cache slot instead of reusing its dead promise", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(emptyUsage());

    const first = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-solo-no-identity"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    await expect(first).rejects.toThrow("read failed");

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-solo-no-identity"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("clears only the rejected flavor, keeping the other flavor's cache entry for the same key intact", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(emptyUsage())
      .mockRejectedValueOnce(new Error("identity read failed"))
      .mockResolvedValue(emptyUsage());

    const withoutIdentity = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-mixed"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    const withIdentity = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-mixed"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: true,
      read,
    });
    await withoutIdentity;
    await expect(withIdentity).rejects.toThrow("identity read failed");

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-mixed"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    // Only the rejected identity slot needed a retry; the sibling
    // non-identity slot for the SAME key must still be served from cache.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("survives a cache clear that races a pending rejection", async () => {
    let reject: (error: Error) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<never>((_resolve, rej) => {
          reject = rej;
        })
    );

    const pending = readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-reject-cleared"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    // The entry is gone from the cache before the read below rejects, so the
    // rejection handler must not throw trying to mutate a missing entry.
    clearBranchLifetimeUsageCacheForTests();
    reject(new Error("read failed"));

    await expect(pending).rejects.toThrow("read failed");
  });

  it("evicts a settled slot once it has aged past the cache TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const read = vi.fn(() => Promise.resolve(emptyUsage()));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-ttl"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    vi.setSystemTime(new Date("2026-08-20T00:00:05.001Z"));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-ttl"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    // Past the 5s TTL, the settled slot must be pruned and the whole
    // now-empty entry removed rather than reused stale.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a settled slot cached before it has aged past the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
    const read = vi.fn(() => Promise.resolve(emptyUsage()));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-fresh"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    vi.setSystemTime(new Date("2026-08-20T00:00:04.000Z"));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow("sample-fresh"),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest entry once the cache grows past its entry cap", async () => {
    const read = vi.fn(() => Promise.resolve(emptyUsage()));
    const scopeKeys = Array.from(
      { length: 33 },
      (_unused, index) => `sample-cap-${index}`
    );

    for (const scopeKey of scopeKeys) {
      await readCachedBranchLifetimeUsage({
        organizationId: "org-1",
        branchIds: largeBranchIds(),
        dateWindow: dateWindow(scopeKey),
        includeLifecycleEvents: true,
        includeSessionPhaseSegments: true,
        needsIdentityEvidence: false,
        read,
      });
    }
    const callsAfterFill = read.mock.calls.length;

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow(scopeKeys[0] as string),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    // The 33rd insert pushed the cache one over its 32-entry cap, so the
    // FIRST (oldest) scope key must have been evicted and re-read.
    expect(read.mock.calls.length).toBe(callsAfterFill + 1);
    const callsAfterOldestReplay = read.mock.calls.length;

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: dateWindow(scopeKeys.at(-1) as string),
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    // The most recently inserted scope key is still served from cache, so
    // this replay must not trigger another read — asserted separately from
    // the oldest-key replay above so a newest-first (or any non-oldest)
    // eviction order cannot pass by netting the same combined total.
    expect(read.mock.calls.length).toBe(callsAfterOldestReplay);
  });

  it("shares a cache entry across two value-equal windows that both omit the end date", async () => {
    const read = vi.fn(() => Promise.resolve(emptyUsage()));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      // Only pins that two windows omitting endDate collide. That endDate is
      // a key term at all is pinned by the per-term separation cases.
      dateWindow: {
        cacheScopeKey: "sample-start-only",
        startDate: new Date("2026-08-17T00:00:00.000Z"),
      },
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: {
        cacheScopeKey: "sample-start-only",
        startDate: new Date("2026-08-17T00:00:00.000Z"),
      },
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("shares a cache entry across two value-equal windows that both omit the start date", async () => {
    const read = vi.fn(() => Promise.resolve(emptyUsage()));

    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      // Only pins that two windows omitting startDate collide. That startDate
      // is a key term at all is pinned by the per-term separation cases.
      dateWindow: {
        cacheScopeKey: "sample-end-only",
        endDate: new Date("2026-08-23T23:59:59.999Z"),
      },
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });
    await readCachedBranchLifetimeUsage({
      organizationId: "org-1",
      branchIds: largeBranchIds(),
      dateWindow: {
        cacheScopeKey: "sample-end-only",
        endDate: new Date("2026-08-23T23:59:59.999Z"),
      },
      includeLifecycleEvents: true,
      includeSessionPhaseSegments: true,
      needsIdentityEvidence: false,
      read,
    });

    expect(read).toHaveBeenCalledTimes(1);
  });
});

function largeBranchIds(): string[] {
  return Array.from({ length: 1500 }, (_, index) => `branch-${index}`);
}

function emptyUsage() {
  return {
    lifetime: new Map(),
    windowed: new Map(),
  };
}

function dateWindow(cacheScopeKey: string) {
  return {
    cacheScopeKey,
    endDate: new Date("2026-08-23T23:59:59.999Z"),
    startDate: new Date("2026-08-17T00:00:00.000Z"),
  };
}

function identityEvidence() {
  return {
    branchParticipationMethod: "git_push",
    branchParticipationObservedAt: new Date("2026-08-20T12:00:00.000Z"),
    sourceId: "session-1",
    targetId: "branch-1",
    userId: "user-1",
  };
}

function cacheKeyBaseInput(read: CacheReadInput["read"]): CacheReadInput {
  return {
    organizationId: "org-1",
    branchIds: largeBranchIds(),
    dateWindow: dateWindow("sample-a"),
    includeLifecycleEvents: true,
    includeSessionPhaseSegments: true,
    needsIdentityEvidence: false,
    read,
  };
}
