import type { Artifact } from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { createLiveblocksRoom, deleteLiveblocksRoom } from "@/lib/liveblocks";

export async function createArtifactRoom(artifact: Artifact) {
  if (!artifact.documentSlug) {
    throw new Error("Artifact has no document slug");
  }
  const roomId = generateArtifactRoomId(
    artifact.organizationId,
    artifact.documentSlug
  );
  await createLiveblocksRoom({
    roomId,
    tenantId: artifact.organizationId,
    metadata: {
      artifactId: artifact.id,
      artifactSubtype: artifact.subtype,
      documentSlug: artifact.documentSlug,
      version: String(artifact.version),
    },
  });
}

export async function deleteArtifactRoom(
  organizationId: string,
  documentSlug: string
) {
  const roomId = generateArtifactRoomId(organizationId, documentSlug);
  await deleteLiveblocksRoom(roomId);
}
