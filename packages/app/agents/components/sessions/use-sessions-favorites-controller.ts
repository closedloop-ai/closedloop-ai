"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  bulkReceiptFromCommittedIds,
  invalidateForBulkArtifactMutation,
} from "../../../documents/hooks/bulk-artifact-invalidation";
import {
  useFavoriteArtifacts,
  useToggleFavoriteArtifact,
} from "../../../documents/hooks/use-artifact-favorites";
import {
  useFavoriteArtifactIds,
  usePendingFavoriteArtifactIds,
} from "../../../documents/hooks/use-favorite-artifact-ids";
import {
  type SessionsFavoriteController,
  toSessionsBulkFavoriteOutcome,
} from "./sessions-list-interactions";

/**
 * The Sessions row star, for every shell that mounts the shared surface
 * (ISS-12691, marisolashgrove review cid 4327728360).
 *
 * `enabled` is the host's claim that its row ids ARE cloud artifact ids, which
 * is the precondition {@link SessionsFavoriteController} documents: the star
 * reads the batched `/artifacts/favorites` list and the per-artifact toggle the
 * Documents table already uses. Web passes `true`; Desktop passes cloud mode,
 * because a local-mode session id is not an artifact id and could neither read
 * nor persist a star. Returning `undefined` is how a host says it has no
 * favourites concept at all, so the surface omits the star's grid track rather
 * than reserving an empty one.
 */
export function useSessionsFavoritesController(
  enabled: boolean
): SessionsFavoriteController | undefined {
  const queryClient = useQueryClient();
  const { favoriteIds, isUnavailable: isFavoritesUnavailable } =
    useFavoriteArtifactIds(useFavoriteArtifacts({ enabled }));
  const pendingIds = usePendingFavoriteArtifactIds();
  const toggleFavoriteArtifact = useToggleFavoriteArtifact();
  /*
   * The controller is still SUPPLIED while the read is unavailable (Pascoe
   * review). Withholding it entirely would drop the star's grid track and shift
   * every column, and neither state is terminal, so the table would move under
   * the reader mid-session.
   */

  return useMemo(() => {
    if (!enabled) {
      return undefined;
    }
    return {
      favoriteIds,
      isUnavailable: isFavoritesUnavailable,
      pendingIds,
      /**
       * whitlockk review cid 3880964961: `allSettled`, not `all`.
       *
       * These are N independent per-artifact mutations, and `Promise.all`
       * rejects on the first one — so a batch whose last row failed threw over
       * the rows the server had already taken, and the reader was told the
       * whole thing failed while their selection sat unchanged on top of a
       * server that disagreed. Reporting the split lets the bulk bar name what
       * landed and leave only the rest selected.
       */
      onBulkChange: async (
        rows: readonly SessionTableRow[],
        favorited: boolean
      ) => {
        const outcome = toSessionsBulkFavoriteOutcome(
          rows,
          await Promise.allSettled(
            rows.map((row) =>
              toggleFavoriteArtifact.mutateAsync({
                artifactId: row.id,
                // `favorited` is the DESIRED next state; the mutation takes
                // the CURRENT one, so it is the negation rather than the same
                // boolean forwarded.
                isFavorite: !favorited,
              })
            )
          )
        );
        // The per-artifact mutation refreshes the favorites list alone, which
        // is the star and nothing else. Every other view of these artifacts —
        // the Documents table, the project board, the Sessions summary — is
        // refreshed from the same set every other bulk bar uses (ISS-9578).
        invalidateForBulkArtifactMutation(
          queryClient,
          bulkReceiptFromCommittedIds(outcome.succeededIds)
        );
        return outcome;
      },
      onChange: (row: SessionTableRow, favorited: boolean) =>
        toggleFavoriteArtifact.mutate({
          artifactId: row.id,
          isFavorite: !favorited,
        }),
    };
  }, [
    enabled,
    favoriteIds,
    isFavoritesUnavailable,
    pendingIds,
    queryClient,
    toggleFavoriteArtifact,
  ]);
}
