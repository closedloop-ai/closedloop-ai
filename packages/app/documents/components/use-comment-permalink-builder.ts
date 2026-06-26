"use client";

import type { DocumentType } from "@repo/api/src/types/document";
import {
  buildScopedDocumentPath,
  TYPE_ROUTE_PREFIX,
} from "@repo/api/src/types/document";
import { buildCommentPermalink } from "@repo/collaboration/shared/permalinks";
import { useCallback } from "react";

/**
 * Returns a per-thread permalink-URL factory for the current artifact,
 * or undefined when the document type has no canonical route prefix
 * (e.g. TEMPLATE) — that disables the Copy Link button at the card
 * layer.
 */
export function useCommentPermalinkBuilder({
  documentType,
  documentSlug,
  orgSlug,
}: {
  documentType: DocumentType;
  documentSlug: string;
  orgSlug: string | null;
}): ((threadId: string) => string) | undefined {
  const routePrefix = TYPE_ROUTE_PREFIX[documentType];
  const artifactPath = routePrefix
    ? buildScopedDocumentPath(routePrefix, documentSlug, orgSlug)
    : null;
  const build = useCallback(
    (threadId: string) =>
      buildCommentPermalink({
        origin: globalThis.window?.location.origin ?? "",
        artifactPath: artifactPath ?? "",
        threadId,
      }),
    [artifactPath]
  );
  return artifactPath === null ? undefined : build;
}
