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
  const parts = roomId.split(":");

  if (parts.length !== 3 || parts[1] !== "artifact") {
    throw new Error("Invalid room ID format");
  }

  return {
    organizationId: parts[0],
    documentSlug: parts[2],
  };
}
