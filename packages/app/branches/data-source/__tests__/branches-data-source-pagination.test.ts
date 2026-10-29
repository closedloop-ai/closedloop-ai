import {
  type BranchAnalytics,
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchListCohortScope,
  branchListCohortKey,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_INVALID_PAGE_RESPONSE_CODE,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { ReadSource } from "@repo/api/src/types/read-source";
import { TABLE_PAGE_SIZE_OPTIONS } from "@repo/design-system/components/ui/table-page-size-select";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { createHttpBranchesDataSource } from "../branches-data-source";
import { makeBranchRow } from "./branch-row-test-fixture";

describe("HTTP Branches list pagination", () => {
  it("preserves equal full-cohort metadata without summing page copies", async () => {
    const filters = { repo: "acme/web" };
    const requestedPaths: string[] = [];
    const cohort = completeBranchLastActiveCohort({
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: branchListCohortKey({ repo: ["acme/web"] }),
      evaluationNow: new Date("2026-08-18T12:00:00.000Z"),
      total: 101,
      retainedUnavailable: 1,
    });
    function get<T>(path: string): Promise<T> {
      requestedPaths.push(path);
      const offset = getOffset(path);
      return Promise.resolve({
        ...makePage(offset, 101),
        lastActiveCohort: cohort,
      } as T);
    }
    const api = { get };

    const result = await createHttpBranchesDataSource(api).list(filters);

    expect(result.lastActiveCohort).toEqual(cohort);
    expect(result.lastActiveCohort?.retainedUnavailable.value).toBe(1);
    // ISS-10350: continuation pages carry no echoed producer instant. Every
    // page is the same request the reader's filters describe.
    expect(
      requestedPaths.every((path) => !path.includes("evaluationNow="))
    ).toBe(true);
  });

  it("omits conflicting page metadata instead of fabricating completeness", async () => {
    const filters = { owner: "alice" };
    const cohort = completeBranchLastActiveCohort({
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: branchListCohortKey(filters),
      evaluationNow: new Date("2026-08-18T12:00:00.000Z"),
      total: 101,
      retainedUnavailable: 1,
    });
    function get<T>(path: string): Promise<T> {
      const offset = getOffset(path);
      const pageCohort =
        offset === 0
          ? cohort
          : { ...cohort, evaluationNow: "2026-08-18T12:00:01.000Z" };
      return Promise.resolve({
        ...makePage(offset, 101),
        lastActiveCohort: pageCohort,
      } as T);
    }
    const api = { get };

    const result = await createHttpBranchesDataSource(api).list(filters);

    expect(result.lastActiveCohort).toBeUndefined();
  });

  it("uses one bounded request when the producer returns the v1 capability", async () => {
    const response = serverPage();
    const api = { get: vi.fn().mockResolvedValue(response) };

    await expect(
      createHttpBranchesDataSource(api).list(serverQuery())
    ).resolves.toEqual({ ...response, readSource: ReadSource.Cloud });

    expect(api.get).toHaveBeenCalledOnce();
    expect(api.get.mock.calls[0]?.[0]).toContain("limit=20");
    expect(api.get.mock.calls[0]?.[0]).toContain("offset=40");
    expect(api.get.mock.calls[0]?.[0]).toContain("pageMode=server");
  });

  it("keeps a v1 page whose nested objects carry additive producer fields (ISS-8884)", async () => {
    const base = serverPage();
    const facets = base.facets;
    if (!facets) {
      throw new Error("fixture must carry facets");
    }
    const skewed = {
      ...base,
      pageInfo: { ...base.pageInfo, generatedBy: "newer-producer" },
      facets: {
        ...facets,
        phases: facets.names,
        names: {
          ...facets.names,
          note: "additive",
          options: [{ id: "a", label: "A", count: 1, description: "x" }],
        },
      },
    };
    const api = { get: vi.fn().mockResolvedValue(skewed) };

    await expect(
      createHttpBranchesDataSource(api).list(serverQuery())
    ).resolves.toMatchObject({
      items: skewed.items,
      readSource: ReadSource.Cloud,
    });
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("keeps analytics full-filtered while removing list limit and offset", async () => {
    vi.useFakeTimers();
    try {
      const paths: string[] = [];
      function get<T>(path: string): Promise<T> {
        paths.push(path);
        return Promise.resolve(
          (path.startsWith("/branches?") ? serverPage() : {}) as T
        );
      }
      const api = { get };

      const result = createHttpBranchesDataSource(api).pageData({
        ...serverQuery(),
        names: ["feature/x"],
      });

      await vi.advanceTimersByTimeAsync(0);
      await result;

      expect(paths).toHaveLength(2);
      expect(paths[0]).toContain("limit=20");
      expect(paths[0]).toContain("offset=40");
      expect(paths[0]).not.toContain("evaluationNow=");
      expect(paths[1]).toContain("/branches/analytics?");
      expect(paths[1]).toContain("names=feature%2Fx");
      expect(paths[1]).not.toContain("evaluationNow=");
      expect(paths[1]).not.toContain("limit=");
      expect(paths[1]).not.toContain("offset=");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses staged analytics when the server-page list fails before dispatch", async () => {
    vi.useFakeTimers();
    try {
      const paths: string[] = [];
      function get<T>(path: string): Promise<T> {
        paths.push(path);
        if (path.startsWith("/branches/analytics")) {
          return Promise.resolve({ activeBranches: 1 } as T);
        }
        return Promise.reject(new Error("list read failed"));
      }
      const api = { get };

      const pageDataPromise = createHttpBranchesDataSource(api).pageData(
        serverQuery()
      );

      await expect(pageDataPromise).rejects.toThrow("list read failed");
      await vi.advanceTimersByTimeAsync(0);

      expect(paths).toEqual([expect.stringContaining("/branches?")]);
      expect(paths.some((path) => path.startsWith("/branches/analytics"))).toBe(
        false
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses staged analytics when a legacy fallback replaces the server page", async () => {
    vi.useFakeTimers();
    try {
      const paths: string[] = [];
      function get<T>(path: string): Promise<T> {
        paths.push(path);
        if (path.startsWith("/branches/analytics")) {
          return Promise.resolve({ activeBranches: 1 } as T);
        }
        if (path.includes("pageMode=server")) {
          return Promise.resolve(makePage(0, 1) as T);
        }
        return Promise.resolve(makePage(getOffset(path), 1) as T);
      }
      const api = { get };

      const result = await createHttpBranchesDataSource(api).pageData(
        serverQuery()
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(result.analytics).toEqual({ activeBranches: 1 });
      const analyticsPaths = paths.filter((path) =>
        path.startsWith("/branches/analytics")
      );
      expect(analyticsPaths).toHaveLength(1);
      expect(analyticsPaths[0]).not.toContain("pageMode=server");
      expect(analyticsPaths[0]).not.toContain("evaluationNow=");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the filtered server page when retrying a legacy analytics parser rejection", async () => {
    vi.useFakeTimers();
    try {
      const paths: string[] = [];
      const legacyAnalytics = {
        activeBranches: 1,
      } as unknown as BranchAnalytics;
      // Offset repaired to 0 alongside `total: 1`: the producer's own
      // `repairOffset` can never leave a one-row cohort on page three, and
      // ISS-9668 made that self-inconsistency a validation failure. The
      // expectation under test — the filtered page survives the analytics
      // retry — is unchanged.
      const basePage = serverPage();
      const filteredPage = {
        ...basePage,
        items: [makeBranchRow("selected-owner-branch")],
        total: 1,
        hasMore: false,
        pageInfo: basePage.pageInfo && {
          ...basePage.pageInfo,
          offset: 0,
          requestedOffset: 0,
        },
      };
      function get<T>(path: string): Promise<T> {
        paths.push(path);
        if (
          path.startsWith("/branches/analytics?") &&
          !path.includes("limit=20")
        ) {
          return Promise.reject(
            new ApiError(
              "server pages require limit=20 and an aligned offset",
              400
            )
          );
        }
        if (path.startsWith("/branches/analytics?")) {
          return Promise.resolve(legacyAnalytics as T);
        }
        if (path.startsWith("/branches?") && path.includes("pageMode=server")) {
          return Promise.resolve(filteredPage as T);
        }
        return Promise.resolve(makePage(getOffset(path), 1) as T);
      }
      const api = { get };

      const pageDataPromise = createHttpBranchesDataSource(api).pageData({
        ...serverQuery(),
        owners: ["closedloop:user-1"],
        forceRefresh: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await pageDataPromise;

      expect(result.analytics).toBe(legacyAnalytics);
      expect(result.analyticsError).toBeUndefined();
      expect(result.list.total).toBe(1);
      expect(result.list.items.map((row) => row.id)).toEqual([
        "selected-owner-branch",
      ]);
      expect(result.list.items.map((row) => row.id)).not.toContain("branch-0");
      expect(paths[1]).toContain("/branches/analytics?");
      expect(paths[1]).toContain("owners=closedloop%3Auser-1");
      expect(paths[1]).toContain("pageMode=server");
      expect(paths[1]).not.toContain("limit=");
      expect(paths[1]).not.toContain("offset=");
      expect(paths[1]).not.toContain("forceRefresh=");
      expect(paths[2]).toContain("/branches/analytics?");
      expect(paths[2]).toContain("owners=closedloop%3Auser-1");
      expect(paths[2]).toContain("pageMode=server");
      expect(paths[2]).toContain("limit=20");
      expect(paths[2]).toContain("offset=0");
      expect(paths[2]).not.toContain("forceRefresh=");
      expect(
        paths.filter((path) => path.startsWith("/branches?"))
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries split analytics through the legacy server-page shape", async () => {
    const paths: string[] = [];
    const legacyAnalytics = { activeBranches: 1 } as unknown as BranchAnalytics;
    function get<T>(path: string): Promise<T> {
      paths.push(path);
      if (
        path.startsWith("/branches/analytics?") &&
        !path.includes("limit=20")
      ) {
        return Promise.reject(
          new ApiError(
            "server pages require limit=20 and an aligned offset",
            400
          )
        );
      }
      return Promise.resolve(legacyAnalytics as T);
    }
    const api = { get };
    const { limit: _limit, offset: _offset, ...analyticsQuery } = serverQuery();

    const result = await createHttpBranchesDataSource(api).analytics({
      ...analyticsQuery,
      owners: ["closedloop:user-1"],
    });

    expect(result).toBe(legacyAnalytics);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("owners=closedloop%3Auser-1");
    expect(paths[0]).toContain("pageMode=server");
    expect(paths[0]).not.toContain("evaluationNow=");
    expect(paths[0]).not.toContain("limit=");
    expect(paths[0]).not.toContain("offset=");
    expect(paths[1]).toContain("owners=closedloop%3Auser-1");
    expect(paths[1]).toContain("pageMode=server");
    expect(paths[1]).toContain("limit=20");
    expect(paths[1]).toContain("offset=0");
  });

  it("refetches the complete legacy corpus only when capability metadata is absent", async () => {
    const startedOffsets: number[] = [];
    function get<T>(path: string): Promise<T> {
      const offset = getOffset(path);
      startedOffsets.push(offset);
      if (path.includes("pageMode=server")) {
        return Promise.resolve(makePage(40, 201) as T);
      }
      return Promise.resolve(makePage(offset, 201) as T);
    }
    const api = { get };

    const result = await createHttpBranchesDataSource(api).list(serverQuery());

    expect(result.items).toHaveLength(201);
    expect(startedOffsets).toEqual([40, 0, 100, 200]);
  });

  it.each([
    { name: "null facets", override: { facets: null } },
    {
      name: "partial page info",
      override: {
        pageInfo: { capability: BranchListCapability.ServerPaginationV1 },
      },
    },
    {
      name: "invalid optional map",
      override: { sessionBranchCount: { broken: 0 } },
    },
  ])(
    "rejects a capability-bearing response with $name",
    async ({ override }) => {
      const api = {
        get: vi.fn().mockResolvedValue({ ...serverPage(), ...override }),
      };

      await expect(
        createHttpBranchesDataSource(api).list(serverQuery())
      ).rejects.toMatchObject({
        status: 502,
        code: BRANCH_LIST_INVALID_PAGE_RESPONSE_CODE,
      });
      expect(api.get).toHaveBeenCalledOnce();
    }
  );

  it("falls back only for the exact old-schema pageMode rejection", async () => {
    const legacyApi = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new ApiError("Unrecognized key: pageMode", 400))
        .mockResolvedValueOnce(makePage(0, 1)),
    };
    await expect(
      createHttpBranchesDataSource(legacyApi).list(serverQuery())
    ).resolves.toMatchObject({ total: 1 });

    const unrelated = new ApiError("Invalid owner", 400);
    const invalidApi = { get: vi.fn().mockRejectedValue(unrelated) };
    await expect(
      createHttpBranchesDataSource(invalidApi).list(serverQuery())
    ).rejects.toBe(unrelated);
  });

  it("falls back for an old API rejecting a v2 server page size", async () => {
    const pageSize = TABLE_PAGE_SIZE_OPTIONS[0];
    const paths: string[] = [];
    function get<T>(path: string): Promise<T> {
      paths.push(path);
      if (path.includes("pageMode=server") && path.includes("limit=25")) {
        return Promise.reject(
          new ApiError(
            "server pages require limit=20 and an aligned offset",
            400
          )
        );
      }
      return Promise.resolve(makePage(0, 1) as T);
    }
    const legacyApi = { get };

    await expect(
      createHttpBranchesDataSource(legacyApi).list({
        ...serverQuery(),
        limit: pageSize,
        offset: pageSize,
      })
    ).resolves.toMatchObject({ total: 1 });

    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("pageMode=server");
    expect(paths[0]).toContain("limit=25");
    expect(paths[1]).not.toContain("pageMode=server");
    expect(paths[1]).toContain("limit=100");
    expect(paths[1]).toContain("offset=0");
  });

  it("falls back to legacy page data when an old API rejects a v2 server page size", async () => {
    const pageSize = TABLE_PAGE_SIZE_OPTIONS[0];
    const paths: string[] = [];
    const legacyAnalytics = { activeBranches: 1 } as unknown as BranchAnalytics;
    function get<T>(path: string): Promise<T> {
      paths.push(path);
      if (path.includes("pageMode=server") && path.includes("limit=25")) {
        return Promise.reject(
          new ApiError(
            "server pages require limit=20 and an aligned offset",
            400
          )
        );
      }
      if (path.startsWith("/branches/analytics")) {
        return Promise.resolve(legacyAnalytics as T);
      }
      return Promise.resolve(makePage(0, 1) as T);
    }
    const api = { get };

    const result = await createHttpBranchesDataSource(api).pageData({
      ...serverQuery(),
      limit: pageSize,
      offset: pageSize,
    });

    expect(result.analytics).toBe(legacyAnalytics);
    expect(result.list.total).toBe(1);
    expect(paths[0]).toContain("pageMode=server");
    expect(paths[0]).toContain("limit=25");
    expect(paths[1]).not.toContain("pageMode=server");
    expect(paths[1]).toContain("limit=100");
    expect(paths[1]).toContain("offset=0");
  });

  it("bounds remaining-page concurrency and folds out-of-order responses by offset", async () => {
    const pendingPages = new Map<number, Deferred<BranchListResponse>>();
    const fourPagesStarted = createDeferred<void>();
    const fivePagesStarted = createDeferred<void>();
    const sixPagesStarted = createDeferred<void>();
    const startedOffsets: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const observedWork = vi.fn();
    async function get<T>(path: string): Promise<T> {
      const offset = getOffset(path);
      startedOffsets.push(offset);
      if (offset === 0) {
        return makePage(0, 601) as T;
      }

      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const pendingPage = createDeferred<BranchListResponse>();
      pendingPages.set(offset, pendingPage);
      if (startedOffsets.length === 5) {
        fourPagesStarted.resolve(undefined);
      }
      if (startedOffsets.length === 6) {
        fivePagesStarted.resolve(undefined);
      }
      if (startedOffsets.length === 7) {
        sixPagesStarted.resolve(undefined);
      }

      try {
        return (await pendingPage.promise) as T;
      } finally {
        inFlight -= 1;
      }
    }
    const api = { get };

    const listPromise = createHttpBranchesDataSource(api, {
      observeBranchListWork: observedWork,
    }).list({ owner: "alice" });

    expect(startedOffsets).toEqual([0]);
    await fourPagesStarted.promise;
    expect(startedOffsets).toEqual([0, 100, 200, 300, 400]);
    expect(maxInFlight).toBe(4);

    pendingPages.get(400)?.resolve(makePage(400, 601));
    await fivePagesStarted.promise;
    expect(startedOffsets).toEqual([0, 100, 200, 300, 400, 500]);

    pendingPages.get(500)?.resolve(makePage(500, 601));
    await sixPagesStarted.promise;
    pendingPages.get(600)?.resolve({ ...makePage(600, 601), total: 999 });
    pendingPages.get(300)?.resolve(makePage(300, 601, false));
    pendingPages.get(200)?.resolve(makePage(200, 601));
    pendingPages.get(100)?.resolve(makePage(100, 601));

    const result = await listPromise;
    expect(result).toMatchObject({
      total: 601,
      hasMore: false,
      sessionCostUsd: {
        "session-0": 0,
        shared: 100,
        "session-100": 100,
        "session-200": 200,
        "session-300": 300,
        "session-400": 400,
        "session-500": 500,
        "session-600": 600,
      },
    });
    expect(result.items).toHaveLength(601);
    for (const offset of [0, 100, 200, 300, 400, 500, 600]) {
      expect(result.items[offset]).toEqual(makeBranchRow(`branch-${offset}`));
    }
    expect(result.lifetimeSessionCostUsd).toBeUndefined();
    expect(result.sessionBranchCount).toBeUndefined();
    expect(maxInFlight).toBe(4);
    expect(observedWork).toHaveBeenCalledWith({
      peakRequestConcurrency: 4,
      requestCount: 7,
      rowCount: 601,
    });
  });

  it("rejects a page-one failure without starting remaining requests", async () => {
    const error = new Error("first page failed");
    const api = { get: vi.fn().mockRejectedValue(error) };

    await expect(
      createHttpBranchesDataSource(api).list({ owner: "alice" })
    ).rejects.toBe(error);
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledWith(
      "/branches?owner=alice&limit=100&offset=0"
    );
  });

  it("rejects the complete list when a remaining page fails", async () => {
    const error = new Error("remaining page failed");
    const pendingPages = new Map<number, Deferred<BranchListResponse>>();
    const remainingPagesStarted = createDeferred<void>();
    function get<T>(path: string): Promise<T> {
      const offset = getOffset(path);
      if (offset === 0) {
        return Promise.resolve(makePage(0, 201) as T);
      }
      const pendingPage = createDeferred<BranchListResponse>();
      pendingPages.set(offset, pendingPage);
      if (pendingPages.size === 2) {
        remainingPagesStarted.resolve(undefined);
      }
      return pendingPage.promise as Promise<T>;
    }
    const api = { get };

    const listPromise = createHttpBranchesDataSource(api).list({});
    await remainingPagesStarted.promise;
    pendingPages.get(100)?.reject(error);
    pendingPages.get(200)?.resolve(makePage(200, 201));
    await expect(listPromise).rejects.toBe(error);
  });

  it.each([-1, 0.5, Number.POSITIVE_INFINITY])(
    "fails closed when page one reports invalid total %s",
    async (total) => {
      const api = {
        get: vi.fn().mockResolvedValue({
          ...makePage(0, 0),
          total,
        }),
      };

      await expect(createHttpBranchesDataSource(api).list({})).rejects.toThrow(
        "Branches list returned an invalid total"
      );
      expect(api.get).toHaveBeenCalledOnce();
    }
  );

  it.each([
    {
      name: "hasMore is false",
      page: { ...makePage(0, 201), hasMore: false },
    },
    {
      name: "page one is empty",
      page: { ...makePage(0, 201), items: [], hasMore: true },
    },
  ])("rejects an incomplete first page when $name", async ({ page }) => {
    const api = { get: vi.fn().mockResolvedValue(page) };

    await expect(createHttpBranchesDataSource(api).list({})).rejects.toThrow(
      "Branches list pagination metadata is inconsistent"
    );
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("accepts a complete first page without continuation metadata", async () => {
    const page = { ...makePage(0, 17), hasMore: undefined };
    const api = { get: vi.fn().mockResolvedValue(page) };

    await expect(
      createHttpBranchesDataSource(api).list({})
    ).resolves.toMatchObject({
      items: page.items,
      total: 17,
      hasMore: false,
    });
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("continues a complete-cohort read beyond the Desktop snapshot limit", async () => {
    const total = 20_001;
    const startedOffsets: number[] = [];
    function get<T>(path: string): Promise<T> {
      const offset = getOffset(path);
      startedOffsets.push(offset);
      return Promise.resolve(makePage(offset, total) as T);
    }
    const api = { get };

    const result = await createHttpBranchesDataSource(api).list({});

    expect(result.items).toHaveLength(total);
    expect(startedOffsets).toHaveLength(201);
    expect(startedOffsets.at(-1)).toBe(20_000);
  });

  it.each([
    {
      name: "page one is shorter than the requested page size",
      firstPage: { ...makePage(0, 201), items: [makeBranchRow("short")] },
    },
    {
      name: "a remaining page terminates before the discovered total",
      firstPage: makePage(0, 201),
      remainingPage: { ...makePage(100, 201), hasMore: false },
    },
  ])("fails closed when $name", async ({ firstPage, remainingPage }) => {
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(remainingPage)
        .mockResolvedValueOnce(makePage(200, 201)),
    };

    await expect(createHttpBranchesDataSource(api).list({})).rejects.toThrow(
      "Branches list pagination metadata is inconsistent"
    );
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function getOffset(path: string): number {
  return Number(
    new URL(path, "https://closedloop.test").searchParams.get("offset")
  );
}

function makePage(
  offset: number,
  total: number,
  includeNewMaps = true
): BranchListResponse {
  return {
    items: Array.from(
      {
        length: Math.min(100, Math.max(0, total - offset)),
      },
      (_, index) => makeBranchRow(`branch-${offset + index}`)
    ),
    total,
    viewerScope: BranchViewerScope.Organization,
    hasMore: offset + 100 < total,
    sessionCostUsd: {
      ...(offset === 0 ? {} : { shared: offset }),
      [`session-${offset}`]: offset,
    },
    ...(includeNewMaps
      ? {
          lifetimeSessionCostUsd: { [`session-${offset}`]: offset * 10 },
          sessionBranchCount: { [`session-${offset}`]: 1 },
        }
      : {}),
  };
}

function serverQuery() {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 40,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
  };
}

function serverPage(): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    ...makePage(40, 47),
    items: Array.from({ length: 7 }, (_, index) =>
      makeBranchRow(`branch-${40 + index}`)
    ),
    hasMore: false,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 40,
      requestedOffset: 40,
      now: "2026-08-18T18:00:00.000Z",
    },
    facets: {
      names: emptyFacet,
      owners: emptyFacet,
      collaborators: emptyFacet,
      statuses: emptyFacet,
      pullRequests: emptyFacet,
      lastActiveRanges: emptyFacet,
      repositories: emptyFacet,
      tags: emptyFacet,
    },
  };
}
