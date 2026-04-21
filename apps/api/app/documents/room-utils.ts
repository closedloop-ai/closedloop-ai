import type { Document } from "@repo/api/src/types/document";
import { generateDocumentRoomId } from "@repo/collaboration/room-utils";
import {
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
  >
) {
  const roomId = generateDocumentRoomId(document.organizationId, document.slug);
  await resetLiveblocksRoom(roomId);
  await updateLiveblocksRoomMetadata(roomId, {
    documentId: document.id,
    documentType: document.type,
    slug: document.slug,
    version: String(document.latestVersion),
  });
}

export async function deleteDocumentRoom(organizationId: string, slug: string) {
  const roomId = generateDocumentRoomId(organizationId, slug);
  await deleteLiveblocksRoom(roomId);
}
