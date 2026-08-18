import {
  type SelectedPullRequestCheck,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { z } from "zod";
import {
  normalizeSelectedPullRequestCheckContext,
  type SelectedPullRequestCheckAttempt,
  selectLatestSelectedPullRequestChecks,
} from "./selected-pull-request-check-normalizer";
import type { SelectedPullRequestChecksOctokit } from "./selected-pull-request-client";
import {
  classifySelectedPullRequestProviderError,
  type SelectedPullRequestProviderFailure,
  SelectedPullRequestProviderOperation,
} from "./selected-pull-request-provider-failure";

/** Fully paginate and normalize status-check rollup contexts for one commit. */
export async function readSelectedPullRequestCheckContexts(
  octokit: SelectedPullRequestChecksOctokit,
  owner: string,
  repo: string,
  headSha: string,
  signal: AbortSignal
): Promise<SelectedPullRequestCheckContextsResult> {
  const state = createContextReadState();

  for (let pageIndex = 0; pageIndex < MAX_CHECK_CONTEXT_PAGES; pageIndex += 1) {
    if (signal.aborted) {
      return finishCancelledContextRead(state, signal.reason);
    }
    const requestedPage = await requestContextPage(
      octokit,
      owner,
      repo,
      headSha,
      state.after,
      signal
    );
    const resolution = resolveContextPageRequest(requestedPage, state);
    if (resolution.kind === RequestResolutionKind.Unavailable) {
      return resolution.result;
    }
    if (resolution.kind === RequestResolutionKind.Stop) {
      break;
    }
    const outcome = applyRawContextPage(resolution.data, state);
    if (outcome.kind === PageOutcomeKind.Unavailable) {
      return state.pagesFetched === 0
        ? unavailable(outcome.reason)
        : finishContextReadWithPageFailure(state, outcome.reason);
    }
    if (outcome.kind === PageOutcomeKind.Stop || resolution.stopAfterApply) {
      break;
    }
  }

  if (!state.terminated && state.pagesFetched >= MAX_CHECK_CONTEXT_PAGES) {
    state.reachedAcquisitionMaximum = true;
    state.reasons.add(SelectedPullRequestChecksPartialReason.AcquisitionCapped);
  }
  return finishContextRead(state);
}

function resolveContextPageRequest(
  request: ContextPageRequest,
  state: ContextReadState
): ContextPageRequestResolution {
  if (request.ok) {
    return {
      kind: RequestResolutionKind.Data,
      data: request.data,
      stopAfterApply: false,
    };
  }
  if (request.abortError) {
    return state.pagesFetched === 0
      ? {
          kind: RequestResolutionKind.Unavailable,
          result: unavailableFromFailure(
            classifySelectedPullRequestProviderError(
              toAbortError(request.error),
              SelectedPullRequestProviderOperation.SelectedRevision
            )
          ),
        }
      : finishCancelledRequest(state, toAbortError(request.error));
  }
  const failure = classifySelectedPullRequestProviderError(
    request.error,
    SelectedPullRequestProviderOperation.SelectedRevision
  );
  if (!request.partialData && state.pagesFetched === 0) {
    return {
      kind: RequestResolutionKind.Unavailable,
      result: unavailableFromFailure(failure),
    };
  }
  state.reasons.add(SelectedPullRequestChecksPartialReason.ProviderPageFailure);
  state.interruption = failure;
  if (!request.partialData) {
    return { kind: RequestResolutionKind.Stop };
  }
  return {
    kind: RequestResolutionKind.Data,
    data: request.partialData,
    stopAfterApply: true,
  };
}

async function requestContextPage(
  octokit: SelectedPullRequestChecksOctokit,
  owner: string,
  repo: string,
  headSha: string,
  after: string | null,
  signal: AbortSignal
): Promise<ContextPageRequest> {
  try {
    const data = await octokit.graphql(SELECTED_PULL_REQUEST_CHECKS_QUERY, {
      owner,
      repo,
      headSha,
      after,
      pageSize: CHECK_CONTEXTS_PER_PAGE,
      request: { signal },
    });
    if (signal.aborted) {
      return abortedPageRequest(signal.reason);
    }
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error,
      abortError:
        signal.aborted ||
        (error instanceof Error && error.name === "AbortError"),
      partialData: readPartialGraphqlData(error),
    };
  }
}

function finishCancelledContextRead(
  state: ContextReadState,
  error: unknown
): SelectedPullRequestCheckContextsResult {
  if (state.pagesFetched === 0) {
    return unavailableFromFailure(
      classifySelectedPullRequestProviderError(
        toAbortError(error),
        SelectedPullRequestProviderOperation.SelectedRevision
      )
    );
  }
  state.reasons.add(SelectedPullRequestChecksPartialReason.ProviderPageFailure);
  state.interruption = classifySelectedPullRequestProviderError(
    toAbortError(error),
    SelectedPullRequestProviderOperation.SelectedRevision
  );
  return finishContextRead(state);
}

function finishCancelledRequest(
  state: ContextReadState,
  error: unknown
): ContextPageRequestResolution {
  state.reasons.add(SelectedPullRequestChecksPartialReason.ProviderPageFailure);
  state.interruption = classifySelectedPullRequestProviderError(
    toAbortError(error),
    SelectedPullRequestProviderOperation.SelectedRevision
  );
  return { kind: RequestResolutionKind.Stop };
}

function abortedPageRequest(reason: unknown): ContextPageRequest {
  return {
    ok: false,
    error: toAbortError(reason),
    abortError: true,
    partialData: null,
  };
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const error = new Error("Selected pull-request checks cancelled");
  error.name = "AbortError";
  return error;
}

function applyRawContextPage(
  rawPage: unknown,
  state: ContextReadState
): PageOutcome {
  const parsed = contextPageResponseSchema.safeParse(rawPage);
  if (!parsed.success) {
    return unavailablePage(
      SelectedPullRequestEvidenceUnavailableReason.MalformedResponse
    );
  }
  const object = parsed.data.repository?.object;
  if (!object || object.__typename !== ProviderObjectType.Commit) {
    return unavailablePage(
      SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible
    );
  }
  const rollup = object.statusCheckRollup;
  if (!rollup) {
    if (state.pagesFetched > 0) {
      return unavailablePage(
        SelectedPullRequestEvidenceUnavailableReason.MalformedResponse
      );
    }
    state.pagesFetched = 1;
    state.expectedTotal = 0;
    state.terminated = true;
    return stopPage();
  }
  return applyContextConnection(rollup.contexts, state);
}

function applyContextConnection(
  connection: z.infer<typeof contextConnectionSchema>,
  state: ContextReadState
): PageOutcome {
  state.pagesFetched += 1;
  state.providerReturned += connection.nodes.length;
  if (
    state.expectedTotal !== null &&
    state.expectedTotal !== connection.totalCount
  ) {
    state.reasons.add(SelectedPullRequestChecksPartialReason.CountMismatch);
    return stopPage();
  }
  state.expectedTotal ??= connection.totalCount;

  for (const rawContext of connection.nodes) {
    const result = normalizeSelectedPullRequestCheckContext(
      rawContext,
      state.providerPosition
    );
    state.providerPosition += 1;
    if (!result.ok) {
      state.reasons.add(result.reason);
      continue;
    }
    if (state.providerIds.has(result.attempt.check.providerId)) {
      state.reasons.add(
        SelectedPullRequestChecksPartialReason.DuplicateProviderId
      );
      continue;
    }
    state.providerIds.add(result.attempt.check.providerId);
    state.attempts.push(result.attempt);
  }

  if (!connection.pageInfo.hasNextPage) {
    state.terminated = true;
    if (state.providerReturned !== state.expectedTotal) {
      state.reasons.add(SelectedPullRequestChecksPartialReason.CountMismatch);
    }
    return stopPage();
  }
  const nextCursor = connection.pageInfo.endCursor;
  if (!nextCursor || state.seenCursors.has(nextCursor)) {
    state.reasons.add(SelectedPullRequestChecksPartialReason.PaginationStalled);
    return stopPage();
  }
  state.seenCursors.add(nextCursor);
  state.after = nextCursor;
  return continuePage();
}

function finishContextReadWithPageFailure(
  state: ContextReadState,
  reason: SelectedPullRequestEvidenceUnavailableReason
): InternalAvailable<SelectedPullRequestCheckContextsRead> {
  state.reasons.add(SelectedPullRequestChecksPartialReason.ProviderPageFailure);
  state.interruption = { reason };
  return finishContextRead(state);
}

function finishContextRead(
  state: ContextReadState
): InternalAvailable<SelectedPullRequestCheckContextsRead> {
  const selection = selectLatestSelectedPullRequestChecks(state.attempts);
  if (selection.hasAmbiguousSource) {
    state.reasons.add(SelectedPullRequestChecksPartialReason.AmbiguousSource);
  }
  const reasons = [...state.reasons].sort(
    (left, right) => partialReasonPriority[left] - partialReasonPriority[right]
  );
  return available({
    checks: selection.checks,
    pageSize: CHECK_CONTEXTS_PER_PAGE,
    acquisitionMaximum: MAX_CHECK_CONTEXTS,
    providerExpected: state.expectedTotal ?? 0,
    providerReturned: state.providerReturned,
    normalizedAttempts: state.attempts.length,
    pagesFetched: state.pagesFetched,
    reachedAcquisitionMaximum: state.reachedAcquisitionMaximum,
    reasons,
    interruption: state.interruption,
  });
}

function readPartialGraphqlData(error: unknown): unknown | null {
  const parsed = partialGraphqlErrorSchema.safeParse(error);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.data !== undefined) {
    return parsed.data.data;
  }
  const responseData = parsed.data.response?.data;
  const nested = nestedGraphqlDataSchema.safeParse(responseData);
  return nested.success ? nested.data.data : (responseData ?? null);
}

function createContextReadState(): ContextReadState {
  return {
    after: null,
    attempts: [],
    expectedTotal: null,
    interruption: undefined,
    pagesFetched: 0,
    providerIds: new Set<string>(),
    providerPosition: 0,
    providerReturned: 0,
    reachedAcquisitionMaximum: false,
    reasons: new Set<SelectedPullRequestChecksPartialReason>(),
    seenCursors: new Set<string>(),
    terminated: false,
  };
}

function available<T>(value: T): InternalAvailable<T> {
  return {
    status: SelectedPullRequestEvidenceAvailability.Available,
    value,
  };
}

function unavailable(
  reason: SelectedPullRequestEvidenceUnavailableReason
): UnavailableResult {
  return {
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    reason,
  };
}

function unavailableFromFailure(
  failure: SelectedPullRequestProviderFailure
): UnavailableResult {
  return {
    status: SelectedPullRequestEvidenceAvailability.Unavailable,
    ...failure,
  };
}

function unavailablePage(
  reason: SelectedPullRequestEvidenceUnavailableReason
): PageOutcome {
  return { kind: PageOutcomeKind.Unavailable, reason };
}

function continuePage(): PageOutcome {
  return { kind: PageOutcomeKind.Continue };
}

function stopPage(): PageOutcome {
  return { kind: PageOutcomeKind.Stop };
}

/** Paginated selected-head rows and the provenance needed by the public contract. */
export type SelectedPullRequestCheckContextsRead = {
  checks: SelectedPullRequestCheck[];
  pageSize: number;
  acquisitionMaximum: number;
  providerExpected: number;
  providerReturned: number;
  normalizedAttempts: number;
  pagesFetched: number;
  reachedAcquisitionMaximum: boolean;
  reasons: readonly SelectedPullRequestChecksPartialReason[];
  interruption?: SelectedPullRequestProviderFailure;
};

type SelectedPullRequestCheckContextsResult =
  | InternalAvailable<SelectedPullRequestCheckContextsRead>
  | UnavailableResult;

type ContextReadState = {
  after: string | null;
  attempts: SelectedPullRequestCheckAttempt[];
  expectedTotal: number | null;
  interruption: SelectedPullRequestProviderFailure | undefined;
  pagesFetched: number;
  providerIds: Set<string>;
  providerPosition: number;
  providerReturned: number;
  reachedAcquisitionMaximum: boolean;
  reasons: Set<SelectedPullRequestChecksPartialReason>;
  seenCursors: Set<string>;
  terminated: boolean;
};

type InternalAvailable<T> = {
  status: typeof SelectedPullRequestEvidenceAvailability.Available;
  value: T;
};

type UnavailableResult = {
  status: typeof SelectedPullRequestEvidenceAvailability.Unavailable;
  reason: SelectedPullRequestEvidenceUnavailableReason;
  retryAfterSeconds?: number | null;
};

type ContextPageRequest =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: unknown;
      abortError: boolean;
      partialData: unknown | null;
    };

type ContextPageRequestResolution =
  | {
      kind: typeof RequestResolutionKind.Data;
      data: unknown;
      stopAfterApply: boolean;
    }
  | { kind: typeof RequestResolutionKind.Stop }
  | {
      kind: typeof RequestResolutionKind.Unavailable;
      result: UnavailableResult;
    };

type PageOutcome =
  | { kind: typeof PageOutcomeKind.Continue }
  | { kind: typeof PageOutcomeKind.Stop }
  | {
      kind: typeof PageOutcomeKind.Unavailable;
      reason: SelectedPullRequestEvidenceUnavailableReason;
    };

const PageOutcomeKind = {
  Continue: "continue",
  Stop: "stop",
  Unavailable: "unavailable",
} as const;

const RequestResolutionKind = {
  Data: "data",
  Stop: "stop",
  Unavailable: "unavailable",
} as const;

const ProviderObjectType = {
  Commit: "Commit",
} as const;

const CHECK_CONTEXTS_PER_PAGE = 100;
const MAX_CHECK_CONTEXTS = 10_000;
const MAX_CHECK_CONTEXT_PAGES = MAX_CHECK_CONTEXTS / CHECK_CONTEXTS_PER_PAGE;

const contextConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().min(1).nullable(),
  }),
  nodes: z.array(z.unknown()).max(CHECK_CONTEXTS_PER_PAGE),
});

const contextPageResponseSchema = z.object({
  repository: z
    .object({
      object: z
        .object({
          __typename: z.string(),
          statusCheckRollup: z
            .object({ contexts: contextConnectionSchema })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const partialGraphqlErrorSchema = z.object({
  data: z.unknown().optional(),
  response: z.object({ data: z.unknown().optional() }).optional(),
});

const nestedGraphqlDataSchema = z.object({ data: z.unknown() });

const partialReasonPriority = {
  [SelectedPullRequestChecksPartialReason.AcquisitionCapped]: 0,
  [SelectedPullRequestChecksPartialReason.PaginationStalled]: 1,
  [SelectedPullRequestChecksPartialReason.ProviderPageFailure]: 2,
  [SelectedPullRequestChecksPartialReason.CountMismatch]: 3,
  [SelectedPullRequestChecksPartialReason.DuplicateProviderId]: 4,
  [SelectedPullRequestChecksPartialReason.MalformedContext]: 5,
  [SelectedPullRequestChecksPartialReason.UnknownOutcome]: 6,
  [SelectedPullRequestChecksPartialReason.AmbiguousSource]: 7,
} satisfies Record<SelectedPullRequestChecksPartialReason, number>;

const SELECTED_PULL_REQUEST_CHECKS_QUERY = `
  query GetSelectedPullRequestChecks(
    $owner: String!
    $repo: String!
    $headSha: String!
    $after: String
    $pageSize: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      object(expression: $headSha) {
        __typename
        ... on Commit {
          statusCheckRollup {
            contexts(first: $pageSize, after: $after) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ... on CheckRun {
                  id name status conclusion createdAt startedAt completedAt detailsUrl url
                  checkSuite { app { id databaseId slug name url } }
                }
                ... on StatusContext { context state createdAt targetUrl }
              }
            }
          }
        }
      }
    }
  }
`;
