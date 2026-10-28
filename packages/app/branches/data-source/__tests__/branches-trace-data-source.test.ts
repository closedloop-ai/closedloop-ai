import { BranchViewerScope } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { createHttpBranchesDataSource } from "../branches-data-source";

describe("createHttpBranchesDataSource trace reads", () => {
  it("falls back to paginated trace reads when complete mode returns malformed metadata", async () => {
    const completeItem = {
      type: "end" as const,
      sessionId: "session-artifact-0",
      text: "complete response item",
    };
    const paginatedItem = { ...completeItem, text: "paginated response item" };
    const traceState = completeTraceState(1);
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: [
            completeItem,
            { type: "future-trace-item", private: "hidden" },
          ],
          hasMore: false,
          traceState,
        })
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: [paginatedItem],
          hasMore: false,
          traceState,
        }),
    };

    const result = await createHttpBranchesDataSource(api).trace("branch-1");

    expect(result).toEqual({ items: [paginatedItem], ...traceState });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace?complete=true"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace?limit=100&offset=0"
    );
  });
  it("continues paginated trace reads when complete mode returns a page", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const secondPageItems = [
      {
        type: "sessionstart" as const,
        sessionId: "session-artifact-100",
        t: "2026-07-03T05:01:00.000Z",
        actor: { name: "Codex", harness: "codex" },
      },
    ];
    const traceState = completeTraceState(101);
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: true,
          traceState,
        })
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: secondPageItems,
          hasMore: false,
          traceState,
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toEqual({
      items: [...firstPageItems, ...secondPageItems],
      ...traceState,
    });
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace?complete=true"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace?limit=100&offset=100"
    );
  });

  it("falls back to paginated trace reads when complete mode is unsupported", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const secondPageItems = [
      {
        type: "sessionstart" as const,
        sessionId: "session-artifact-100",
        t: "2026-07-03T05:01:00.000Z",
        actor: { name: "Codex", harness: "codex" },
      },
    ];
    const traceState = completeTraceState(101);
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new ApiError("unknown query", 400))
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: true,
          traceState,
        })
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: secondPageItems,
          hasMore: false,
          traceState,
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toEqual({
      items: [...firstPageItems, ...secondPageItems],
      ...traceState,
    });
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace?complete=true"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace?limit=100&offset=0"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      3,
      "/branches/branch-1/trace?limit=100&offset=100"
    );
  });

  it("loads a current single-page trace snapshot in one request", async () => {
    const item = {
      type: "end" as const,
      sessionId: "session-artifact-0",
      text: "done",
    };
    const traceState = completeTraceState(1);
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items: [item],
        hasMore: false,
        traceState,
      }),
    };

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1")
    ).resolves.toEqual({ items: [item], ...traceState });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(
      "/branches/branch-1/trace?complete=true"
    );
  });

  it("loads a complete long trace snapshot in one request", async () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const traceState = completeTraceState(101);
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items,
        hasMore: false,
        traceState,
      }),
    };

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1")
    ).resolves.toEqual({ items, ...traceState });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(
      "/branches/branch-1/trace?complete=true"
    );
  });

  it("retains loaded trace items and marks membership and aggregates incomplete after a page failure", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const traceState = completeTraceState(100);
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: true,
          traceState,
        })
        .mockRejectedValueOnce(new Error("trace fetch failed")),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toMatchObject({
      items: firstPageItems,
      qualifyingSessionCount: 100,
      completeness: {
        state: BranchTraceCompletenessState.Incomplete,
        reason: BranchTraceUnavailableReason.PageFailure,
      },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Incomplete,
        reason: BranchTraceUnavailableReason.PageFailure,
      },
    });
  });

  it("falls back to paginated reads after a complete trace server failure", async () => {
    const firstPageItems = [
      {
        type: "sessionstart" as const,
        sessionId: "session-artifact-0",
        t: "2026-07-03T05:00:00.000Z",
        actor: { name: "Codex", harness: "codex" },
      },
    ];
    const traceState = completeTraceState(1);
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new ApiError("server failed", 500))
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: false,
          traceState,
        }),
    };

    const result = await createHttpBranchesDataSource(api).trace("branch-1");

    expect(result).toEqual({ items: firstPageItems, ...traceState });
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace?complete=true"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace?limit=100&offset=0"
    );
  });

  it.each([
    [401, BranchTraceUnavailableReason.Authentication],
    [403, BranchTraceUnavailableReason.Permission],
    [429, BranchTraceUnavailableReason.PageFailure],
  ])(
    "does not fall back from a terminal complete trace %i failure",
    async (status, reason) => {
      const api = {
        get: vi.fn().mockRejectedValue(new ApiError("terminal", status)),
      };

      const result = await createHttpBranchesDataSource(api).trace("branch-1");

      expect(result.items).toEqual([]);
      expect(result.completeness).toEqual({
        state: BranchTraceCompletenessState.Unavailable,
        reason,
      });
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledWith(
        "/branches/branch-1/trace?complete=true"
      );
    }
  );

  it("preserves paginated fallback content and incomplete state after a page failure", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
      type: "sessionstart" as const,
      sessionId: `session-artifact-${index}`,
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    }));
    const traceState = completeTraceState(100);
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new ApiError("unknown query", 400))
        .mockResolvedValueOnce({
          branchId: "branch-1",
          viewerScope: BranchViewerScope.Organization,
          items: firstPageItems,
          hasMore: true,
          traceState,
        })
        .mockRejectedValueOnce(new Error("trace fetch failed")),
    };

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1")
    ).resolves.toMatchObject({
      items: firstPageItems,
      qualifyingSessionCount: 100,
      completeness: {
        state: BranchTraceCompletenessState.Incomplete,
        reason: BranchTraceUnavailableReason.PageFailure,
      },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Incomplete,
        reason: BranchTraceUnavailableReason.PageFailure,
      },
    });
  });

  it("degrades to an empty timeline when the first trace page fails", async () => {
    const api = {
      get: vi.fn().mockRejectedValue(new Error("trace fetch failed")),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.trace("branch-1")).resolves.toMatchObject({
      items: [],
      qualifyingSessionCount: null,
      completeness: {
        state: BranchTraceCompletenessState.Unavailable,
        reason: BranchTraceUnavailableReason.PageFailure,
      },
    });
  });

  it("normalizes a legacy trace page without fabricating complete membership", async () => {
    const item = {
      type: "sessionstart" as const,
      sessionId: "session-1",
      t: "2026-07-03T05:00:00.000Z",
      actor: { name: "Codex", harness: "codex" },
    };
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items: [item],
        hasMore: false,
      }),
    };

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1")
    ).resolves.toMatchObject({
      items: [item],
      qualifyingSessionCount: null,
      completeness: {
        state: BranchTraceCompletenessState.Unavailable,
        reason: BranchTraceUnavailableReason.LegacyResponse,
      },
    });
  });

  it("propagates request cancellation instead of misclassifying it as partial data", async () => {
    const error = new ApiError("cancelled", 0);
    const api = { get: vi.fn().mockRejectedValue(error) };
    const controller = new AbortController();
    controller.abort();

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1", {
        signal: controller.signal,
      })
    ).rejects.toBe(error);
    expect(api.get).toHaveBeenCalledWith(
      "/branches/branch-1/trace?complete=true",
      { signal: controller.signal }
    );
  });

  it("propagates cancellation during paginated fallback", async () => {
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";
    const controller = new AbortController();
    const api = {
      get: vi.fn((path: string) => {
        if (path.endsWith("complete=true")) {
          return Promise.reject(new ApiError("unknown query", 400));
        }
        controller.abort();
        return Promise.reject(abortError);
      }),
    };

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1", {
        signal: controller.signal,
      })
    ).rejects.toBe(abortError);
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches/branch-1/trace?complete=true",
      { signal: controller.signal }
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches/branch-1/trace?limit=100&offset=0",
      { signal: controller.signal }
    );
  });

  it.each([
    ["branchId", "branch-2"],
    ["viewerScope", BranchViewerScope.Self],
  ])(
    "rejects a later page with inconsistent %s before admitting its items",
    async (field, value) => {
      const firstItem = {
        type: "end" as const,
        sessionId: "session-artifact-0",
        text: "first",
      };
      const rejectedItem = { ...firstItem, text: "rejected" };
      const traceState = completeTraceState(1);
      const secondPage = {
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items: [rejectedItem],
        hasMore: false,
        traceState,
        [field]: value,
      };
      const api = {
        get: vi
          .fn()
          .mockResolvedValueOnce({
            branchId: "branch-1",
            viewerScope: BranchViewerScope.Organization,
            items: [firstItem],
            hasMore: true,
            traceState,
          })
          .mockResolvedValueOnce(secondPage),
      };

      const result = await createHttpBranchesDataSource(api).trace("branch-1");

      expect(result.items).toEqual([firstItem]);
      expect(result.completeness.reason).toBe(
        BranchTraceUnavailableReason.Malformed
      );
    }
  );

  it("rejects trace items outside the loaded Session identity set", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items: [{ type: "end", sessionId: "foreign", text: "rejected" }],
        hasMore: false,
        traceState: completeTraceState(1),
      }),
    };

    const result = await createHttpBranchesDataSource(api).trace("branch-1");

    expect(result.items).toEqual([]);
    expect(result.completeness.reason).toBe(
      BranchTraceUnavailableReason.Malformed
    );
  });

  it("retains valid loaded items from a page containing a malformed peer", async () => {
    const validItem = {
      type: "end" as const,
      sessionId: "session-artifact-0",
      text: "done",
    };
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items: [validItem, { type: "future-trace-item", private: "hidden" }],
        hasMore: false,
        traceState: completeTraceState(1),
      }),
    };

    const result = await createHttpBranchesDataSource(api).trace("branch-1");

    expect(result.items).toEqual([validItem]);
    expect(result.completeness).toEqual({
      state: BranchTraceCompletenessState.Incomplete,
      reason: BranchTraceUnavailableReason.Malformed,
    });
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  it.each([
    [401, BranchTraceUnavailableReason.Authentication],
    [403, BranchTraceUnavailableReason.Permission],
  ])(
    "classifies a %i trace page failure without exposing raw details",
    async (status, reason) => {
      const api = {
        get: vi
          .fn()
          .mockRejectedValue(new ApiError("private provider detail", status)),
      };

      const result = await createHttpBranchesDataSource(api).trace("branch-1");

      expect(result.completeness).toEqual({
        state: BranchTraceCompletenessState.Unavailable,
        reason,
      });
      expect(JSON.stringify(result)).not.toContain("private provider detail");
    }
  );

  it("fails a stalled hasMore page closed while retaining prior metadata", async () => {
    const traceState = completeTraceState(1);
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        viewerScope: BranchViewerScope.Organization,
        items: [],
        hasMore: true,
        traceState,
      }),
    };

    await expect(
      createHttpBranchesDataSource(api).trace("branch-1")
    ).resolves.toMatchObject({
      items: [],
      qualifyingSessionCount: 1,
      completeness: {
        state: BranchTraceCompletenessState.Unavailable,
        reason: BranchTraceUnavailableReason.PageFailure,
      },
    });
  });
});

function completeTraceState(count: number): BranchTraceState {
  return {
    sessions: Array.from({ length: count }, (_, index) => ({
      identity: {
        artifactId: `session-artifact-${index}`,
        name: `Session ${index}`,
        slug: `SES-${index}`,
        navigableRef: `SES-${index}`,
      },
      state: BranchTraceSessionHydrationState.Loaded,
    })),
    qualifyingSessionCount: count,
    completeness: { state: BranchTraceCompletenessState.Complete },
    aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
  };
}
