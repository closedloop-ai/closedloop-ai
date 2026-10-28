"use client";

import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import {
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ArtifactCacheRoot,
  resolveArtifactCacheRoot,
} from "../lib/artifact-cache-roots";
import { patchCachedArtifactPriority } from "../lib/patch-cached-artifact-priority";
import { useOrgScopeGuard } from "./use-org-scope-guard";

export type ArtifactPriorityMutationVariables = {
  artifactId: string;
  /** `null` clears. */
  priority: Priority | null;
  /**
   * The value the reader was shown, as the optimistic guard: `null` asserts the
   * artifact holds none. Omitted keeps last-write-wins, which is the honest
   * request when the row's own value is unknown to this producer.
   */
  expectedPriority?: Priority | null;
};

/**
 * The rollback material, plus the ORG it was taken in. The org travels with the
 * snapshot because `onError` fires long after `onMutate` and must not restore a
 * departed org's rows under the new org's keys.
 */
type PriorityCacheSnapshot = {
  org: string | null;
  entries: readonly [QueryKey, unknown][];
};

export type ArtifactPriorityMutation = UseMutationResult<
  void,
  unknown,
  ArtifactPriorityMutationVariables,
  PriorityCacheSnapshot
>;

/**
 * ISS-10332 / PLN-2086 Milestone 2 — the one optimistic single-artifact
 * priority write, which `useUpdateSessionPriority` and
 * `useUpdateBranchPriority` each bind to their own data-source port.
 *
 * Mirrors `useUpdateProjectPriority`'s shape and adds the three things a grid
 * cell needs and a project overview does not: an optimistic rewrite of every
 * cached view of the row under `queryKeyRoots`, a rollback of exactly those
 * entries on refusal (a `stale_priority` 409 included — the server's value is
 * then re-read, never guessed), and an invalidation once the write settles so
 * the list, its page-data twin and any detail agree with the producer again.
 *
 * `write` is the port's optional method; a source that offers none renders the
 * cell read-only upstream, so this hook is never asked to commit through it.
 * The default `mutations.onError` toast of the shared `QueryClient` is the
 * failure path — no client logging, no second toast (packages/app AGENTS.md).
 *
 * `queryClient` is the client the surface's reads are cached in — the Branches
 * provider can inject one of its own — and defaults to the nearest provider's.
 *
 * `queryKeyRoots` names only the reads that carry a row's priority (#7762
 * review): the surface's whole prefix would also walk and refetch usage,
 * analytics and parsed transcripts on every click.
 */
export function useArtifactPriorityMutation({
  queryClient: ownedQueryClient,
  queryKeyRoots,
  surface,
  write,
}: {
  queryClient?: QueryClient;
  queryKeyRoots: readonly ArtifactCacheRoot[];
  surface: ArtifactPriorityEditSurface;
  write:
    | ((id: string, input: UpdateArtifactPriorityRequest) => Promise<unknown>)
    | undefined;
}): ArtifactPriorityMutation {
  const queryClient = useQueryClient(ownedQueryClient);
  const orgScope = useOrgScopeGuard();
  return useMutation<
    void,
    unknown,
    ArtifactPriorityMutationVariables,
    PriorityCacheSnapshot
  >(
    {
      mutationFn: async ({ artifactId, priority, expectedPriority }) => {
        if (!write) {
          throw new Error("This data source cannot write a priority");
        }
        await write(artifactId, {
          priority,
          ...(expectedPriority === undefined ? {} : { expectedPriority }),
          surface,
        });
      },
      onMutate: async ({ artifactId, priority }) => {
        // BEFORE the first await, per `packages/app/AGENTS.md`: the org can
        // switch while `cancelQueries` is pending.
        const org = orgScope.capture();
        const filters = queryKeyRoots.map((root) =>
          resolveArtifactCacheRoot(root, artifactId)
        );
        await Promise.all(
          filters.map((filter) => queryClient.cancelQueries(filter))
        );
        if (!orgScope.isStillCurrent(org)) {
          return { org, entries: [] };
        }
        const snapshot = filters.flatMap((filter) =>
          queryClient.getQueriesData(filter)
        );
        for (const filter of filters) {
          queryClient.setQueriesData(filter, (cached) =>
            patchCachedArtifactPriority(cached, artifactId, priority)
          );
        }
        return { org, entries: snapshot };
      },
      onError: (_error, _variables, context) => {
        // A rollback after an org switch would restore the departed org's rows
        // under the new org's keys (whitlockk review, PR #8315).
        if (!(context && orgScope.isStillCurrent(context.org))) {
          return;
        }
        for (const [queryKey, cached] of context.entries) {
          queryClient.setQueryData(queryKey, cached);
        }
      },
      onSettled: (_data, _error, { artifactId }, context) => {
        if (context && !orgScope.isStillCurrent(context.org)) {
          return;
        }
        for (const root of queryKeyRoots) {
          queryClient.invalidateQueries(
            resolveArtifactCacheRoot(root, artifactId)
          );
        }
      },
    },
    queryClient
  );
}
