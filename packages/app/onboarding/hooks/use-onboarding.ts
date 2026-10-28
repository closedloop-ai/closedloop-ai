"use client";

import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { onboardingStatusSchema } from "@repo/api/src/types/onboarding-schema";
import {
  type QueryClient,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ZodError } from "zod";
import { useApiClient } from "../../shared/api/use-api-client";
import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { shouldRetryQuery } from "../../shared/query/query-client";

// Query keys
export const onboardingKeys = {
  all: ["onboarding"] as const,
  // ISS-5991: namespaced by the identity the response is scoped to — both halves
  // of it. `checklistDismissed` describes the caller and the checklist rows
  // describe the organization, while the browser QueryClient is a module-level
  // singleton. Without the user, one account's dismissal answers for the next
  // account in the same tab; without the org, a same-user org switch renders the
  // previous org's still-fresh status. ISS-7442 now folds that same identity
  // into every key's cache hash on the shell's client, so this is belt and
  // braces rather than the only thing holding — kept because a query that
  // states its own scope survives being read on a client nobody wired.
  status: (orgId: string | null, userId: string | null) =>
    [...onboardingKeys.all, "status", orgId, userId] as const,
};

// Queries
export function useOnboardingStatus(
  options?: Omit<UseQueryOptions<OnboardingStatus>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  const { isLoaded, orgId, userId } = useOptionalAuthSnapshot();

  return useQuery({
    queryKey: onboardingKeys.status(orgId, userId),
    // ISS-7828: parsed, so a malformed 2xx is a query error the guard and the
    // page render as recoverable, not an unread body they would route on.
    queryFn: async () =>
      onboardingStatusSchema.parse(await apiClient.get<unknown>("/onboarding")),
    // A body that failed the schema was answered, not lost: a retry reads the
    // same body back and only holds off the recoverable card. Every other error
    // keeps the shared client's policy.
    retry: (failureCount, error) =>
      !(error instanceof ZodError) && shouldRetryQuery(failureCount, error),
    staleTime: 5 * 60 * 1000,
    ...options,
    // Gate placed AFTER the spread so a caller can narrow it but never widen it.
    // Firing before the shell's identity hydrates would cache the signed-in
    // user's status under the shared `userId: null` key — `useApiClient` waits
    // for auth, so the request resolves with real data — and the next account in
    // the same tab reads that slot back during its own pre-hydration render,
    // which is the leak the namespacing exists to close. A gated-off query keeps
    // `status: "pending"`, so consumers must branch on `isPending`, never
    // `isLoading` (false here, because nothing is in flight).
    enabled: isLoaded && userId !== null && (options?.enabled ?? true),
  });
}

// Mutations
//
// ISS-7089 F3: both mutations return the fresh OnboardingStatus their PUT
// computed, so onSuccess WRITES it into the cache instead of invalidating.
// Invalidation left a window in which the cache still read the stale status
// while the refetch was in flight — the exact window OnboardingGuard used to
// paper over by blanking on `isFetching`, unmounting the whole authenticated
// content region on every background refetch. A synchronous cache write closes
// the window at the source; no refetch is needed because the response IS the
// authoritative post-mutation status for this identity.
//
// ISS-7828: only a response that parses as a status is written. The PUT has
// committed either way, so an unreadable body is not a failed mutation; it
// resolves as `null` and the entry is RESET for `GET /onboarding` to settle.
// Invalidating would keep the pre-mutation answer in `data`, and the wizard's
// post-completion navigation would route on that stale `wizardCompleted: false`
// straight back to /onboarding — or, if the re-read failed, restart the wizard
// instead of showing the recoverable card.
export function useCompleteWizard() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const { orgId, userId } = useOptionalAuthSnapshot();

  return useMutation({
    mutationFn: async (input: {
      createdTeamId?: string;
      createdProjectId?: string;
    }) =>
      readReturnedStatus(
        await apiClient.put<unknown>("/onboarding/complete-wizard", input)
      ),
    // Snapshot the identity at CALL time: mutation callbacks are refreshed on
    // every render, so an onSuccess reading the live snapshot would write the
    // response under whichever org/user is active at RESOLVE time — the wrong
    // tenant across a mid-flight org switch.
    onMutate: () => ({ orgId, userId }),
    onSuccess: (data, _input, context) => {
      settleStatusCache(
        queryClient,
        onboardingKeys.status(context.orgId, context.userId),
        data
      );
    },
  });
}

export function useDismissChecklist() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();
  const { orgId, userId } = useOptionalAuthSnapshot();

  return useMutation({
    mutationFn: async () =>
      readReturnedStatus(
        await apiClient.put<unknown>("/onboarding/dismiss-checklist", {})
      ),
    // Same call-time identity snapshot as useCompleteWizard above.
    onMutate: () => ({ orgId, userId }),
    onSuccess: (data, _input, context) => {
      settleStatusCache(
        queryClient,
        onboardingKeys.status(context.orgId, context.userId),
        data
      );
    },
  });
}

function readReturnedStatus(body: unknown): OnboardingStatus | null {
  const parsed = onboardingStatusSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

function settleStatusCache(
  queryClient: QueryClient,
  queryKey: ReturnType<typeof onboardingKeys.status>,
  status: OnboardingStatus | null
) {
  if (status !== null) {
    queryClient.setQueryData(queryKey, status);
    return;
  }
  queryClient.resetQueries({ queryKey });
}
