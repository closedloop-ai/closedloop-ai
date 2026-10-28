import type { DocumentDetail } from "@repo/api/src/types/document";

/**
 * Returns the content that attachment deletion warnings should inspect.
 * Historical views must use the saved latest version carried by the API, not
 * the selected historical `document.version.content` body.
 */
export function getLatestContentForAttachmentWarnings({
  currentVersion,
  document,
  latestDraftContent,
}: {
  currentVersion: number;
  document: Pick<
    DocumentDetail,
    "latestVersion" | "latestVersionContent" | "version"
  >;
  latestDraftContent: string;
}): string {
  if (currentVersion === document.latestVersion) {
    return latestDraftContent;
  }

  return document.latestVersionContent ?? "";
}

/**
 * Resolves the Liveblocks room id the editor should actually connect to
 * (FEA-2404). The room is only joined once the user/org context is ready
 * (`/me` resolved), so its auth callback never races page mount and exhausts
 * Liveblocks' 10s auth timeout. Until ready, returns `null` — the already
 * supported room-less state — regardless of the artifact's room id. Passing
 * `null` also keeps the editor body / feed out of room-hook mode while there
 * is no RoomProvider.
 */
export function resolveActiveRoomId({
  liveblocksRoomId,
  isUserLoading,
  hasCurrentUser,
}: {
  liveblocksRoomId: string | null;
  isUserLoading: boolean;
  hasCurrentUser: boolean;
}): string | null {
  const collaborationReady = !isUserLoading && hasCurrentUser;
  return collaborationReady ? liveblocksRoomId : null;
}

/**
 * The content whose rendered inline images the attachment panels must HIDE.
 *
 * Deliberately NOT {@link getLatestContentForAttachmentWarnings}. That one
 * answers "would deleting this file break the document?", which is a question
 * about the latest saved body however far back the reader has scrolled. This one
 * answers "is the reader already looking at this image?", which is a question
 * about the version ON SCREEN. Sharing one derivation made a historical view
 * hide a file the selected version does not render, and list one it does
 * (ISS-8036 review).
 */
export function getSelectedContentForAttachmentVisibility({
  currentVersion,
  document,
  latestDraftContent,
}: {
  currentVersion: number;
  document: Pick<DocumentDetail, "latestVersion" | "version">;
  latestDraftContent: string;
}): string {
  if (currentVersion === document.latestVersion) {
    return latestDraftContent;
  }

  return document.version.content ?? "";
}
