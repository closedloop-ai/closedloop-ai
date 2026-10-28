"use client";

import { DOC_SYNC_EDITOR_FLAG_KEY } from "@repo/api/src/types/doc-sync-editor-flag";
import { resolveActiveRoomId } from "@repo/app/documents/components/document-editor-scaffold-helpers";
import { useDocumentBySlug } from "@repo/app/documents/hooks/use-documents";
import { isNavigableDocument } from "@repo/app/documents/lib/document-navigation";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useAuth } from "@repo/auth/client";
import { usePrewarmDocumentRoom } from "@repo/collaboration/client/use-prewarm-document-room";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { resolveClientFetchedArtifactSlug } from "@/lib/artifact-route-slug";

/**
 * Starts an artifact route's two slowest reads while the shell is still
 * booting, and renders nothing (ISS-7492).
 *
 * It sits ABOVE `OnboardingGuard`, which renders nothing until `/onboarding`
 * answers, so the page — and every read it owns — cannot start before then.
 * Measured on production RUM over 7 days of artifact-route initial loads, the
 * document read began p75 1,874 ms into the view and the room's first call at
 * p75 2,326 ms, both after reads that had already settled.
 *
 * Both reads are the page's own: the document query key is the one
 * `VersionedDocumentEditorContainer` reads, so the page finds it in cache
 * instead of issuing it, and the room is the one the editor's `RoomProvider`
 * joins. Nothing here renders, and nothing it starts changes what the page
 * shows — the page still decides what to do with a failure, a redirect, or a
 * missing document exactly as before.
 */
export function ArtifactRoutePrewarm() {
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  // Every query on this client hashes under the signed-in identity (ISS-7442),
  // and until Clerk resolves one the scope is a single-use anonymous slot. A
  // read issued before then lands in that slot, the page's read misses it, and
  // the prewarm has bought a second request instead of an earlier one.
  const { isLoaded: isAuthLoaded, userId, orgSlug } = useAuth();
  const isCacheScopeResolved = isAuthLoaded && Boolean(userId);
  // A `?version` read is a different query key, so warming the latest version
  // would issue a request the page never reads. The editor still joins the room
  // there, but reads the saved content rather than the Y.Doc, and the room warm
  // below always starts a Y.Doc load, so a historical view warms neither.
  const isHistoricalVersion = Boolean(searchParams?.get("version"));
  const slug = isHistoricalVersion
    ? null
    : resolveClientFetchedArtifactSlug(pathname, orgSlug);

  const { data: document } = useDocumentBySlug(slug ?? "", undefined, {
    enabled: isCacheScopeResolved && Boolean(slug),
  });
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser({
    enabled: isCacheScopeResolved,
  });

  // The room id comes from the RESOLVED document, exactly as the editor derives
  // it (`useEditorSession`), never from the URL: the URL slug is only a lookup
  // key, and a room id built from it could connect to — and create — a room no
  // editor reads. The FEA-2404 gate is the editor's own `resolveActiveRoomId`,
  // so the room this joins is the one the page will join, under the same
  // condition. A non-navigable type (Template) renders not-found, so no editor
  // ever joins its room (ISS-12855).
  const roomId = resolveActiveRoomId({
    liveblocksRoomId:
      document && isNavigableDocument(document)
        ? generateDocumentRoomId(document.organizationId, document.slug)
        : null,
    isUserLoading,
    hasCurrentUser: Boolean(currentUser),
  });
  // PLN-2189 T-3.6: on doc-sync the editor loads no Liveblocks Y.Doc, so
  // warming one would be wasted (GAP-002: no doc-sync prewarm yet).
  const docSyncEditorEnabled = useFeatureFlagEnabled(DOC_SYNC_EDITOR_FLAG_KEY);
  usePrewarmDocumentRoom(docSyncEditorEnabled ? null : roomId);

  return null;
}
