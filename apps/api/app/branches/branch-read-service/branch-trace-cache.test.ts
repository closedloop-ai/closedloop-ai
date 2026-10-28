import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBranchTraceCacheForTests,
  readCachedBranchTrace,
} from "./branch-trace-cache";

const trace: BranchTraceResult = {
  items: [],
  sessions: [],
  qualifyingSessionCount: 0,
  completeness: { state: BranchTraceCompletenessState.Complete },
  aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
};

beforeEach(() => clearBranchTraceCacheForTests());
afterEach(() => vi.useRealTimers());

describe("branch trace cache", () => {
  it("separates organizations and expires idle snapshots", async () => {
    vi.useFakeTimers();
    const build = vi.fn().mockResolvedValue(trace);
    await readCachedBranchTrace("org-a", "branch", [], build);
    await readCachedBranchTrace("org-a", "branch", [], build);
    await readCachedBranchTrace("org-b", "branch", [], build);
    expect(build).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001);
    await readCachedBranchTrace("org-a", "branch", [], build);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("evicts old branches instead of accumulating an unbounded population", async () => {
    const build = vi.fn().mockResolvedValue(trace);
    for (let i = 0; i < 33; i += 1) {
      await readCachedBranchTrace("org", `branch-${i}`, [], build);
    }
    await readCachedBranchTrace("org", "branch-32", [], build);
    expect(build).toHaveBeenCalledTimes(33);
    await readCachedBranchTrace("org", "branch-0", [], build);
    expect(build).toHaveBeenCalledTimes(34);
  });

  it("retries incomplete hydration and never retains a rejected build", async () => {
    const sessions = ["s1", "s2"].map((artifactId) => ({
      identity: {
        artifactId,
        name: null,
        slug: null,
        navigableRef: artifactId,
      },
      observedAtMs: 1,
      updatedAt: "unchanged-revision",
    }));
    const recovered: BranchTraceResult = {
      ...trace,
      qualifyingSessionCount: sessions.length,
      sessions: sessions.map(({ identity }) => ({
        identity,
        state: BranchTraceSessionHydrationState.Loaded,
      })),
    };
    const incomplete: BranchTraceResult = {
      ...recovered,
      sessions: [
        recovered.sessions[0],
        {
          identity: sessions[1].identity,
          state: BranchTraceSessionHydrationState.Unavailable,
          reason: BranchTraceUnavailableReason.PageFailure,
        },
      ],
      completeness: { state: BranchTraceCompletenessState.Incomplete },
      aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
    };
    const build = vi
      .fn()
      .mockResolvedValueOnce(incomplete)
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(recovered);
    const first = await readCachedBranchTrace("org", "branch", sessions, build);
    expect(first.trace).toEqual(incomplete);
    await expect(
      readCachedBranchTrace("org", "branch", sessions, build)
    ).rejects.toThrow("read failed");
    await readCachedBranchTrace("org", "branch", sessions, build);
    const last = await readCachedBranchTrace("org", "branch", sessions, build);
    expect(last.trace).toEqual(recovered);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it.each(["truncated", "unreadable"])(
    "caches stable %s evidence without changing completeness",
    async (kind) => {
      const partial: BranchTraceResult = {
        ...trace,
        qualifyingSessionCount: 1,
        sessions: [
          {
            identity: {
              artifactId: "s1",
              name: "Session",
              slug: null,
              navigableRef: "s1",
            },
            state: BranchTraceSessionHydrationState.Loaded,
            ...(kind === "unreadable" ? { unreadableItemCount: 1 } : {}),
          },
        ],
        completeness: {
          state: BranchTraceCompletenessState.Incomplete,
          ...(kind === "truncated" ? { eventsTruncated: true } : {}),
        },
        aggregateCompleteness: {
          state: BranchTraceCompletenessState.Incomplete,
        },
      };
      const build = vi.fn().mockResolvedValue(partial);
      await readCachedBranchTrace("org", "branch", [], build);
      const next = await readCachedBranchTrace("org", "branch", [], build);
      expect(build).toHaveBeenCalledOnce();
      expect(next.trace).toEqual(partial);
    }
  );

  it("retains cursor identity across eviction when source content has not changed", async () => {
    const build = vi.fn().mockResolvedValue(trace);
    const first = await readCachedBranchTrace("org", "branch", [], build);
    clearBranchTraceCacheForTests();
    const second = await readCachedBranchTrace("org", "branch", [], build);
    expect(second.version).toBe(first.version);
  });
});
