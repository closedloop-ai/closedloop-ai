import {
  generateDocumentRoomId,
  parseDocumentRoomId,
} from "@repo/realtime-contract/document-room";
import { z } from "zod";

export type CanonicalDocumentRoom = { organizationId: string; slug: string };

/**
 * `name` as a canonical document room id with a uuid organization, or `null`.
 * The app database's `organization_id` is a uuid column, so a query on any
 * other value fails rather than matching nothing.
 */
export function parseCanonicalDocumentRoom(
  name: string
): CanonicalDocumentRoom | null {
  let room: CanonicalDocumentRoom;
  try {
    room = parseDocumentRoomId(name);
  } catch {
    return null;
  }
  return ORGANIZATION_ID.safeParse(room.organizationId).success &&
    generateDocumentRoomId(room.organizationId, room.slug) === name
    ? room
    : null;
}

const ORGANIZATION_ID = z.guid();
