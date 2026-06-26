import type { Document } from "@repo/api/src/types/document";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import {
  broadcastLiveblocksRoomEvent,
  createLiveblocksRoom,
  deleteLiveblocksRoom,
  resetLiveblocksRoom,
  updateLiveblocksRoomMetadata,
} from "@/lib/liveblocks";

export async function createDocumentRoom(
  document: Pick<
    Document,
    "id" | "organizationId" | "slug" | "type" | "latestVersion"
  >
) {
  const roomId = generateDocumentRoomId(document.organizationId, document.slug);
  await createLiveblocksRoom({
    roomId,
    tenantId: document.organizationId,
    metadata: {
      documentId: document.id,
      documentType: document.type,
      slug: document.slug,
      version: String(document.latestVersion),
    },
  });
}

export async function resetDocumentRoom(
  document: Pick<
    Document,
    "id" | "organizationId" | "slug" | "type" | "latestVersion"
  >,
  publisherId: string | null = null
) {
  const roomId = generateDocumentRoomId(document.organizationId, document.slug);
  await resetLiveblocksRoom(roomId);
  await updateLiveblocksRoomMetadata(roomId, {
    documentId: document.id,
    documentType: document.type,
    slug: document.slug,
    version: String(document.latestVersion),
  });
  // Notify connected clients so they refetch the new content and re-seed
  // the Y.Doc, rather than rendering blank against the cleared room. Every
  // client reacts (including the publisher's own tab); the receiving side
  // dedupes idempotently per version, not on `publisherId`.
  await broadcastLiveblocksRoomEvent(roomId, {
    type: RoomEventType.DocumentVersionPublished,
    version: document.latestVersion,
    publisherId,
    publishedAt: new Date().toISOString(),
  });
}

export async function deleteDocumentRoom(organizationId: string, slug: string) {
  const roomId = generateDocumentRoomId(organizationId, slug);
  await deleteLiveblocksRoom(roomId);
}
