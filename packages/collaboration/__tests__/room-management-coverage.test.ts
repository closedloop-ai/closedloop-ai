import { DocumentType } from "@repo/api/src/types/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastRoomEvent,
  createArtifactThread,
  createRoom,
  deleteArtifactComment,
  deleteRoom,
  resetRoom,
  updateRoomMetadata,
} from "../server/room-management";
import { RoomEventType } from "../shared/room-events";

const mocks = vi.hoisted(() => ({
  broadcastEvent: vi.fn(),
  clearContent: vi.fn(),
  createComment: vi.fn(),
  createThread: vi.fn(),
  deleteComment: vi.fn(),
  deleteRoom: vi.fn(),
  findAnchorText: vi.fn(),
  getOrCreateRoom: vi.fn(),
  markThreadAsResolved: vi.fn(),
  markThreadAsUnresolved: vi.fn(),
  updateRoom: vi.fn(),
  withProsemirrorDocument: vi.fn(),
}));

vi.mock("@liveblocks/node", () => {
  class MockLiveblocks {
    broadcastEvent = mocks.broadcastEvent;
    createComment = mocks.createComment;
    createThread = mocks.createThread;
    deleteComment = mocks.deleteComment;
    deleteRoom = mocks.deleteRoom;
    getOrCreateRoom = mocks.getOrCreateRoom;
    markThreadAsResolved = mocks.markThreadAsResolved;
    markThreadAsUnresolved = mocks.markThreadAsUnresolved;
    updateRoom = mocks.updateRoom;
  }

  return { Liveblocks: MockLiveblocks };
});

vi.mock("@liveblocks/node-prosemirror", () => ({
  withProsemirrorDocument: (...args: unknown[]) =>
    mocks.withProsemirrorDocument(...args),
}));

vi.mock("../server/yjs-anchor", () => ({
  anchorThreadToText: vi.fn(),
  findAnchorText: mocks.findAnchorText,
  isAnchorValidationError: () => false,
}));

vi.mock("../server/keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: "sk_test-secret-key" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withProsemirrorDocument.mockImplementation(
    async (_options: unknown, callback: (api: unknown) => Promise<unknown>) =>
      await callback({ clearContent: mocks.clearContent })
  );
});

afterEach(() => {
  vi.doUnmock("../server/keys");
});

describe("room lifecycle management", () => {
  it("creates a private tenant room with metadata and engine 2", async () => {
    mocks.getOrCreateRoom.mockResolvedValueOnce({ id: "room-1" });

    await expect(
      createRoom({
        metadata: { documentType: DocumentType.Prd },
        roomId: "org:artifact:PRD-1",
        tenantId: "org",
      })
    ).resolves.toEqual({ success: true });
    expect(mocks.getOrCreateRoom).toHaveBeenCalledWith("org:artifact:PRD-1", {
      defaultAccesses: [],
      engine: 2,
      metadata: { documentType: DocumentType.Prd },
      tenantId: "org",
    });
  });

  it("reports Error and non-Error room creation failures", async () => {
    mocks.getOrCreateRoom
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockRejectedValueOnce("provider throttled");

    await expect(
      createRoom({ roomId: "room-1", tenantId: "org" })
    ).resolves.toEqual({ error: "provider unavailable", success: false });
    await expect(
      createRoom({ roomId: "room-2", tenantId: "org" })
    ).resolves.toEqual({ error: "provider throttled", success: false });
  });

  it("clears the ProseMirror content for a configured reset", async () => {
    mocks.clearContent.mockResolvedValueOnce(undefined);

    await expect(resetRoom("room-1")).resolves.toEqual({ success: true });
    expect(mocks.withProsemirrorDocument).toHaveBeenCalledWith(
      { client: expect.any(Object), roomId: "room-1" },
      expect.any(Function)
    );
    expect(mocks.clearContent).toHaveBeenCalledOnce();
  });

  it("reports Error and non-Error reset failures", async () => {
    mocks.withProsemirrorDocument
      .mockRejectedValueOnce(new Error("clear failed"))
      .mockRejectedValueOnce("clear throttled");

    await expect(resetRoom("room-1")).resolves.toEqual({
      error: "clear failed",
      success: false,
    });
    await expect(resetRoom("room-2")).resolves.toEqual({
      error: "clear throttled",
      success: false,
    });
  });

  it("deletes a configured room and reports both error families", async () => {
    mocks.deleteRoom
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockRejectedValueOnce("delete throttled");

    await expect(deleteRoom("room-1")).resolves.toEqual({ success: true });
    await expect(deleteRoom("room-2")).resolves.toEqual({
      error: "delete failed",
      success: false,
    });
    await expect(deleteRoom("room-3")).resolves.toEqual({
      error: "delete throttled",
      success: false,
    });
    expect(mocks.deleteRoom).toHaveBeenNthCalledWith(1, "room-1");
  });

  it("updates metadata and reports both error families", async () => {
    const metadata = { obsoleteKey: null, title: "Updated" };
    mocks.updateRoom
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("update failed"))
      .mockRejectedValueOnce("update throttled");

    await expect(updateRoomMetadata("room-1", metadata)).resolves.toEqual({
      success: true,
    });
    await expect(updateRoomMetadata("room-2", metadata)).resolves.toEqual({
      error: "update failed",
      success: false,
    });
    await expect(updateRoomMetadata("room-3", metadata)).resolves.toEqual({
      error: "update throttled",
      success: false,
    });
    expect(mocks.updateRoom).toHaveBeenNthCalledWith(1, "room-1", {
      metadata,
    });
  });

  it("treats every lifecycle operation as successful when unconfigured", async () => {
    const roomManagement = await importUnconfiguredRoomManagement();

    await expect(
      roomManagement.createRoom({ roomId: "room-1", tenantId: "org" })
    ).resolves.toEqual({ success: true });
    await expect(roomManagement.resetRoom("room-1")).resolves.toEqual({
      success: true,
    });
    await expect(roomManagement.deleteRoom("room-1")).resolves.toEqual({
      success: true,
    });
    await expect(
      roomManagement.updateRoomMetadata("room-1", { title: "ignored" })
    ).resolves.toEqual({ success: true });
    expect(mocks.getOrCreateRoom).not.toHaveBeenCalled();
    expect(mocks.withProsemirrorDocument).not.toHaveBeenCalled();
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
    expect(mocks.updateRoom).not.toHaveBeenCalled();
  });
});

describe("artifact mutation edge cases", () => {
  it("wraps unstructured anchor lookup failures with their original cause", async () => {
    const providerError = new Error("Yjs fetch failed");
    mocks.findAnchorText.mockRejectedValueOnce(providerError);

    await expect(createAnchoredThread()).rejects.toMatchObject({
      cause: providerError,
      message: "Failed to validate anchor text",
    });

    mocks.findAnchorText.mockRejectedValueOnce(null);
    await expect(createAnchoredThread()).rejects.toMatchObject({
      cause: null,
      message: "Failed to validate anchor text",
    });
    expect(mocks.createThread).not.toHaveBeenCalled();
  });

  it("deletes only the selected comment", async () => {
    mocks.deleteComment.mockResolvedValueOnce(undefined);

    await deleteArtifactComment({
      commentId: "comment-1",
      roomId: "org:artifact:slug",
      threadId: "thread-1",
    });

    expect(mocks.deleteComment).toHaveBeenCalledWith({
      commentId: "comment-1",
      roomId: "org:artifact:slug",
      threadId: "thread-1",
    });
  });

  it("no-ops comment deletion when unconfigured", async () => {
    const roomManagement = await importUnconfiguredRoomManagement();

    await expect(
      roomManagement.deleteArtifactComment({
        commentId: "comment-1",
        roomId: "org:artifact:slug",
        threadId: "thread-1",
      })
    ).resolves.toBeUndefined();
    expect(mocks.deleteComment).not.toHaveBeenCalled();
  });

  it("stringifies non-Error broadcast failures", async () => {
    mocks.broadcastEvent.mockRejectedValueOnce("Liveblocks throttled");

    await expect(
      broadcastRoomEvent("org:artifact:slug", {
        type: RoomEventType.DocumentVersionPublished,
        version: 1,
        publisherId: null,
        publishedAt: "2026-05-26T18:00:00.000Z",
      })
    ).resolves.toEqual({
      success: false,
      error: "Liveblocks throttled",
    });
  });

  it("rejects reply and resolution writes when unconfigured", async () => {
    const roomManagement = await importUnconfiguredRoomManagement();
    const baseOptions = {
      roomId: "org:artifact:slug",
      threadId: "thread-1",
      userId: "user-1",
    };

    await expect(
      roomManagement.replyToArtifactThread({
        ...baseOptions,
        bodyText: "reply",
      })
    ).rejects.toThrow("LIVEBLOCKS_SECRET is not configured");
    await expect(
      roomManagement.markArtifactThreadResolved(baseOptions)
    ).rejects.toThrow("LIVEBLOCKS_SECRET is not configured");
    await expect(
      roomManagement.markArtifactThreadUnresolved(baseOptions)
    ).rejects.toThrow("LIVEBLOCKS_SECRET is not configured");
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.markThreadAsResolved).not.toHaveBeenCalled();
    expect(mocks.markThreadAsUnresolved).not.toHaveBeenCalled();
  });
});

function createAnchoredThread() {
  return createArtifactThread({
    anchorText: "some anchor text",
    bodyText: "Hello world",
    roomId: "org:artifact:slug",
    userId: "user-1",
  });
}

async function importUnconfiguredRoomManagement() {
  vi.resetModules();
  vi.doMock("../server/keys", () => ({
    keys: () => ({ LIVEBLOCKS_SECRET: undefined }),
  }));
  return await import("../server/room-management");
}
