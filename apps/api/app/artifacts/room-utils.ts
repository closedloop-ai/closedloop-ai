import type { Artifact } from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { createLiveblocksRoom, deleteLiveblocksRoom } from "@/lib/liveblocks";

export async function createArtifactRoom(
  artifact: Pick<
    Artifact,
    "id" | "organizationId" | "slug" | "type" | "latestVersion"
  >
) {
  const roomId = generateArtifactRoomId(artifact.organizationId, artifact.slug);
  await createLiveblocksRoom({
    roomId,
    tenantId: artifact.organizationId,
    metadata: {
      artifactId: artifact.id,
      artifactType: artifact.type,
      slug: artifact.slug,
      version: String(artifact.latestVersion),
    },
  });
}

export async function deleteArtifactRoom(organizationId: string, slug: string) {
  const roomId = generateArtifactRoomId(organizationId, slug);
  await deleteLiveblocksRoom(roomId);
}

export async function resetArtifactRoom(
  artifact: Pick<
    Artifact,
    "id" | "organizationId" | "slug" | "type" | "latestVersion"
  >
) {
  await deleteArtifactRoom(artifact.organizationId, artifact.slug);
  await createArtifactRoom(artifact);
}
