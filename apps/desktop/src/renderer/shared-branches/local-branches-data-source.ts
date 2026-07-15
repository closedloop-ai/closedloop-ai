import {
  BranchCommentsState,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  GitHubDirtyScopeKind,
  type GitHubResyncNudgeBody,
} from "@repo/api/src/types/github-dirty-scope-constants";
import { ReadSource } from "@repo/api/src/types/read-source";
import type {
  BranchesChange,
  BranchesDataSource,
} from "@repo/app/branches/data-source/branches-data-source";
import { buildLocalCommentsResponse } from "@repo/app/branches/lib/live-overlays/live-pr-comments";
import { ApiError } from "@repo/app/shared/api/api-error";
import { withReadSource } from "@repo/app/shared/lib/read-source";
import {
  SHARED_BRANCHES_NOT_FOUND_CODE,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
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
      SHARED_BRANCHES_SOURCE_ERROR_CODE
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
        desktopApi.branchesApi.detail(
          options?.forceRefresh ? { id, forceRefresh: true } : id
        )
      );
      if (!data) {
        throw new ApiError(
          "Branch not found.",
          404,
          SHARED_BRANCHES_NOT_FOUND_CODE
        );
      }
      return data;
    },
    comments: async (id) => {
      const detail = await sanitize(() => desktopApi.branchesApi.detail(id));
      if (!detail) {
        throw new ApiError(
          "Branch not found.",
          404,
          SHARED_BRANCHES_NOT_FOUND_CODE
        );
      }
      return buildLocalCommentsResponse({
        branchId: id,
        state: BranchCommentsState.UnsyncedUnknown,
        prNumber: detail.prNumber,
        prUrl: detail.prUrl,
      });
    },
    // Best-effort (PLN-1148 Phase 2): the trace is enrichment for the timeline
    // tab — a failure degrades to an empty timeline rather than rejecting, so it
    // does NOT go through `sanitize` (which would surface a retry-skipping
    // ApiError). The main-process handler already degrades to [] on its own.
    trace: async (id) => {
      try {
        return await desktopApi.branchesApi.trace(id);
      } catch {
        return [];
      }
    },
    usage: (filters) => sanitize(() => desktopApi.branchesApi.usage(filters)),
    analytics: (filters) =>
      sanitize(() => desktopApi.branchesApi.analytics(filters)),
    subscribe: createBranchChangeSubscription(desktopApi),
  };
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
