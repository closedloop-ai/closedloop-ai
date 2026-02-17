export function generateArtifactRoomId(
  organizationId: string,
  slug: string
): string {
  return `${organizationId}:artifact:${slug}`;
}

export function parseArtifactRoomId(roomId: string): {
  organizationId: string;
  slug: string;
} {
  const parts = roomId.split(":");

  if (parts.length !== 3 || parts[1] !== "artifact") {
    throw new Error("Invalid room ID format");
  }

  return {
    organizationId: parts[0],
    slug: parts[2],
  };
}
