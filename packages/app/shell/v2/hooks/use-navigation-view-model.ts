"use client";

import {
  ERRORED_NAVIGATION_VIEW_MODEL,
  type NavigationViewModel,
  PENDING_NAVIGATION_VIEW_MODEL,
} from "@repo/api/src/types/navigation-view-model";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { ApiClient } from "../../../shared/api/create-api-client";
import { useApiClient } from "../../../shared/api/use-api-client";
import type { AuthSnapshot } from "../../../shared/auth/auth-adapter";
import { useAuthSnapshot } from "../../../shared/auth/use-auth-snapshot";
import { shouldRefetchOnFocus } from "../../../shared/query/query-client";

export const navigationViewModelKeys = {
  all: ["navigation", "view-model"] as const,
  forActor: (
    userId: AuthSnapshot["userId"],
    orgId: AuthSnapshot["orgId"],
    destinationIds: readonly string[]
  ) =>
    [...navigationViewModelKeys.all, userId, orgId, ...destinationIds] as const,
};

/**
 * The actor's navigation projection for the destinations a host offers, read
 * from `GET /navigation/view-model` on both hosts (ISS-9734, PLN-2016 D4).
 *
 * Always a view model the fold can render, and never one that grants more than
 * was read:
 * - before the first answer, {@link PENDING_NAVIGATION_VIEW_MODEL};
 * - when the first read fails — a 404 from an API that predates the route
 *   included — {@link ERRORED_NAVIGATION_VIEW_MODEL};
 * - once an answer has landed, that answer, even while a later refetch fails,
 *   so a transient error after the first load never degrades the sidebar.
 *
 * The key carries the user and organization so a switch cannot serve the
 * previous actor's projection: desktop's query client has no scope binding that
 * would clear it.
 */
export function useNavigationViewModel(
  destinationIds: readonly string[],
  { enabled = true }: NavigationViewModelReadOptions = {}
): NavigationViewModel {
  const apiClient = useApiClient();
  const { orgId, userId } = useAuthSnapshot();
  const ids = Array.from(new Set(destinationIds)).sort((left, right) =>
    left.localeCompare(right)
  );

  const { data, isError } = useQuery({
    queryKey: navigationViewModelKeys.forActor(userId, orgId, ids),
    queryFn: () => fetchNavigationViewModel(apiClient, ids),
    enabled,
    // Stated rather than inherited because the hosts' clients disagree:
    // desktop's Local-mode client never goes stale and never refetches on focus,
    // which would pin the sidebar to whatever its first read said. Focus takes
    // the shared predicate rather than a bare `true` so a failed read, which an
    // API predating the route produces, keeps the error-path cooldown instead of
    // refetching on every focus.
    staleTime: NAVIGATION_VIEW_MODEL_STALE_TIME_MS,
    refetchOnWindowFocus: shouldRefetchOnFocus,
    refetchOnReconnect: true,
  });

  if (data !== undefined) {
    return data;
  }
  return isError
    ? ERRORED_NAVIGATION_VIEW_MODEL
    : PENDING_NAVIGATION_VIEW_MODEL;
}

const NAVIGATION_VIEW_MODEL_STALE_TIME_MS = 60_000;

/**
 * The STRUCTURE the fold walks, and nothing more. Status spellings are not
 * checked here: the fold already degrades a value it does not know to an
 * unreadable row, so a newer server adding one costs that row rather than the
 * whole sidebar. A body without this structure would throw inside render, so it
 * becomes a failed read instead.
 */
const navigationViewModelBodySchema = z.object({
  projectionStatus: z.string(),
  destinations: z.record(
    z.string(),
    z.object({ count: z.object({}).optional() })
  ),
});

async function fetchNavigationViewModel(
  apiClient: ApiClient,
  destinationIds: readonly string[]
): Promise<NavigationViewModel> {
  // Repeated `destinations` parameters, the route's contract; a comma-joined
  // value would be read as one id.
  const params = new URLSearchParams();
  for (const id of destinationIds) {
    params.append("destinations", id);
  }
  const body = await apiClient.get<NavigationViewModel>(
    `/navigation/view-model?${params.toString()}`
  );
  if (!navigationViewModelBodySchema.safeParse(body).success) {
    throw new Error("The navigation view model response has no projection");
  }
  return body;
}

export type NavigationViewModelReadOptions = {
  /**
   * Whether the host's offered set is the settled one. False holds the read and
   * keeps reporting {@link PENDING_NAVIGATION_VIEW_MODEL}, which is what a host
   * whose gates have not resolved actually knows.
   *
   * A host that derives its destination ids from gates reading closed only
   * because they have not resolved yet otherwise issues one read for that
   * provisional set and a second for the real one — a different id list is a
   * different query key, so the cache cannot fold them — and nothing ever
   * renders from the first.
   *
   * THE HOST OWNS THE BOUND, and owes one. A pending view model renders every
   * row non-navigable, so a hold on a signal that may never arrive — a feature
   * flag whose `/flags` request failed, an `identify()` that never landed — is a
   * sidebar that never becomes clickable. Hold on a resolution signal AND a
   * deadline, never on the signal alone.
   */
  readonly enabled?: boolean;
};
