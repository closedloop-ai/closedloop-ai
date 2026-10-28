import {
  ROOM_NAMESPACES as CONTRACT_ROOM_NAMESPACES,
  RoomNamespace as ContractRoomNamespace,
  generateDocumentRoomId as contractGenerateDocumentRoomId,
  parseDocumentRoomId as contractParseDocumentRoomId,
} from "@repo/realtime-contract/document-room";
import { describe, expect, it } from "vitest";

import {
  generateDocumentRoomId,
  parseArtifactRoomId,
  parseDocumentRoomId,
  ROOM_NAMESPACES,
  RoomNamespace,
} from "../shared/room-utils";

// The parse/generate contract is pinned beside its owner,
// `@repo/realtime-contract`'s document-room.test.ts. This path re-exports it
// for its existing importers (ISS-12502).
describe("room-utils", () => {
  it("re-exports the room-id helpers of @repo/realtime-contract", () => {
    expect(generateDocumentRoomId).toBe(contractGenerateDocumentRoomId);
    expect(parseDocumentRoomId).toBe(contractParseDocumentRoomId);
    expect(ROOM_NAMESPACES).toBe(CONTRACT_ROOM_NAMESPACES);
    expect(RoomNamespace).toBe(ContractRoomNamespace);
  });

  it("keeps parseArtifactRoomId as the deprecated alias for parseDocumentRoomId", () => {
    expect(parseArtifactRoomId).toBe(contractParseDocumentRoomId);
  });
});
