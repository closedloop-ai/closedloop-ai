import { DocumentType } from "@repo/api/src/types/document";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResetLiveblocksRoom = vi.fn();
const mockUpdateLiveblocksRoomMetadata = vi.fn();
const mockBroadcastLiveblocksRoomEvent = vi.fn();
const mockCreateLiveblocksRoom = vi.fn();
const mockDeleteLiveblocksRoom = vi.fn();

vi.mock("@/lib/liveblocks", () => ({
  resetLiveblocksRoom: (...args: unknown[]) => mockResetLiveblocksRoom(...args),
  updateLiveblocksRoomMetadata: (...args: unknown[]) =>
    mockUpdateLiveblocksRoomMetadata(...args),
  broadcastLiveblocksRoomEvent: (...args: unknown[]) =>
    mockBroadcastLiveblocksRoomEvent(...args),
  createLiveblocksRoom: (...args: unknown[]) =>
    mockCreateLiveblocksRoom(...args),
  deleteLiveblocksRoom: (...args: unknown[]) =>
    mockDeleteLiveblocksRoom(...args),
}));

const { resetDocumentRoom } = await import("../room-utils");

const baseDocument = {
  id: "doc-1",
  organizationId: "org-1",
  slug: "PRD-42",
  type: DocumentType.Prd,
  latestVersion: 3,
};

describe("resetDocumentRoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResetLiveblocksRoom.mockResolvedValue({ success: true });
    mockUpdateLiveblocksRoomMetadata.mockResolvedValue({ success: true });
    mockBroadcastLiveblocksRoomEvent.mockResolvedValue({ success: true });
  });

  it("resets the room, updates metadata, and broadcasts the publish event in order", async () => {
    const callOrder: string[] = [];
    mockResetLiveblocksRoom.mockImplementationOnce(() => {
      callOrder.push("reset");
      return Promise.resolve({ success: true });
    });
    mockUpdateLiveblocksRoomMetadata.mockImplementationOnce(() => {
      callOrder.push("metadata");
      return Promise.resolve({ success: true });
    });
    mockBroadcastLiveblocksRoomEvent.mockImplementationOnce(() => {
      callOrder.push("broadcast");
      return Promise.resolve({ success: true });
    });

    await resetDocumentRoom(baseDocument, "user-1");

    expect(callOrder).toEqual(["reset", "metadata", "broadcast"]);
  });

  it("derives the room id from organization id + slug for all three calls", async () => {
    await resetDocumentRoom(baseDocument, "user-1");

    const expectedRoomId = "org-1:artifact:PRD-42";
    expect(mockResetLiveblocksRoom).toHaveBeenCalledWith(expectedRoomId);
    expect(mockUpdateLiveblocksRoomMetadata).toHaveBeenCalledWith(
      expectedRoomId,
      expect.objectContaining({ documentId: "doc-1", version: "3" })
    );
    expect(mockBroadcastLiveblocksRoomEvent).toHaveBeenCalledWith(
      expectedRoomId,
      expect.objectContaining({
        type: RoomEventType.DocumentVersionPublished,
        version: 3,
        publisherId: "user-1",
      })
    );
  });

  it("broadcasts publisherId=null when no publisher is provided (system-driven)", async () => {
    await resetDocumentRoom(baseDocument);

    expect(mockBroadcastLiveblocksRoomEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: RoomEventType.DocumentVersionPublished,
        publisherId: null,
      })
    );
  });

  it("stamps publishedAt as a valid ISO timestamp", async () => {
    await resetDocumentRoom(baseDocument, "user-1");

    const broadcastCall = mockBroadcastLiveblocksRoomEvent.mock.calls[0];
    const payload = broadcastCall[1] as { publishedAt: string };
    expect(new Date(payload.publishedAt).toISOString()).toBe(
      payload.publishedAt
    );
  });
});
