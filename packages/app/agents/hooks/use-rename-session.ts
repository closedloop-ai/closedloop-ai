"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type QueryKey,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useOrgScopeGuard } from "../../shared/hooks/use-org-scope-guard";
import {
  type ArtifactCacheRoot,
  resolveArtifactCacheRoot,
} from "../../shared/lib/artifact-cache-roots";
import { patchCachedSessionName } from "../../shared/lib/patch-cached-session-name";
import { toastMutationError } from "../../shared/query/query-client";
import { useAgentSessionsDataSource } from "../data-source/provider";
import {
  agentSessionDetailRowFilter,
  agentSessionKeys,
} from "./agent-session-keys";

export type RenameSessionVariables = {
  sessionId: string;
  name: string;
  /**
   * The name the reader was shown, as the optimistic guard. Omitted keeps
   * last-write-wins, which is the honest request when the row's own rendered
   * name is unknown to this producer.
   */
  expectedName?: string;
  /** Whether this attempt can still render its adjacent rejection feedback. */
  recoverableErrorOwner?: () => boolean;
};

/**
 * The rollback material, plus the ORG it was taken in — the org travels with it
 * because `onError` fires long after `onMutate` and must not restore a departed
 * org's rows under the new org's keys.
 */
type SessionNameCacheSnapshot = {
  org: string | null;
  entries: readonly [QueryKey, unknown][];
};

export type RenameSessionMutation = UseMutationResult<
  void,
  unknown,
  RenameSessionVariables,
  SessionNameCacheSnapshot
>;

/**
 * ISS-8718 — rename one session through the active data source
 * (`PATCH /agent-sessions/[id]` on the HTTP source, the local store on the
 * desktop source), optimistic over the cached Sessions reads that carry the
 * name, rolled back on refusal.
 *
 * Mirrors `useArtifactPriorityMutation` deliberately, down to the three things
 * a grid write needs: an optimistic rewrite of every cached view of the row
 * under `queryKeyRoots`, a rollback of exactly those entries on refusal (a
 * `stale_name` 409 included — the server's value is then re-read, never
 * guessed), and an invalidation once the write settles so the list, its
 * page-data twin and any detail agree with the producer again. It is a separate
 * hook rather than a second verb on that one because the route refuses a body
 * pairing a rename with a priority, so the two can never share a request.
 *
 * `queryKeyRoots` names only the reads that carry a row's name (#7762 review's
 * rule for the priority write): the surface's whole prefix would also walk and
 * refetch usage, analytics and parsed transcripts on every commit. The detail
 * root is `agentSessionDetailRowFilter`, which selects THIS session's entry
 * rather than the `details()` prefix — that prefix also covers every session's
 * events pages and invocation tree, so one rename refetched all of them
 * (tamsinb review). The priority write shares the narrowing rather than
 * carrying a second copy of it.
 *
 * A refusal rolls the cache back and toasts nothing, as it always has: the
 * field that sent it owns the feedback. A retained-failure field (PRD-722)
 * passes `recoverableErrorOwner`; when that owner is gone by the time the
 * refusal lands, the shared toast is the only feedback left, so it fires.
 * The editors that mount this check the source can write first, so this hook is
 * never asked to commit through a source that offers no `renameSession`.
 */
export function useRenameSession(
  surface: ArtifactStatusEditSurface
): RenameSessionMutation {
  const dataSource = useAgentSessionsDataSource();
  const write = dataSource.renameSession?.bind(dataSource);
  const queryClient = useQueryClient();
  const orgScope = useOrgScopeGuard();
  const queryKeyRoots: readonly ArtifactCacheRoot[] = [
    agentSessionKeys.lists(),
    agentSessionKeys.pageDataRoot(),
    agentSessionDetailRowFilter,
  ];
  return useMutation<
    void,
    unknown,
    RenameSessionVariables,
    SessionNameCacheSnapshot
  >({
    mutationFn: async ({ sessionId, name, expectedName }) => {
      if (!write) {
        throw new Error("This data source cannot rename a session");
      }
      await write(sessionId, {
        name,
        ...(expectedName === undefined ? {} : { expectedName }),
        surface,
      });
    },
    onMutate: async ({ sessionId, name }) => {
      // BEFORE the first await, per `packages/app/AGENTS.md`: the org can switch
      // while `cancelQueries` is pending.
      const org = orgScope.capture();
      const filters = queryKeyRoots.map((root) =>
        resolveArtifactCacheRoot(root, sessionId)
      );
      await Promise.all(
        filters.map((filter) => queryClient.cancelQueries(filter))
      );
      if (!orgScope.isStillCurrent(org)) {
        return { entries: [], org };
      }
      const snapshot = filters.flatMap((filter) =>
        queryClient.getQueriesData(filter)
      );
      for (const filter of filters) {
        queryClient.setQueriesData(filter, (cached) =>
          patchCachedSessionName(cached, sessionId, name)
        );
      }
      return { entries: snapshot, org };
    },
    onError: (error, variables, context) => {
      if (variables.recoverableErrorOwner?.() === false) {
        toastMutationError(error);
      }
      // A rollback after an org switch would restore the departed org's rows
      // under the new org's keys (whitlockk review, PR #8315).
      if (!(context && orgScope.isStillCurrent(context.org))) {
        return;
      }
      for (const [queryKey, cached] of context.entries) {
        queryClient.setQueryData(queryKey, cached);
      }
    },
    onSettled: (_data, _error, { sessionId }, context) => {
      if (context && !orgScope.isStillCurrent(context.org)) {
        return;
      }
      for (const root of queryKeyRoots) {
        queryClient.invalidateQueries(
          resolveArtifactCacheRoot(root, sessionId)
        );
      }
    },
  });
}
