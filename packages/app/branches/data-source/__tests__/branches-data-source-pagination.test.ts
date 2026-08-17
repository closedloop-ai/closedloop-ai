import {
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { describe, expect, it, vi } from "vitest";
import { createHttpBranchesDataSource } from "../branches-data-source";
import { makeBranchRow } from "./branch-row-test-fixture";

describe("HTTP Branches list pagination", () => {
  it("bounds remaining-page concurrency and folds out-of-order responses by offset", async () => {
    const pendingPages = new Map<number, Deferred<BranchListResponse>>();
    const fourPagesStarted = createDeferred<void>();
    const fivePagesStarted = createDeferred<void>();
    const sixPagesStarted = createDeferred<void>();
    const startedOffsets: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
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

    const listPromise = createHttpBranchesDataSource(api).list({
      owner: "alice",
    });

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

  it.each([
    -1,
    0.5,
    Number.POSITIVE_INFINITY,
  ])("fails closed when page one reports invalid total %s", async (total) => {
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
  });

  it.each([
    {
      name: "hasMore is false",
      page: { ...makePage(0, 201), hasMore: false },
    },
    {
      name: "page one is empty",
      page: { ...makePage(0, 201), items: [], hasMore: true },
    },
  ])("does not fan out when $name", async ({ page }) => {
    const api = { get: vi.fn().mockResolvedValue(page) };

    await expect(
      createHttpBranchesDataSource(api).list({})
    ).resolves.toMatchObject({
      items: page.items,
      total: 201,
      hasMore: false,
    });
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("does not eagerly allocate offsets for a huge safe-integer total", async () => {
    const error = new Error("stop huge traversal");
    const startedOffsets: number[] = [];
    function get<T>(path: string): Promise<T> {
      const offset = getOffset(path);
      startedOffsets.push(offset);
      if (offset === 0) {
        return Promise.resolve({
          ...makePage(0, Number.MAX_SAFE_INTEGER),
          hasMore: true,
        } as T);
      }
      return Promise.reject(error);
    }
    const api = {
      get,
    };

    await expect(createHttpBranchesDataSource(api).list({})).rejects.toBe(
      error
    );
    expect(startedOffsets).toEqual([0, 100, 200, 300, 400]);
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
