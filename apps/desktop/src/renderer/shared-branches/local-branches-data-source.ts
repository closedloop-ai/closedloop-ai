import type {
  BranchesChange,
  BranchesDataSource,
} from "@repo/app/branches/data-source/branches-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
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
  Partial<Pick<DesktopApi, "onDbChanged">>;

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
  const onDbChanged = desktopApi.onDbChanged;
  const sanitize = <T>(run: () => Promise<T>) =>
    runSource(
      run,
      "Branches source failed.",
      SHARED_BRANCHES_SOURCE_ERROR_CODE
    );

  return {
    scope: "local",
    list: (filters) => sanitize(() => desktopApi.branchesApi.list(filters)),
    detail: async (id) => {
      const data = await sanitize(() => desktopApi.branchesApi.detail(id));
      if (!data) {
        throw new ApiError(
          "Branch not found.",
          404,
          SHARED_BRANCHES_NOT_FOUND_CODE
        );
      }
      return data;
    },
    usage: (filters) => sanitize(() => desktopApi.branchesApi.usage(filters)),
    analytics: (filters) =>
      sanitize(() => desktopApi.branchesApi.analytics(filters)),
    subscribe: onDbChanged
      ? (onChange: (change: BranchesChange) => void) =>
          onDbChanged(() => onChange({}))
      : undefined,
  };
}
