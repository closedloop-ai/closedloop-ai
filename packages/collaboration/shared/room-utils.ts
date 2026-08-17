/**
 * The middle segment of a collaboration room ID.
 *
 * Liveblocks room IDs are immutable, so the pre-rename `document` namespace can
 * never be migrated away and stays accepted indefinitely. This is the SINGLE
 * source of truth for that set: the parser accepts exactly these, and
 * `server/auth.ts` grants exactly these. Before PR #4285 the two had drifted —
 * the parser accepted `document` while the session only ever allowed
 * `${organizationId}:artifact:*`, so a legacy room parsed cleanly, returned 200,
 * and handed back a token with no permission for the room it was minted for
 * (reviewer wongk).
 */
export const RoomNamespace = {
  Artifact: "artifact",
  /** Pre-rename rooms. Immutable IDs, so this arm is permanent. */
  Document: "document",
} as const;
export type RoomNamespace = (typeof RoomNamespace)[keyof typeof RoomNamespace];

/** Every namespace a room ID may carry, in one place for parser and auth. */
export const ROOM_NAMESPACES: readonly RoomNamespace[] =
  Object.values(RoomNamespace);

export function generateDocumentRoomId(
  organizationId: string,
  slug: string
): string {
  // Keep "artifact" segment in room IDs — Liveblocks room IDs are immutable
  // and constructed on every access, so changing this would break all existing rooms.
  return `${organizationId}:${RoomNamespace.Artifact}:${slug}`;
}

export function parseDocumentRoomId(roomId: string): {
  organizationId: string;
  slug: string;
} {
  const parts = roomId.split(":");

  if (
    parts.length !== 3 ||
    !ROOM_NAMESPACES.some((namespace) => namespace === parts[1])
  ) {
    throw new Error("Invalid room ID format");
  }

  return {
    organizationId: parts[0],
    slug: parts[2],
  };
}

/**
 * @deprecated Use `parseDocumentRoomId` instead.
 */
export const parseArtifactRoomId = parseDocumentRoomId;
