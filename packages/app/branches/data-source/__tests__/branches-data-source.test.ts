import {
  BranchCommentsState,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { ReadSource } from "@repo/api/src/types/read-source";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { createHttpBranchesDataSource } from "../branches-data-source";
import { makeBranchRow, makeBranchRows } from "./branch-row-test-fixture";

describe("createHttpBranchesDataSource", () => {
  it("loads every paginated branch list page when no explicit pagination is requested", async () => {
    const firstPageItems = Array.from({ length: 100 }, (_, index) =>
      makeBranchRow(`branch-${index}`)
    );
    const secondPageItems = [makeBranchRow("branch-101")];
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: firstPageItems,
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          items: secondPageItems,
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({ owner: "alice" })).resolves.toMatchObject({
      items: [...firstPageItems, ...secondPageItems],
      total: 101,
      viewerScope: BranchViewerScope.Organization,
      hasMore: false,
    });
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/branches?owner=alice&limit=100&offset=0"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/branches?owner=alice&limit=100&offset=100"
    );
  });

  it("falls back across legacy pages while preserving repeated completeness metadata", async () => {
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
      "/branches/branch-1/trace?limit=100&offset=0"
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
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
      "/branches/branch-1/trace?limit=100&offset=0",
      { signal: controller.signal }
    );
  });

  it.each([
    ["branchId", "branch-2"],
    ["viewerScope", BranchViewerScope.Self],
  ])("rejects a later page with inconsistent %s before admitting its items", async (field, value) => {
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
  });

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
  ])("classifies a %i trace page failure without exposing raw details", async (status, reason) => {
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
  });

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

  it("serializes canonical shared filters into repeated REST query params", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await dataSource.list({
      limit: 25,
      offset: 50,
      owner: "alice",
      repo: "closedloop-ai/symphony-alpha",
      search: "branches",
      startDate: "2026-07-01T00:00:00.000Z",
      status: "open",
    });

    expect(api.get).toHaveBeenCalledWith(
      "/branches?limit=25&offset=50&owner=alice&repo=closedloop-ai%2Fsymphony-alpha&search=branches&startDate=2026-07-01T00%3A00%3A00.000Z&status=open"
    );
  });

  it("loads branch comments from the Branches-owned comments route", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        branchId: "branch-1",
        state: BranchCommentsState.UnsyncedUnknown,
        comments: [],
        budget: {
          maxComments: 100,
          pageSize: 50,
          maxBodyBytes: 16_384,
          maxResponseBytes: 524_288,
          providerTruncated: false,
          responseTruncated: false,
          omittedComments: 0,
          bodyTruncatedCount: 0,
        },
        providerProofedAt: null,
        stale: false,
        mixedProjection: false,
        prNumber: null,
        prUrl: null,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.comments("branch-1")).resolves.toMatchObject({
      branchId: "branch-1",
      state: BranchCommentsState.UnsyncedUnknown,
    });
    expect(api.get).toHaveBeenCalledWith("/branches/branch-1/comments");
  });

  // FEA-3120: the HTTP source always reads synced cloud state, so it stamps
  // `cloud` at the read boundary — on both the single-page and aggregated paths.
  it("stamps readSource=cloud on an explicitly paginated list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(
      dataSource.list({ limit: 25, offset: 0 })
    ).resolves.toMatchObject({ readSource: ReadSource.Cloud });
  });

  it("stamps readSource=cloud on the aggregated multi-page list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      readSource: ReadSource.Cloud,
    });
  });

  it("preserves an explicit server-provided readSource across the aggregated list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
        readSource: ReadSource.Fallback,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      readSource: ReadSource.Fallback,
    });
  });

  // FEA-3695 — the authoritative per-session cost map is PER PAGE. Merging it
  // across pages must union the entries and never re-add a session seen on an
  // earlier page (a session shared by branches across pages carries the same
  // authoritative cost), so the client's filtered spend re-derivation reads one
  // coherent, deduped map spanning the whole corpus.
  it("merges sessionCostUsd across pages, first-seen wins for a shared session", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: makeBranchRows(100),
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
          sessionCostUsd: { s1: 90, s2: 10 },
        })
        .mockResolvedValueOnce({
          items: [makeBranchRow("branch-2")],
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
          // s1 recurs (shared session, same $90) and must NOT re-add; s3 is new.
          sessionCostUsd: { s1: 90, s3: 5 },
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      sessionCostUsd: { s1: 90, s2: 10, s3: 5 },
    });
  });

  it("omits sessionCostUsd entirely when no page reports it (older producer)", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);
    const result = await dataSource.list({});

    expect(result.sessionCostUsd).toBeUndefined();
  });

  // ISS-4632 — the lifetime cost map is merged across pages identically to the
  // windowed one (first-seen wins), so the client can re-derive a window-stable
  // Value-per-$ ratio over the full corpus.
  it("merges lifetimeSessionCostUsd across pages, first-seen wins for a shared session", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: makeBranchRows(100),
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
          // Windowed (in-window) costs vs lifetime costs differ per session.
          sessionCostUsd: { s1: 9, s2: 1 },
          lifetimeSessionCostUsd: { s1: 90, s2: 10 },
        })
        .mockResolvedValueOnce({
          items: [makeBranchRow("branch-2")],
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
          // s1 recurs (shared session, same lifetime $90) → NOT re-added; s3 new.
          sessionCostUsd: { s1: 9, s3: 1 },
          lifetimeSessionCostUsd: { s1: 90, s3: 5 },
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      sessionCostUsd: { s1: 9, s2: 1, s3: 1 },
      lifetimeSessionCostUsd: { s1: 90, s2: 10, s3: 5 },
    });
  });

  // ISS-4632 (wongk/codex review) — if pagination straddles a deployment, a
  // NEW-shape page carries the lifetime map while an OLD-shape page carries only
  // the windowed one. Publishing the partial merged map would let the client treat
  // it as authoritative and drop the old page's sessions from the Value-per-$
  // denominator. So a windowed-but-no-lifetime page suppresses the WHOLE lifetime
  // map, and the client falls back to the windowed map for the entire set.
  it("suppresses lifetimeSessionCostUsd when a page omits it mid-deploy (partial map)", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: makeBranchRows(100),
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
          // New-shape page: both maps present.
          sessionCostUsd: { s1: 9, s2: 1 },
          lifetimeSessionCostUsd: { s1: 90, s2: 10 },
        })
        .mockResolvedValueOnce({
          items: [makeBranchRow("branch-2")],
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
          // Old-shape page mid-deploy: windowed map present, lifetime map absent.
          sessionCostUsd: { s3: 1 },
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);
    const result = await dataSource.list({});

    // Windowed map still merges every page; lifetime map is fully suppressed so
    // the denominator is never built from a partial (skewed) map.
    expect(result.sessionCostUsd).toEqual({ s1: 9, s2: 1, s3: 1 });
    expect(result.lifetimeSessionCostUsd).toBeUndefined();
  });

  // ISS-4689 — the global even-split divisor merges across pages the same way: a
  // session's global branch count is a property of the SESSION, so a session that
  // recurs on a later page never changes it.
  it("merges sessionBranchCount across pages, first-seen wins for a shared session", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: makeBranchRows(100),
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
          sessionCostUsd: { s1: 9, s2: 1 },
          lifetimeSessionCostUsd: { s1: 90, s2: 10 },
          sessionBranchCount: { s1: 3, s2: 1 },
        })
        .mockResolvedValueOnce({
          items: [makeBranchRow("branch-2")],
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
          sessionCostUsd: { s1: 9, s3: 1 },
          lifetimeSessionCostUsd: { s1: 90, s3: 5 },
          sessionBranchCount: { s1: 3, s3: 2 },
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);

    await expect(dataSource.list({})).resolves.toMatchObject({
      sessionBranchCount: { s1: 3, s2: 1, s3: 2 },
    });
  });

  // ISS-4689 — same all-or-nothing rule as the lifetime cost map: a partial
  // divisor map would divide some sessions by their global count and the rest by
  // their in-set count inside ONE denominator, so an old-shape page suppresses it
  // entirely and the client keeps the consistent pre-fix in-set divisor.
  it("suppresses sessionBranchCount when a page omits it mid-deploy (partial map)", async () => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          items: makeBranchRows(100),
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: true,
          sessionCostUsd: { s1: 9 },
          lifetimeSessionCostUsd: { s1: 90 },
          sessionBranchCount: { s1: 3 },
        })
        .mockResolvedValueOnce({
          items: [makeBranchRow("branch-2")],
          total: 101,
          viewerScope: BranchViewerScope.Organization,
          hasMore: false,
          // Old-shape page mid-deploy: no divisor map.
          sessionCostUsd: { s3: 1 },
          lifetimeSessionCostUsd: { s3: 5 },
        }),
    };

    const dataSource = createHttpBranchesDataSource(api);
    const result = await dataSource.list({});

    expect(result.sessionBranchCount).toBeUndefined();
    // The lifetime map is unaffected — that page carried it.
    expect(result.lifetimeSessionCostUsd).toEqual({ s1: 90, s3: 5 });
  });

  it("omits sessionBranchCount entirely when no page reports it (older server)", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
        sessionCostUsd: { s1: 5 },
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);
    const result = await dataSource.list({});

    expect(result.sessionBranchCount).toBeUndefined();
  });

  it("omits lifetimeSessionCostUsd entirely when no page reports it (older server)", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
        // A page can carry the windowed map without the newer lifetime one.
        sessionCostUsd: { s1: 5 },
      }),
    };

    const dataSource = createHttpBranchesDataSource(api);
    const result = await dataSource.list({});

    expect(result.lifetimeSessionCostUsd).toBeUndefined();
  });

  // FEA-4177 — independent failure domains: an analytics-read failure degrades
  // ONLY the summary half. `pageData` still resolves the list with `analytics`
  // omitted and `analyticsError: true`, instead of rejecting and blanking the
  // branches table.
  it("pageData resolves the list with analyticsError when only the analytics read fails", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/branches/analytics")) {
        return Promise.reject(new Error("analytics read failed"));
      }
      return Promise.resolve({
        items: [makeBranchRow("branch-1")],
        total: 1,
        viewerScope: BranchViewerScope.Organization,
        hasMore: false,
      } as T);
    };

    const dataSource = createHttpBranchesDataSource({ get });
    const result = await dataSource.pageData({ limit: 25, offset: 0 });

    expect(result.list.total).toBe(1);
    expect(result.analytics).toBeUndefined();
    expect(result.analyticsError).toBe(true);
  });

  // FEA-4177 — the list is the required half: its failure still rejects (the
  // table cannot render without rows), even when the analytics read succeeded.
  it("pageData rejects when the list read fails", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/branches/analytics")) {
        return Promise.resolve({} as T);
      }
      return Promise.reject(new Error("list read failed"));
    };

    const dataSource = createHttpBranchesDataSource({ get });

    await expect(dataSource.pageData({ limit: 25, offset: 0 })).rejects.toThrow(
      "list read failed"
    );
  });

  // FEA-4177 wongk review: a list rejection must surface the instant it lands —
  // it must NOT wait for the optional analytics read. If analytics stalls
  // indefinitely, a `Promise.allSettled([list, analytics])` join would hang the
  // whole read; the required list is awaited directly so its rejection propagates
  // immediately.
  it("pageData rejects on a list failure even while the analytics read never settles", async () => {
    const get = <T>(path: string): Promise<T> => {
      if (path.startsWith("/branches/analytics")) {
        // Never settles — simulates a stalled optional read.
        return new Promise<T>(() => {
          /* intentionally pending forever */
        });
      }
      return Promise.reject(new Error("list read failed"));
    };

    const dataSource = createHttpBranchesDataSource({ get });

    await expect(dataSource.pageData({ limit: 25, offset: 0 })).rejects.toThrow(
      "list read failed"
    );
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
