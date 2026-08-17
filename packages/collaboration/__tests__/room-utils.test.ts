import { describe, expect, it } from "vitest";

import {
  generateDocumentRoomId,
  parseArtifactRoomId,
  parseDocumentRoomId,
  ROOM_NAMESPACES,
  RoomNamespace,
} from "../shared/room-utils";

/**
 * Room IDs are a trust boundary: `apps/api/app/collaboration/auth/route.ts`
 * parses a client-supplied room ID and derives the organization it authorizes
 * against, so malformed input is reachable at runtime and must be rejected
 * rather than narrowed by types. Consumers mock this module, so its own
 * parse/generate contract is pinned here.
 */
describe("generateDocumentRoomId", () => {
  it("builds the immutable org:artifact:slug shape", () => {
    expect(generateDocumentRoomId("org_123", "PRD-1")).toBe(
      "org_123:artifact:PRD-1"
    );
  });

  it("round-trips through parseDocumentRoomId", () => {
    expect(
      parseDocumentRoomId(generateDocumentRoomId("org_123", "ISS-9"))
    ).toEqual({ organizationId: "org_123", slug: "ISS-9" });
  });
});

describe("parseDocumentRoomId", () => {
  it("parses the current artifact segment", () => {
    expect(parseDocumentRoomId("org_123:artifact:PRD-1")).toEqual({
      organizationId: "org_123",
      slug: "PRD-1",
    });
  });

  it("still parses the legacy document segment", () => {
    // Existing Liveblocks rooms created before the artifact rename keep their
    // immutable IDs, so this compatibility arm must stay accepted. Accepting it
    // here is only half the contract: `server/auth.ts` must also GRANT the
    // namespace, or the room parses, authorizes with a 200, and hands back a
    // token with no permission for it (PR #4285 reviewer wongk). Both sides now
    // read ROOM_NAMESPACES, and auth.test.ts pins the grant.
    expect(parseDocumentRoomId("org_123:document:PRD-1")).toEqual({
      organizationId: "org_123",
      slug: "PRD-1",
    });
  });

  it("accepts exactly the namespaces the auth grant covers", () => {
    // The parser and the session grant are one contract; pinning the accepted
    // set here and asserting the same set in auth.test.ts is what keeps a new
    // namespace from being parseable but unauthorized.
    for (const namespace of ROOM_NAMESPACES) {
      expect(parseDocumentRoomId(`org_123:${namespace}:PRD-1`)).toEqual({
        organizationId: "org_123",
        slug: "PRD-1",
      });
    }
    expect(ROOM_NAMESPACES).toContain(RoomNamespace.Artifact);
    expect(ROOM_NAMESPACES).toContain(RoomNamespace.Document);
  });

  it("rejects an unknown middle segment", () => {
    expect(() => parseDocumentRoomId("org_123:project:PRD-1")).toThrow(
      "Invalid room ID format"
    );
  });

  it("rejects a room ID with too few segments", () => {
    expect(() => parseDocumentRoomId("org_123:artifact")).toThrow(
      "Invalid room ID format"
    );
    expect(() => parseDocumentRoomId("org_123")).toThrow(
      "Invalid room ID format"
    );
  });

  it("rejects a room ID with extra segments rather than silently truncating", () => {
    // A colon in the slug would otherwise let a caller shift which segment is
    // read as the organization id.
    expect(() => parseDocumentRoomId("org_123:artifact:PRD-1:extra")).toThrow(
      "Invalid room ID format"
    );
  });

  it("rejects an empty room ID", () => {
    expect(() => parseDocumentRoomId("")).toThrow("Invalid room ID format");
  });

  it("preserves empty segments that satisfy the shape so callers see them as-is", () => {
    // The parser is shape-only; it does not vouch for a non-empty org id. The
    // auth route is what must reject an empty organization, and this pins that
    // parseDocumentRoomId does not quietly invent one.
    expect(parseDocumentRoomId(":artifact:PRD-1")).toEqual({
      organizationId: "",
      slug: "PRD-1",
    });
  });
});

describe("parseArtifactRoomId", () => {
  it("is the deprecated alias for parseDocumentRoomId", () => {
    expect(parseArtifactRoomId).toBe(parseDocumentRoomId);
  });
});
