"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import { useMutationState } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import { artifactFavoriteKeys } from "./artifact-favorite-keys";

/** A favorites read as ids, and whether a star can honestly render from it. */
export type FavoriteArtifactIds = {
  favoriteIds: ReadonlySet<string>;
  isUnavailable: boolean;
};

/**
 * The one read half every favorites controller shares (tamsinb review on
 * #9116), so Sessions, Branches and the artifact lists cannot drift.
 *
 * ISS-8335 (codex review cid 3880961547): an UNREAD favorites list is not an
 * empty one. Folding pending or error into an empty set showed every existing
 * favourite as unstarred, then took a click on that false state and submitted
 * the ADD path for something already favourited.
 *
 * whitlockk review cid 4327674216: a MALFORMED body is a third way not to know,
 * and it resolves, so neither `isError` nor `isPending` reports it.
 * `/artifacts/favorites` is a wire boundary, so a version-skewed response that
 * is not an array must not throw out of a render or pass as "no favourites".
 */
export function useFavoriteArtifactIds(read: {
  data: Artifact[] | undefined;
  isError: boolean;
  isPending: boolean;
}): FavoriteArtifactIds {
  const list = Array.isArray(read.data) ? read.data : undefined;
  const favoriteIds = useMemo(
    () => new Set((list ?? []).map((artifact) => artifact.id)),
    [list]
  );
  return {
    favoriteIds,
    isUnavailable: read.isPending || read.isError || list === undefined,
  };
}

/**
 * Artifact ids with a favorite toggle in flight, across every host, so the
 * shared star cell can refuse a second click that would send a second write
 * (marisolashgrove review on #9116; the replaced FavoriteButton did the same).
 */
export function usePendingFavoriteArtifactIds(): ReadonlySet<string> {
  const pending = useMutationState({
    filters: { mutationKey: artifactFavoriteKeys.toggle(), status: "pending" },
    select: (mutation) =>
      favoriteToggleVariablesSchema.safeParse(mutation.state.variables).data
        ?.artifactId,
  });
  const key = pending
    .filter((id) => id !== undefined)
    .join(PENDING_ID_SEPARATOR);
  return useMemo(
    () => new Set(key ? key.split(PENDING_ID_SEPARATOR) : []),
    [key]
  );
}

const PENDING_ID_SEPARATOR = "\n";

const favoriteToggleVariablesSchema = z.object({ artifactId: z.string() });
