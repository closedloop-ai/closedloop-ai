import {
  ROOM_NAMESPACES as REAL_ROOM_NAMESPACES,
  RoomNamespace as RealRoomNamespace,
  parseArtifactRoomId as realParseArtifactRoomId,
  parseDocumentRoomId as realParseDocumentRoomId,
} from "../../../packages/collaboration/shared/room-utils";

/**
 * Storybook's stand-in for `@repo/collaboration/shared/room-utils` (aliased in
 * ./module-aliases.ts). Everything is the real module except
 * `generateDocumentRoomId`, which names no room.
 *
 * Surfaces mounts the live document routes (Document, PRD, Plan and Issue
 * Detail). Their editor joins a Liveblocks room named by this function and
 * shows its body only once that room has synced; Storybook has no Liveblocks
 * service, so the room never syncs and the page stays on its spinner. With no
 * room id, `useEditorSession` and `DocumentEditorScaffold` both take the
 * editor's room-less branch: the same scaffold, header, tabs and rich-text
 * editor, loading the version's markdown directly. What a room adds (presence,
 * anchored comments and the feed rail) is not rendered.
 *
 * Its only other consumer, the route prewarm in the authenticated layout, is
 * not mounted by any story.
 */
export const parseArtifactRoomId = realParseArtifactRoomId;
export const parseDocumentRoomId = realParseDocumentRoomId;
export const ROOM_NAMESPACES = REAL_ROOM_NAMESPACES;
export const RoomNamespace = RealRoomNamespace;
export type RoomNamespace = RealRoomNamespace;

export function generateDocumentRoomId(
  _organizationId: string,
  _slug: string
): string {
  return "";
}
