import { parseDocumentRoomId } from "@repo/realtime-contract/document-room";

// biome-ignore lint/performance/noBarrelFile: re-export shim — the room-id helpers moved to `@repo/realtime-contract/document-room` (ISS-12502) so apps/doc-sync need not depend on this package; this import path stays stable for its existing importers.
export {
  generateDocumentRoomId,
  parseDocumentRoomId,
  ROOM_NAMESPACES,
  RoomNamespace,
} from "@repo/realtime-contract/document-room";

/**
 * @deprecated Use `parseDocumentRoomId` instead.
 */
export const parseArtifactRoomId = parseDocumentRoomId;
