"use client";

import type { DocumentType } from "@repo/api/src/types/document";
import {
  buildScopedDocumentPath,
  TYPE_ROUTE_PREFIX,
} from "@repo/api/src/types/document";
import { buildCommentPermalink } from "@repo/collaboration/shared/permalinks";
import { useCallback } from "react";
import { useDocumentPermalinkOrigin } from "./document-host-context";

/**
 * Returns a per-thread permalink-URL factory for the current artifact,
 * or undefined when the document type has no canonical route prefix
 * so the card can hold its Copy Link control when the route is unavailable.
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
  const hostOrigin = useDocumentPermalinkOrigin();
  const origin = hostOrigin ?? globalThis.window?.location.origin ?? "";
  const routePrefix = TYPE_ROUTE_PREFIX[documentType];
  const artifactPath =
    routePrefix && hostOrigin !== null
      ? buildScopedDocumentPath(routePrefix, documentSlug, orgSlug)
      : null;
  const build = useCallback(
    (threadId: string) =>
      buildCommentPermalink({
        origin,
        artifactPath: artifactPath ?? "",
        threadId,
      }),
    [artifactPath, origin]
  );
  return artifactPath === null ? undefined : build;
}
