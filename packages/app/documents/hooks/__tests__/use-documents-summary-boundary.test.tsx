import { DocumentType } from "@repo/api/src/types/document";
import {
  DOCUMENT_SUMMARY_ID_BATCH_SIZE,
  DOCUMENT_SUMMARY_WINDOW_DAYS,
} from "@repo/api/src/types/document-list-summary";
import { useDocumentsSummary } from "@repo/app/documents/hooks/use-documents-summary";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8936 — the summary read's own trust boundary (review thread on #8000).
 *
 * The API is deployed independently, so a 2xx body is not a promise about the
 * shape inside it. Without a parse here a missing, non-numeric or non-finite
 * field is cached as settled data and reaches the strip as a measurement — the
 * band states `undefined` or `NaN` in the weight it states a real count in,
 * instead of taking the unavailable arm it already implements.
 *
 * A malformed body must therefore land the query in `isError`, which is the only
 * state the band folds into that arm.
 */
const mocks = vi.hoisted(() => ({ apiClient: { get: vi.fn() } }));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mocks.apiClient,
}));

const SEARCH_PARAMS = {
  type: DocumentType.Doc,
  unassignedProject: true,
} as const;

const SUMMARY = {
  total: 412,
  producedByAgentSessions: 260,
  updatedInWindow: 46,
  neverEdited: 13,
  windowDays: DOCUMENT_SUMMARY_WINDOW_DAYS,
};

function renderSummary() {
  return renderHook(() => useDocumentsSummary(SEARCH_PARAMS), {
    wrapper: createWrapperWithClient(createTestQueryClient()),
  });
}

describe("useDocumentsSummary response validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a well-formed payload unchanged", async () => {
    // The presence half. Every absence asserted below is asserted against the
    // same hook on the same wiring, so none of them can be passing because the
    // read never resolved at all.
    mocks.apiClient.get.mockResolvedValue(SUMMARY);

    const { result } = renderSummary();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(SUMMARY);
  });

  it.each([
    ["a missing count", { ...SUMMARY, neverEdited: undefined }],
    ["a non-numeric count", { ...SUMMARY, total: "412" }],
    ["a non-finite count", { ...SUMMARY, updatedInWindow: Number.NaN }],
    ["a negative count", { ...SUMMARY, producedByAgentSessions: -1 }],
    ["a fractional count", { ...SUMMARY, total: 1.5 }],
    ["a zero window", { ...SUMMARY, windowDays: 0 }],
    ["a body that is not an object at all", null],
  ])(
    "refuses %s rather than caching it as a measurement",
    async (_name, body) => {
      // Kills: replacing the parse with `apiClient.get<DocumentListSummary>`.
      mocks.apiClient.get.mockResolvedValue(body);

      const { result } = renderSummary();

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
    }
  );
});

it("retains additive daily summary trends and rejects malformed bins", async () => {
  const trendlines = {
    startDate: "2026-09-19T00:00:00.000Z",
    endDate: "2026-10-02T12:00:00.000Z",
    total: new Array(14).fill(1),
    producedByAgentSessions: new Array(14).fill(0),
    updatedInWindow: new Array(14).fill(0),
  };
  mocks.apiClient.get.mockResolvedValue({ ...SUMMARY, trendlines });
  const { result } = renderSummary();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.trendlines).toEqual(trendlines);
  mocks.apiClient.get.mockResolvedValue({
    ...SUMMARY,
    trendlines: { ...trendlines, total: [1] },
  });
  const malformed = renderSummary();
  await waitFor(() => expect(malformed.result.current.isError).toBe(true));
});

it("bounds and sums an exact cohort without silently broadening empty selections", async () => {
  const ids = Array.from(
    { length: DOCUMENT_SUMMARY_ID_BATCH_SIZE + 1 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  );
  mocks.apiClient.get.mockImplementation((path: string) => {
    const params = new URL(path, "https://example.test").searchParams;
    const count = params.getAll("artifactIds").filter(Boolean).length;
    return {
      ...SUMMARY,
      appliedArtifactIds: params.getAll("artifactIds").filter(Boolean),
      total: count,
      producedByAgentSessions: count,
      updatedInWindow: count,
      neverEdited: count,
    };
  });
  const { result } = renderHook(
    () => useDocumentsSummary({ artifactIds: ids }),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.total).toBe(DOCUMENT_SUMMARY_ID_BATCH_SIZE + 1);
  expect(mocks.apiClient.get).toHaveBeenCalledTimes(2);
  const empty = renderHook(() => useDocumentsSummary({ artifactIds: [] }), {
    wrapper: createWrapperWithClient(createTestQueryClient()),
  });
  await waitFor(() => expect(empty.result.current.isSuccess).toBe(true));
  expect(empty.result.current.data?.total).toBe(0);
  expect(mocks.apiClient.get.mock.calls.at(-1)?.[0]).toContain("artifactIds=");
});

it("refuses old server summaries that do not acknowledge exact IDs", async () => {
  mocks.apiClient.get.mockResolvedValue(SUMMARY);
  const { result } = renderHook(
    () =>
      useDocumentsSummary({
        artifactIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
});
