export function generateArtifactRoomId(
  organizationId: string,
  documentSlug: string
): string {
  return `${organizationId}:artifact:${documentSlug}`;
}

export function parseArtifactRoomId(roomId: string): {
  organizationId: string;
  documentSlug: string;
} {
  const idParts = roomId.split(":");
  if (idParts.length !== 3) {
    throw new Error("Invalid room ID");
  }
  const [organizationId, roomType, documentSlug] = idParts;
  if (roomType !== "artifact") {
    throw new Error("Invalid room ID");
  }
  if (!(organizationId && documentSlug)) {
    throw new Error("Invalid room ID");
  }
  return { organizationId, documentSlug };
}
