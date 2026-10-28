import { DOCUMENT_COST_BATCH_SIZE } from "@repo/api/src/types/document-costs";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  summarizeDocumentCosts,
  useDocumentsCosts,
} from "../use-documents-costs";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mocks,
}));
const artifactId = "00000000-0000-4000-8000-000000000001";

beforeEach(() => vi.clearAllMocks());

describe("document cost read", () => {
  it("batches the entire population serially without truncation or duplicate IDs", async () => {
    const ids = Array.from(
      { length: DOCUMENT_COST_BATCH_SIZE + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    );
    let active = 0;
    let peak = 0;
    mocks.post.mockImplementation(
      async (_path: string, body: { artifactIds: string[] }) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return {
          sessionCosts: body.artifactIds.map((sessionId) => ({
            sessionId,
            totalEstimatedCost: 1,
          })),
          artifacts: body.artifactIds.map((id) => ({
            artifactId: id,
            totalEstimatedCost: 1,
          })),
        };
      }
    );
    const { result } = renderHook(
      () => useDocumentsCosts([...ids, ids[0]], {}),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(result.current.data?.artifacts).toHaveLength(ids.length);
    expect(result.current.data?.totalEstimatedCost).toBe(ids.length);
    expect(result.current.data?.medianEstimatedCost).toBe(1);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "5"])(
    "rejects malformed cost %s at the wire boundary",
    async (cost) => {
      mocks.post.mockResolvedValue({
        artifacts: [{ artifactId, totalEstimatedCost: cost }],
      });
      const { result } = renderHook(() => useDocumentsCosts([artifactId], {}), {
        wrapper: createWrapperWithClient(createTestQueryClient()),
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
    }
  );
  it("keeps missing or unknown artifacts unavailable", async () => {
    mocks.post.mockResolvedValue({ artifacts: [] });
    const { result } = renderHook(() => useDocumentsCosts([artifactId], {}), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ artifacts: [{ artifactId }] });
  });
  it("makes no request while disabled", () => {
    renderHook(() => useDocumentsCosts([artifactId], {}, { enabled: false }), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not publish partial sum or median when any artifact is unavailable", () => {
    expect(
      summarizeDocumentCosts([
        { artifactId, totalEstimatedCost: 5 },
        { artifactId: "another" },
      ])
    ).toEqual({
      artifacts: [
        { artifactId, totalEstimatedCost: 5 },
        { artifactId: "another" },
      ],
    });
  });
  it("distinguishes real zero from an empty population median", () => {
    expect(
      summarizeDocumentCosts([{ artifactId, totalEstimatedCost: 0 }])
    ).toMatchObject({ totalEstimatedCost: 0, medianEstimatedCost: 0 });
    expect(summarizeDocumentCosts([])).toEqual({
      artifacts: [],
      totalEstimatedCost: 0,
    });
  });
});

it("uses the server summary without downloading the document population", async () => {
  mocks.post.mockResolvedValue({
    artifacts: [],
    totalEstimatedCost: 5,
    medianEstimatedCost: 5,
  });
  const { result } = renderHook(
    () => useDocumentsCosts([], {}, { enabled: true }, {}),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.post).toHaveBeenCalledWith("/documents/costs", {
    artifactIds: [],
    scope: {},
  });
  expect(result.current.data?.totalEstimatedCost).toBe(5);
});
it("deduplicates session contributions across batches", async () => {
  const ids = Array.from(
    { length: DOCUMENT_COST_BATCH_SIZE + 1 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  );
  mocks.post.mockImplementation(async (_path, body) => ({
    artifacts: body.artifactIds.map((artifactId: string) => ({
      artifactId,
      totalEstimatedCost: 5,
    })),
    sessionCosts: [{ sessionId: artifactId, totalEstimatedCost: 5 }],
  }));
  const { result } = renderHook(() => useDocumentsCosts(ids, {}), {
    wrapper: createWrapperWithClient(createTestQueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.totalEstimatedCost).toBe(5);
  expect(result.current.data?.medianEstimatedCost).toBe(5);
});

const trendStart = "2026-09-19T00:00:00.000Z";
const trendEnd = "2026-10-02T12:00:00.000Z";
it("preserves scoped daily trends including unknown cost gaps", async () => {
  const trendlines = {
    startDate: trendStart,
    endDate: trendEnd,
    totalEstimatedCost: [...new Array(13).fill(0), null],
    medianEstimatedCost: [...new Array(13).fill(0), null],
  };
  mocks.post.mockResolvedValue({ artifacts: [], trendlines });
  const { result } = renderHook(
    () => useDocumentsCosts([], {}, { enabled: true }, {}),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.trendlines).toEqual(trendlines);
});

it("batches exact filtered cohorts and deduplicates daily session contributions", async () => {
  const ids = Array.from(
    { length: DOCUMENT_COST_BATCH_SIZE + 1 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  );
  const line = [...new Array(13).fill(0), 5];
  mocks.post.mockImplementation(
    async (_path, body: { scope: { artifactIds: string[] } }) => ({
      artifacts: body.scope.artifactIds.map((id) => ({
        artifactId: id,
        totalEstimatedCost: 5,
        trendline: line,
      })),
      sessionCosts: [
        { sessionId: artifactId, totalEstimatedCost: 5, trendline: line },
      ],
      trendlines: {
        startDate: trendStart,
        endDate: trendEnd,
        totalEstimatedCost: line,
        medianEstimatedCost: line,
      },
    })
  );
  const { result } = renderHook(
    () => useDocumentsCosts([], {}, { enabled: true }, { artifactIds: ids }),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(result.current.data?.totalEstimatedCost).toBe(5);
  expect(result.current.data?.medianEstimatedCost).toBe(5);
  expect(result.current.data?.trendlines?.totalEstimatedCost).toEqual(line);
  expect(result.current.data?.trendlines?.medianEstimatedCost).toEqual(line);
});

it("retains authoritative single-cohort aggregates and trends without optional detail lines", async () => {
  const trendlines = {
    startDate: trendStart,
    endDate: trendEnd,
    totalEstimatedCost: [...new Array(13).fill(0), null],
    medianEstimatedCost: [...new Array(13).fill(0), 1],
  };
  mocks.post.mockResolvedValue({
    artifacts: [],
    totalEstimatedCost: 10,
    medianEstimatedCost: 1,
    trendlines,
  });
  const { result } = renderHook(
    () => useDocumentsCosts([artifactId], {}, { enabled: true }),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(result.current.data).toEqual({
    artifacts: [{ artifactId }],
    totalEstimatedCost: 10,
    medianEstimatedCost: 1,
    trendlines,
  });
});

it("derives totals for an unscoped batch whose response carries only trendlines", async () => {
  const trendlines = {
    startDate: trendStart,
    endDate: trendEnd,
    totalEstimatedCost: [...new Array(13).fill(0), 3],
    medianEstimatedCost: [...new Array(13).fill(0), 3],
  };
  mocks.post.mockResolvedValue({
    sessionCosts: [{ sessionId: artifactId, totalEstimatedCost: 3 }],
    artifacts: [{ artifactId, totalEstimatedCost: 3 }],
    trendlines,
  });
  const { result } = renderHook(() => useDocumentsCosts([artifactId], {}), {
    wrapper: createWrapperWithClient(createTestQueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual({
    artifacts: [{ artifactId, totalEstimatedCost: 3 }],
    totalEstimatedCost: 3,
    medianEstimatedCost: 3,
    trendlines,
  });
});
