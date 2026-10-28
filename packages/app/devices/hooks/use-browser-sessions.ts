"use client";

import {
  BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  BrowserSessionErrorCode,
  type BrowserSessionListResponse,
  type BrowserSessionRevokeResponse,
} from "@repo/api/src/types/browser-session";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ApiError } from "../../shared/api/api-error";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * The signed-in user's own browser sign-ins (PLN-1915 Step 2), over the routes
 * ISS-9085 landed. Surface-agnostic: the panel that consumes this mounts on
 * both the web shell and the Desktop renderer.
 */

export type BrowserSessionsPageBounds = {
  limit?: number;
  offset?: number;
};

export const browserSessionKeys = {
  all: ["browser-sessions"] as const,
  list: (limit: number, offset: number) =>
    [...browserSessionKeys.all, "list", limit, offset] as const,
};

/**
 * The shared client's default mutation toast would speak for an outcome the
 * panel reports itself, and revoke has three distinguishable refusals
 * (409 / 404 / 503) that a generic "Operation failed" would flatten.
 */
const SUPPRESS_DEFAULT_ERROR_TOAST = {
  suppressDefaultErrorToast: true,
} as const;

/**
 * One page of the caller's active browser sessions.
 *
 * The bounds go on the wire on every request rather than being left to the
 * route's default: the query key is keyed by them, and a page whose size the
 * caller never stated cannot be reconciled against `totalCount` afterwards.
 */
export function useBrowserSessions(
  bounds: BrowserSessionsPageBounds = {},
  options?: Omit<
    UseQueryOptions<BrowserSessionListResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();
  // Filled in, not clamped: the route holds the one clamp (ISS-8734's
  // `clampPageLimit`) and answers with the bounds it actually used, so a second
  // copy here could only round differently and make the query key claim a page
  // the response never was.
  const limit = bounds.limit ?? BROWSER_SESSION_PAGE_LIMIT_DEFAULT;
  const offset = bounds.offset ?? 0;

  return useQuery({
    queryKey: browserSessionKeys.list(limit, offset),
    queryFn: () =>
      apiClient.get<BrowserSessionListResponse>(
        `/settings/browser-sessions?${new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        }).toString()}`
      ),
    ...options,
  });
}

/**
 * Revoke one browser session.
 *
 * The route refuses the caller's own current session with a 409 and answers
 * 404 identically for an unknown id and another user's, so the error is left
 * intact for the caller to classify.
 */
export function useRevokeBrowserSession() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: SUPPRESS_DEFAULT_ERROR_TOAST,
    mutationFn: (sessionId: string) =>
      apiClient.delete<BrowserSessionRevokeResponse>(
        `/settings/browser-sessions/${encodeURIComponent(sessionId)}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: browserSessionKeys.all });
    },
    onError: (error) => {
      // A 404 means the session is already gone, so the row still on screen —
      // and its Sign out button, offering to end something that has ended — is
      // stale, and the panel's sentence for this code tells the user the list
      // has been refreshed. This is what makes that sentence true.
      //
      // Only this code. A 409 is about the row the user is currently holding,
      // and a 503 means the provider could not be read at all, so re-reading
      // would either change nothing or fail the same way.
      if (isRevokedSessionAlreadyGone(error)) {
        queryClient.invalidateQueries({ queryKey: browserSessionKeys.all });
      }
    },
  });
}

/**
 * Keyed on the CODE rather than the bare 404 status, so the refresh and the
 * sentence the panel shows for it can never come apart: an uncoded 404 renders
 * the generic failure alert, which promises nothing about the list.
 */
function isRevokedSessionAlreadyGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.code === BrowserSessionErrorCode.SessionNotFound
  );
}
