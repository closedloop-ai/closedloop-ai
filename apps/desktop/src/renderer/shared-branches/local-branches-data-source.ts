import {
  BranchCommentsState,
  type BranchPageDetail,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import { branchAnalyticsCohortConsumerResponseSchema } from "@repo/api/src/types/branch-analytics-cohort";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  BranchTraceUnavailableReason,
  normalizeBranchTraceResult,
  unavailableBranchTraceResult,
} from "@repo/api/src/types/branch-trace";
import {
  GitHubDirtyScopeKind,
  type GitHubResyncNudgeBody,
} from "@repo/api/src/types/github-dirty-scope-constants";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SelectedPullRequestEvidenceUnavailableReason } from "@repo/api/src/types/selected-pull-request-evidence";
import type {
  BranchesChange,
  BranchesDataSource,
} from "@repo/app/branches/data-source/branches-data-source";
import { buildLocalCommentsResponse } from "@repo/app/branches/lib/local-pr-comments";
import { ApiError } from "@repo/app/shared/api/api-error";
import { withReadSource } from "@repo/app/shared/lib/read-source";
import {
  SHARED_BRANCHES_NOT_FOUND_CODE,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
  SHARED_BRANCHES_TRANSIENT_ERROR_CODE,
} from "../../shared/shared-branches-contract";
import { runSource } from "../shared/run-source";
import type { DesktopApi } from "../types/desktop-api";

/**
 * The slice of the desktop preload API the local data source needs.
 * `onDbChanged` is optional: the live subscription is best-effort, and a preload
 * without it simply yields a source with no `subscribe`.
 */
type DesktopLocalBranchesApi = Pick<DesktopApi, "branchesApi"> &
  Partial<Pick<DesktopApi, "onDbChanged" | "onGitHubResyncNudge">>;

/**
 * The desktop-local `BranchesDataSource` (PLN-983 / Epic A — A4). It routes the
 * shared `@repo/app` branch read hooks straight to
 * `window.desktopApi.branchesApi` over Electron IPC — no fake HTTP envelope and
 * no network — and exposes the local DB's `desktop:db:changed` push stream as
 * `subscribe` so the live bridge can refresh the Branches views.
 *
 * Error contract (matches the Sessions local source so hook/component behavior
 * is identical): a missing detail rejects with a 404 `ApiError`
 * (`SHARED_BRANCHES_NOT_FOUND_CODE`) rather than resolving `null`, and any
 * underlying source failure rejects with a sanitized 500 `ApiError`
 * (`SHARED_BRANCHES_SOURCE_ERROR_CODE`) — the raw error is discarded so no local
 * filesystem/SQL detail leaks to the renderer. `ApiError` (vs a bare `Error`)
 * preserves the HTTP path's retry semantics: the shared query client skips
 * retries for any `ApiError`, so both the 404 and the 500 opt out of retry.
 *
 * `onDbChanged`'s `{ sessionId? }` payload maps to a BROAD `BranchesChange`
 * (`branchId` left undefined) since any session DB change can move branch rows;
 * v1 has no stable per-branch change identity (openQuestion #1).
 */
export function createLocalBranchesDataSource(
  desktopApi: DesktopLocalBranchesApi
): BranchesDataSource {
  const sanitize = <T>(run: () => Promise<T>) =>
    runSource(
      run,
      "Branches source failed.",
      SHARED_BRANCHES_SOURCE_ERROR_CODE,
      SHARED_BRANCHES_TRANSIENT_ERROR_CODE
    );

  return {
    scope: "local",
    // FEA-3120: rows come straight from the desktop's local SQLite over IPC, so
    // stamp `local` at the read boundary (never overwriting an explicit value the
    // IPC layer already reported).
    list: async (filters) => {
      const response = await sanitize(() =>
        desktopApi.branchesApi.list(filters)
      );
      return withReadSource(response, ReadSource.Local);
    },
    detail: async (id, options) => {
      const data = await sanitize(() =>
        desktopApi.branchesApi.detail(detailRequest(id, options))
      );
      if (!data) {
        throw new ApiError(
          "Branch not found.",
          404,
          SHARED_BRANCHES_NOT_FOUND_CODE
        );
      }
      return suppressMismatchedSelectedPullRequest(data, options);
    },
    comments: async (id, options) => {
      const detail = await sanitize(() =>
        desktopApi.branchesApi.detail(detailRequest(id, options))
      );
      if (!detail) {
        throw new ApiError(
          "Branch not found.",
          404,
          SHARED_BRANCHES_NOT_FOUND_CODE
        );
      }
      const resolved = suppressMismatchedSelectedPullRequest(detail, options);
      return buildLocalCommentsResponse({
        branchId: id,
        state: BranchCommentsState.UnsyncedUnknown,
        prNumber: resolved.prNumber,
        prUrl: resolved.prUrl,
      });
    },
    // Version-skewed Desktop mains may still return the legacy raw item array.
    trace: async (id, options) => {
      try {
        options?.signal?.throwIfAborted();
        const result = normalizeBranchTraceResult(
          await desktopApi.branchesApi.trace(id)
        );
        options?.signal?.throwIfAborted();
        return result;
      } catch (error) {
        if (options?.signal?.aborted) {
          options.signal.throwIfAborted();
        }
        if (isAbortError(error)) {
          throw error;
        }
        return unavailableBranchTraceResult(
          [],
          BranchTraceUnavailableReason.Unknown
        );
      }
    },
    usage: (filters) => sanitize(() => desktopApi.branchesApi.usage(filters)),
    analytics: (filters) =>
      sanitize(() => desktopApi.branchesApi.analytics(filters)),
    cohortAnalytics: (request) => {
      const cohortAnalytics = desktopApi.branchesApi.cohortAnalytics;
      return cohortAnalytics
        ? sanitize(async () => {
            const response = await cohortAnalytics(request);
            return response === null
              ? null
              : branchAnalyticsCohortConsumerResponseSchema.parse(response);
          })
        : Promise.resolve(null);
    },
    // Same FEA-3120 stamp as `list` above, applied to the nested list — the
    // combined read still carries local provenance for the ReadSourceBadge.
    pageData: async (filters) => {
      const response = await sanitize(() =>
        desktopApi.branchesApi.pageData(filters)
      );
      return {
        ...response,
        list: withReadSource(response.list, ReadSource.Local),
      };
    },
    subscribe: createBranchChangeSubscription(desktopApi),
  };
}

function detailRequest(
  id: string,
  options: Parameters<BranchesDataSource["detail"]>[1]
) {
  if (!options) {
    return id;
  }
  return {
    id,
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    ...(options.repositoryFullName === undefined
      ? {}
      : { repositoryFullName: options.repositoryFullName }),
    ...(options.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: options.pullRequestNumber }),
  };
}

/**
 * A newer renderer can send explicit selection to an older main that silently
 * ignores the additive request fields. Detect that version skew from the
 * returned selected identity and withhold only PR-owned evidence; Branch-owned
 * identity, Sessions, costs, collaborators, and activity remain intact.
 */
export function suppressMismatchedSelectedPullRequest(
  detail: BranchPageDetail,
  selection:
    | {
        repositoryFullName?: string;
        pullRequestNumber?: number;
      }
    | undefined
): BranchPageDetail {
  if (
    selection?.repositoryFullName === undefined ||
    selection.pullRequestNumber === undefined
  ) {
    return detail;
  }
  const selected = detail.selectedPullRequest;
  if (
    selected?.repositoryFullName === selection.repositoryFullName &&
    selected.number === selection.pullRequestNumber
  ) {
    return detail;
  }
  return {
    ...detail,
    selectedPullRequest: null,
    selectedPullRequestChecks: {
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason: SelectedPullRequestEvidenceUnavailableReason.MalformedResponse,
    },
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    reviewDecision: null,
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewedParticipants: [],
    reviewedParticipantsTruncated: false,
    ...(detail.canonicalMetrics
      ? {
          canonicalMetrics: {
            ...detail.canonicalMetrics,
            locPerDollar: unavailableMetric(),
            leadTimeMs: unavailableMetric(),
            abandonmentTimeMs: unavailableMetric(),
            idleTimeMs: unavailableMetric(),
          },
        }
      : {}),
  };
}

function unavailableMetric() {
  return {
    state: BranchMetricAvailability.Unavailable,
    value: null,
  } as const;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createBranchChangeSubscription(
  desktopApi: DesktopLocalBranchesApi
): BranchesDataSource["subscribe"] {
  const onDbChanged = desktopApi.onDbChanged;
  const onGitHubResyncNudge = desktopApi.onGitHubResyncNudge;
  if (!(onDbChanged || onGitHubResyncNudge)) {
    return undefined;
  }

  return (onChange: (change: BranchesChange) => void) => {
    const unsubscribers: Array<() => void> = [];
    if (onDbChanged) {
      unsubscribers.push(onDbChanged(() => onChange({})));
    }
    if (onGitHubResyncNudge) {
      unsubscribers.push(
        onGitHubResyncNudge((event) => {
          for (const change of gitHubNudgeChanges(event)) {
            onChange(change);
          }
        })
      );
    }
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  };
}

function gitHubNudgeChanges(event: unknown): BranchesChange[] {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return [{}];
  }
  const payload = event as {
    body?: unknown;
    branchIds?: readonly unknown[];
  };
  const explicitBranchIds = collectBranchIds(payload.branchIds);
  if (explicitBranchIds.length > 0) {
    return explicitBranchIds.map((branchId) => ({ branchId }));
  }

  if (!isGitHubResyncNudgeBody(payload.body)) {
    return [{}];
  }

  const branchIds = collectBranchIds(
    payload.body.scopes.map((scope) => branchIdFromDirtyScope(scope))
  );
  if (branchIds.length > 0) {
    return branchIds.map((branchId) => ({ branchId }));
  }
  return [{}];
}

function branchIdFromDirtyScope(scope: unknown): string | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return null;
  }
  const typedScope = scope as {
    kind?: unknown;
    repositoryFullName?: unknown;
    branchName?: unknown;
  };
  if (typedScope.kind === GitHubDirtyScopeKind.Generic) {
    return null;
  }
  if (
    typeof typedScope.repositoryFullName !== "string" ||
    typeof typedScope.branchName !== "string"
  ) {
    return null;
  }
  return encodeBranchId({
    repoFullName: typedScope.repositoryFullName,
    branchName: typedScope.branchName,
  });
}

function collectBranchIds(values: readonly unknown[] | undefined): string[] {
  const ids = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value === "string" && value.length > 0) {
      ids.add(value);
    }
  }
  return [...ids];
}

function isGitHubResyncNudgeBody(
  value: unknown
): value is GitHubResyncNudgeBody {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as { scopes?: unknown }).scopes)
  );
}
