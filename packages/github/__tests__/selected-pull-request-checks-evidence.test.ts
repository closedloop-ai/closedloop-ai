import type { Octokit } from "@octokit/rest";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { getSelectedPullRequestChecksEvidence } from "../selected-pull-request-checks-evidence";
import type { SelectedPullRequestChecksOctokit } from "../selected-pull-request-client";

const HEAD_SHA = "a".repeat(40);
const NEXT_HEAD_SHA = "b".repeat(40);
const OWNER = "Acme";
const REPO = "Widgets";
const PULL_NUMBER = 42;

const mockGet = vi.fn();
const mockGraphql = vi.fn();
const octokit: SelectedPullRequestChecksOctokit = {
  graphql: (query, parameters) => mockGraphql(query, parameters),
  rest: { pulls: { get: mockGet } },
};

describe("getSelectedPullRequestChecksEvidence", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGraphql.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts the caller-authorized Octokit shape without widening ISS-4982", () => {
    expectTypeOf<Octokit>().toExtend<SelectedPullRequestChecksOctokit>();
  });

  it("fully paginates mixed source kinds for the selected immutable head", async () => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "cursor-1",
          nodes: [makeCheckRun()],
        })
      )
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          nodes: [makeStatusContext({ state: "PENDING" })],
        })
      );

    const result = await getSelectedPullRequestChecksEvidence(
      octokit,
      ` ${OWNER} `,
      `${REPO}.git`,
      PULL_NUMBER
    );

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        identity: { repositoryFullName: "acme/widgets", number: PULL_NUMBER },
        revision: { headSha: HEAD_SHA },
        checks: [
          {
            name: "deploy",
            sourceKind: SelectedPullRequestCheckSourceKind.StatusContext,
            category: SelectedPullRequestCheckCategory.Pending,
          },
          {
            name: "test",
            sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
            category: SelectedPullRequestCheckCategory.Successful,
          },
        ],
        counts: {
          providerExpected: 2,
          providerReturned: 2,
          normalizedAttempts: 2,
          emitted: 2,
          total: 2,
          successful: 1,
          failing: 0,
          pending: 1,
          neutral: 0,
        },
        pagination: { pagesFetched: 2 },
        history: {
          mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
          rawAttempts: 2,
          emittedSources: 2,
        },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Complete,
          reasons: [],
        },
      },
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGraphql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("statusCheckRollup"),
      {
        owner: "acme",
        repo: "widgets",
        headSha: HEAD_SHA,
        after: null,
        pageSize: 100,
        request: { signal: expect.any(AbortSignal) },
      }
    );
    expect(mockGraphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: "cursor-1", headSha: HEAD_SHA })
    );
  });

  it("selects the latest attempt per source through the provider entry point", async () => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [
            makeCheckRun({
              id: "older",
              conclusion: "FAILURE",
              createdAt: "2026-08-04T19:55:00Z",
              completedAt: "2026-08-04T20:00:00Z",
            }),
          ],
        })
      )
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          nodes: [
            makeCheckRun({
              id: "newer",
              conclusion: "SUCCESS",
              createdAt: "2026-08-04T20:01:00Z",
              completedAt: "2026-08-04T20:05:00Z",
            }),
          ],
        })
      );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [
          {
            providerId: "newer",
            category: SelectedPullRequestCheckCategory.Successful,
          },
        ],
        counts: {
          providerReturned: 2,
          normalizedAttempts: 2,
          emitted: 1,
          total: 1,
        },
        history: { rawAttempts: 2, emittedSources: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("returns available known-zero checks when the selected commit has no rollup", async () => {
    mockStableMetadata();
    mockGraphql.mockResolvedValueOnce(makeZeroPage());

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [],
        counts: { providerExpected: 0, total: 0 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("treats an exact 100-context terminal page as complete", async () => {
    mockStableMetadata();
    mockGraphql.mockResolvedValueOnce(
      makePage({ totalCount: 100, nodes: makeCheckRuns(100) })
    );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { providerExpected: 100, providerReturned: 100, total: 100 },
        pagination: { pagesFetched: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Complete,
          reasons: [],
        },
      },
    });
  });

  it("returns stale revision when PR identity or head changes after paging", async () => {
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockResolvedValueOnce({
        data: makeMetadata({ head: { sha: NEXT_HEAD_SHA } }),
      });
    mockGraphql.mockResolvedValueOnce(
      makePage({ totalCount: 1, nodes: [makeCheckRun()] })
    );

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.StaleRevision,
    });
  });

  it("returns missing immutable revision when the final head SHA is absent", async () => {
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockResolvedValueOnce({ data: makeMetadata({ head: { sha: null } }) });
    mockGraphql.mockResolvedValueOnce(
      makePage({ totalCount: 1, nodes: [makeCheckRun()] })
    );

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision,
    });
  });

  it("omits unknown outcomes and marks coverage partial", async () => {
    mockStableMetadata();
    mockGraphql.mockResolvedValueOnce(
      makePage({
        totalCount: 2,
        nodes: [
          makeCheckRun(),
          makeCheckRun({ id: "future", status: "FUTURE" }),
        ],
      })
    );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [{ providerId: "check-node-1" }],
        counts: { providerReturned: 2, normalizedAttempts: 1, total: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.UnknownOutcome],
        },
      },
    });
  });

  it("marks a missing next cursor partial without another request", async () => {
    mockStableMetadata();
    mockGraphql.mockResolvedValueOnce(
      makePage({
        totalCount: 2,
        hasNextPage: true,
        endCursor: null,
        nodes: [makeCheckRun()],
      })
    );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.PaginationStalled],
        },
      },
    });
    expect(mockGraphql).toHaveBeenCalledOnce();
  });

  it("marks a repeated next cursor partial without a third request", async () => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 3,
          hasNextPage: true,
          endCursor: "repeated",
          nodes: [makeCheckRun()],
        })
      )
      .mockResolvedValueOnce(
        makePage({
          totalCount: 3,
          hasNextPage: true,
          endCursor: "repeated",
          nodes: [makeStatusContext()],
        })
      );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { providerReturned: 2, normalizedAttempts: 2, emitted: 2 },
        pagination: { pagesFetched: 2 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.PaginationStalled],
        },
      },
    });
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("marks duplicate provider ids across pages partial", async () => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockResolvedValueOnce(
        makePage({ totalCount: 2, nodes: [makeCheckRun()] })
      );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { providerReturned: 2, normalizedAttempts: 1, emitted: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.DuplicateProviderId],
        },
      },
    });
  });

  it("marks changing provider totals partial", async () => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockResolvedValueOnce(
        makePage({ totalCount: 3, nodes: [makeStatusContext()] })
      );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: {
          providerExpected: 2,
          providerReturned: 2,
          normalizedAttempts: 1,
        },
        pagination: { pagesFetched: 2 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.CountMismatch],
        },
      },
    });
  });

  it("preserves valid prior pages when a later provider page fails", async () => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockRejectedValueOnce({ status: 503 });

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [{ providerId: "check-node-1" }],
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
          interruption: {
            reason:
              SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
          },
        },
      },
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "missing selected revision",
      { repository: { object: null } },
      SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible,
    ],
    [
      "malformed response envelope",
      {},
      SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    ],
  ])("preserves typed provenance for a later %s page", async (_name, malformedPage, reason) => {
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockResolvedValueOnce(malformedPage);

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        checks: [{ providerId: "check-node-1" }],
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
          interruption: { reason },
        },
      },
    });
  });

  it("recovers partial GraphQL data without claiming completeness", async () => {
    mockStableMetadata();
    mockGraphql.mockRejectedValueOnce(
      Object.assign(new Error("partial GraphQL response"), {
        data: makePage({ totalCount: 1, nodes: [makeCheckRun()] }),
      })
    );

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { total: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
        },
      },
    });
  });

  it("marks evidence acquisition-capped when 10,000 contexts still have a next page", async () => {
    mockStableMetadata();
    mockGraphql.mockImplementation(() => {
      const page = mockGraphql.mock.calls.length;
      return Promise.resolve(
        makePage({
          totalCount: 10_001,
          hasNextPage: true,
          endCursor: `cursor-${page}`,
          nodes: makeCheckRuns(100, (page - 1) * 100),
        })
      );
    });

    const result = await acquire();

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { providerReturned: 10_000, total: 10_000 },
        pagination: {
          pagesFetched: 100,
          reachedAcquisitionMaximum: true,
        },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.AcquisitionCapped],
        },
      },
    });
  });

  it.each([
    [
      "unauthorized PR read",
      "metadata",
      { status: 401 },
      SelectedPullRequestEvidenceUnavailableReason.CredentialUnauthorized,
    ],
    [
      "missing PR",
      "metadata",
      { status: 404 },
      SelectedPullRequestEvidenceUnavailableReason.PullRequestMissingOrInaccessible,
    ],
    [
      "missing selected revision",
      "graphql",
      { status: 404 },
      SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible,
    ],
    [
      "provider failure",
      "graphql",
      { status: 503 },
      SelectedPullRequestEvidenceUnavailableReason.ProviderUnavailable,
    ],
  ])("classifies %s by failing operation", async (_name, phase, error, reason) => {
    if (phase === "metadata") {
      mockGet.mockRejectedValueOnce(error);
    } else {
      mockStableMetadata();
      mockGraphql.mockRejectedValueOnce(error);
    }

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason,
    });
  });

  it("gives rate-limit evidence precedence over a generic GraphQL 403", async () => {
    mockStableMetadata();
    mockGraphql.mockRejectedValueOnce({
      status: 403,
      headers: { "retry-after": "9" },
      message: "secondary rate limit",
    });

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderRateLimited,
      retryAfterSeconds: 9,
    });
  });

  it("bounds a hung middle page with one aborting deadline", async () => {
    vi.useFakeTimers();
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockImplementationOnce((_query, parameters) =>
        rejectWhenAborted(parameters.request.signal)
      );

    const resultPromise = acquire();
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(resultPromise).resolves.toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { providerReturned: 1, total: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
          interruption: {
            reason:
              SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
          },
        },
      },
    });
    expect(mockGraphql).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        after: "next",
        request: { signal: expect.objectContaining({ aborted: true }) },
      })
    );
    expect(mockGet).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight initial metadata request and waits for settlement", async () => {
    vi.useFakeTimers();
    mockGet.mockImplementationOnce(({ request }) =>
      rejectWhenAborted(request.signal)
    );

    const resultPromise = acquire({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns unavailable when caller cancellation aborts the first checks page", async () => {
    const controller = new AbortController();
    mockStableMetadata();
    mockGraphql.mockImplementationOnce((_query, parameters) =>
      rejectWhenAborted(parameters.request.signal)
    );

    const resultPromise = acquire({ signal: controller.signal });
    await vi.waitFor(() => expect(mockGraphql).toHaveBeenCalledOnce());
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it("preserves a validated page when an aborted adapter rejects generically", async () => {
    const controller = new AbortController();
    mockStableMetadata();
    mockGraphql
      .mockResolvedValueOnce(
        makePage({
          totalCount: 2,
          hasNextPage: true,
          endCursor: "next",
          nodes: [makeCheckRun()],
        })
      )
      .mockImplementationOnce((_query, parameters) =>
        rejectWithGenericErrorWhenAborted(parameters.request.signal)
      );

    const resultPromise = acquire({ signal: controller.signal });
    await vi.waitFor(() => expect(mockGraphql).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        revision: { headSha: HEAD_SHA },
        checks: [{ providerId: "check-node-1" }],
        counts: { providerExpected: 2, providerReturned: 1, total: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
          interruption: {
            reason:
              SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
          },
        },
      },
    });
    expect(mockGet).toHaveBeenCalledOnce();
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("does not schedule another page when cancellation arrives between pages", async () => {
    const controller = new AbortController();
    mockStableMetadata();
    mockGraphql.mockResolvedValueOnce(
      makePageThatAbortsDuringValidation(controller, true)
    );

    const result = await acquire({ signal: controller.signal });

    expect(result).toMatchObject({
      status: SelectedPullRequestEvidenceAvailability.Available,
      value: {
        counts: { providerReturned: 1, total: 1 },
        coverage: {
          completeness: SelectedPullRequestChecksCompleteness.Partial,
          reasons: [SelectedPullRequestChecksPartialReason.ProviderPageFailure],
          interruption: {
            reason:
              SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
          },
        },
      },
    });
    expect(mockGraphql).toHaveBeenCalledOnce();
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it("returns unavailable when cancellation prevents final metadata verification", async () => {
    const controller = new AbortController();
    mockStableMetadata();
    mockGraphql.mockResolvedValueOnce(
      makePageThatAbortsDuringValidation(controller, false)
    );

    await expect(acquire({ signal: controller.signal })).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGraphql).toHaveBeenCalledOnce();
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it("aborts in-flight final metadata verification without publishing rows", async () => {
    const controller = new AbortController();
    mockGet
      .mockResolvedValueOnce({ data: makeMetadata() })
      .mockImplementationOnce(({ request }) =>
        rejectWhenAborted(request.signal)
      );
    mockGraphql.mockResolvedValueOnce(
      makePage({ totalCount: 1, nodes: [makeCheckRun()] })
    );

    const resultPromise = acquire({ signal: controller.signal });
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.ProviderTimedOut,
    });
    expect(mockGraphql).toHaveBeenCalledOnce();
  });

  it("rejects malformed input before provider I/O", async () => {
    await expect(
      getSelectedPullRequestChecksEvidence(octokit, "bad/owner", REPO, 0)
    ).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedRequest,
    });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects repository component aliases before provider I/O", async () => {
    await expect(
      getSelectedPullRequestChecksEvidence(octokit, "/Acme", REPO, PULL_NUMBER)
    ).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedRequest,
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects non-http pull request identity urls", async () => {
    mockGet.mockResolvedValueOnce({
      data: makeMetadata({ html_url: "javascript:alert(1)" }),
    });

    await expect(acquire()).resolves.toEqual({
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

function acquire(
  options: Parameters<typeof getSelectedPullRequestChecksEvidence>[4] = {}
) {
  return getSelectedPullRequestChecksEvidence(
    octokit,
    OWNER,
    REPO,
    PULL_NUMBER,
    options
  );
}

function mockStableMetadata() {
  mockGet.mockResolvedValue({ data: makeMetadata() });
}

function makeMetadata(
  overrides: Partial<{
    id: number;
    number: number;
    html_url: string;
    head: { sha: string | null };
  }> = {}
) {
  return {
    id: 123,
    number: PULL_NUMBER,
    html_url: "https://github.com/acme/widgets/pull/42",
    head: { sha: HEAD_SHA },
    ...overrides,
  };
}

function makePage({
  totalCount = 0,
  hasNextPage = false,
  endCursor = null,
  nodes = [],
}: {
  totalCount?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  nodes?: unknown[];
} = {}) {
  return {
    repository: {
      object: {
        __typename: "Commit",
        statusCheckRollup: {
          contexts: {
            totalCount,
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  };
}

function makePageThatAbortsDuringValidation(
  controller: AbortController,
  hasNextPage: boolean
) {
  const page = makePage({
    totalCount: hasNextPage ? 2 : 1,
    hasNextPage,
    endCursor: hasNextPage ? "next" : null,
    nodes: [makeCheckRun()],
  });
  Object.defineProperty(
    page.repository.object.statusCheckRollup.contexts.pageInfo,
    "hasNextPage",
    {
      enumerable: true,
      get() {
        controller.abort();
        return hasNextPage;
      },
    }
  );
  return page;
}

function makeZeroPage() {
  return {
    repository: {
      object: { __typename: "Commit", statusCheckRollup: null },
    },
  };
}

function makeCheckRuns(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) =>
    makeCheckRun({
      id: `check-${offset + index}`,
      name: `check-${offset + index}`,
    })
  );
}

function makeCheckRun(
  overrides: Partial<{
    id: string;
    name: string;
    status: string;
    conclusion: string | null;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }> = {}
) {
  return {
    __typename: "CheckRun",
    id: "check-node-1",
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    createdAt: "2026-08-04T19:58:00Z",
    startedAt: "2026-08-04T19:59:00Z",
    completedAt: "2026-08-04T20:00:00Z",
    detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
    url: "https://api.github.com/repos/acme/widgets/check-runs/1",
    checkSuite: {
      app: {
        id: "app-node",
        databaseId: 7,
        slug: "ci",
        name: "CI",
        url: "https://github.com/apps/ci",
      },
    },
    ...overrides,
  };
}

function makeStatusContext(
  overrides: Partial<{
    context: string;
    state: string;
    createdAt: string | null;
  }> = {}
) {
  return {
    __typename: "StatusContext",
    context: "deploy",
    state: "SUCCESS",
    createdAt: "2026-08-04T20:00:00Z",
    targetUrl: "https://vercel.com/acme/widgets/1",
    ...overrides,
  };
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function rejectWithGenericErrorWhenAborted(
  signal: AbortSignal
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectWithTransportError = () => reject(new Error("socket closed"));
    if (signal.aborted) {
      rejectWithTransportError();
      return;
    }
    signal.addEventListener("abort", rejectWithTransportError, { once: true });
  });
}
