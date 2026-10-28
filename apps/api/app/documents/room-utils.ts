import type { Document } from "@repo/api/src/types/document";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { waitUntil } from "@vercel/functions";
import {
  broadcastLiveblocksRoomEvent,
  createLiveblocksRoom,
  deleteLiveblocksRoom,
  resetLiveblocksRoom,
  updateLiveblocksRoomMetadata,
} from "@/lib/liveblocks";
import { deleteDocSyncDocument } from "../doc-sync/internal/delete-state";
import { publishVersionToLiveDocument } from "../doc-sync/internal/seed-state";
import { emitDocumentVersionPublished } from "./version-published-signal";

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

/**
 * Puts the published version into both live transports (PLN-2190 T-2.3), then
 * emits the `version.published` signal once both have settled. A failed
 * transport never skips the other or the signal; its rejection is rethrown
 * after the signal so the caller can log it.
 */
export async function resetDocumentRoom(
  document: PublishedDocument,
  publisherId: string | null,
  content: string
) {
  const [liveblocks, docSync] = await Promise.allSettled([
    resetLiveblocksDocumentRoom(document, publisherId),
    publishVersionToLiveDocument({
      document,
      content,
      version: document.latestVersion,
    }),
  ]);
  await emitDocumentVersionPublished({
    organizationId: document.organizationId,
    documentId: document.id,
    version: document.latestVersion,
  });
  for (const leg of [liveblocks, docSync]) {
    if (leg.status === "rejected") {
      throw leg.reason;
    }
  }
}

/**
 * Neither delete throws, so neither can fail the other or the caller's request.
 * The doc-sync delete can wait out a stalled unload and its retry, so it runs
 * after the response; the daily sweep removes what it leaves behind.
 */
export async function deleteDocumentRoom(organizationId: string, slug: string) {
  const roomId = generateDocumentRoomId(organizationId, slug);
  waitUntil(deleteDocSyncDocument(roomId));
  await deleteLiveblocksRoom(roomId);
}

type PublishedDocument = Pick<
  Document,
  "id" | "organizationId" | "slug" | "type" | "latestVersion"
>;

async function resetLiveblocksDocumentRoom(
  document: PublishedDocument,
  publisherId: string | null
) {
  const roomId = generateDocumentRoomId(document.organizationId, document.slug);
  await resetLiveblocksRoom(roomId);
  await updateLiveblocksRoomMetadata(roomId, {
    documentId: document.id,
    documentType: document.type,
    slug: document.slug,
    version: String(document.latestVersion),
  });
  // The Liveblocks reset protocol: a Liveblocks editor refetches and reseeds
  // the room this reset just cleared. Installed desktop builds listen for it,
  // so it stays until the `doc-sync-editor` flag retires (PLN-2190 AC-012);
  // the `version.published` realtime signal is what tells every editor.
  await broadcastLiveblocksRoomEvent(roomId, {
    type: RoomEventType.DocumentVersionPublished,
    version: document.latestVersion,
    publisherId,
    publishedAt: new Date().toISOString(),
  });
}
