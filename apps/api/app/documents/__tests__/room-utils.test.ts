import { DocumentType } from "@repo/api/src/types/document";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { log } from "@repo/observability/log";
import { ChannelKind } from "@repo/realtime-contract/channels";
import { DocumentVersionSignalType } from "@repo/realtime-contract/signals";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOC_SYNC_DELETE_FAILED_EVENT } from "@/app/doc-sync/internal/delete-state";

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

const mockDocSyncDeleteDocument = vi.fn();
const mockWaitUntil = vi.fn();

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => mockWaitUntil(promise),
}));

vi.mock("@/app/doc-sync/internal/internal-client", () => ({
  docSyncInternalClient: () => ({
    deleteDocument: (...args: unknown[]) => mockDocSyncDeleteDocument(...args),
  }),
}));

const mockPublishVersionToLiveDocument = vi.fn();
const mockEmitSignal = vi.fn();

vi.mock("@/app/doc-sync/internal/seed-state", () => ({
  publishVersionToLiveDocument: (...args: unknown[]) =>
    mockPublishVersionToLiveDocument(...args),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) => fn({}),
}));

vi.mock("@repo/realtime-server/emit-signal", () => ({
  emitSignal: (...args: unknown[]) => mockEmitSignal(...args),
}));

const { deleteDocumentRoom, resetDocumentRoom } = await import("../room-utils");

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CONTENT = "# Published";

const baseDocument = {
  id: "doc-1",
  organizationId: ORG_ID,
  slug: "PRD-42",
  type: DocumentType.Prd,
  latestVersion: 3,
};

describe("resetDocumentRoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    mockResetLiveblocksRoom.mockResolvedValue({ success: true });
    mockUpdateLiveblocksRoomMetadata.mockResolvedValue({ success: true });
    mockBroadcastLiveblocksRoomEvent.mockResolvedValue({ success: true });
    mockPublishVersionToLiveDocument.mockResolvedValue({
      ok: true,
      value: { applied: true, stale: false, updateBytes: 10 },
    });
    mockEmitSignal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the doc-sync document with the content and version", async () => {
    await resetDocumentRoom(baseDocument, "user-1", CONTENT);

    expect(mockPublishVersionToLiveDocument).toHaveBeenCalledWith({
      document: baseDocument,
      content: CONTENT,
      version: 3,
    });
  });

  it("still runs the seed when the Liveblocks reset rejects, signals, then rethrows", async () => {
    const boom = new Error("liveblocks down");
    mockResetLiveblocksRoom.mockRejectedValue(boom);

    await expect(
      resetDocumentRoom(baseDocument, "user-1", CONTENT)
    ).rejects.toBe(boom);
    expect(mockPublishVersionToLiveDocument).toHaveBeenCalledTimes(1);
    expect(mockEmitSignal).toHaveBeenCalledTimes(1);
  });

  it("still runs the Liveblocks reset when the seed rejects", async () => {
    mockPublishVersionToLiveDocument.mockRejectedValue(new Error("seed"));

    await expect(
      resetDocumentRoom(baseDocument, "user-1", CONTENT)
    ).rejects.toThrow("seed");
    expect(mockBroadcastLiveblocksRoomEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitSignal).toHaveBeenCalledTimes(1);
  });

  it("signals only after both transports have settled, including a failed seed", async () => {
    const events: string[] = [];
    let finishSeed: (result: unknown) => void = () => undefined;
    mockPublishVersionToLiveDocument.mockReturnValue(
      new Promise((resolve) => {
        finishSeed = (result) => {
          events.push("seed");
          resolve(result);
        };
      })
    );
    mockBroadcastLiveblocksRoomEvent.mockImplementation(() => {
      events.push("liveblocks");
      return Promise.resolve({ success: true });
    });
    mockEmitSignal.mockImplementation(() => {
      events.push("signal");
      return Promise.resolve();
    });

    const reset = resetDocumentRoom(baseDocument, "user-1", CONTENT);
    await vi.waitFor(() => expect(events).toEqual(["liveblocks"]));
    finishSeed({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 503,
    });
    await reset;

    expect(events).toEqual(["liveblocks", "seed", "signal"]);
    expect(mockEmitSignal).toHaveBeenCalledWith(
      expect.anything(),
      `${ChannelKind.DocumentVersions}:${ORG_ID}:doc-1`,
      { type: DocumentVersionSignalType.Published, data: { version: 3 } }
    );
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

    await resetDocumentRoom(baseDocument, "user-1", CONTENT);

    expect(callOrder).toEqual(["reset", "metadata", "broadcast"]);
  });

  it("derives the room id from organization id + slug for all three calls", async () => {
    await resetDocumentRoom(baseDocument, "user-1", CONTENT);

    const expectedRoomId = `${ORG_ID}:artifact:PRD-42`;
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
    await resetDocumentRoom(baseDocument, null, CONTENT);

    expect(mockBroadcastLiveblocksRoomEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: RoomEventType.DocumentVersionPublished,
        publisherId: null,
      })
    );
  });

  it("stamps publishedAt as a valid ISO timestamp", async () => {
    await resetDocumentRoom(baseDocument, "user-1", CONTENT);

    const broadcastCall = mockBroadcastLiveblocksRoomEvent.mock.calls[0];
    const payload = broadcastCall[1] as { publishedAt: string };
    expect(new Date(payload.publishedAt).toISOString()).toBe(
      payload.publishedAt
    );
  });
});

describe("deleteDocumentRoom", () => {
  const expectedRoomId = "org-1:artifact:PRD-42";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    mockDeleteLiveblocksRoom.mockResolvedValue({ success: true });
    mockDocSyncDeleteDocument.mockResolvedValue({
      ok: true,
      value: { deleted: true, wasLoaded: false },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function backgroundWork() {
    await Promise.all(mockWaitUntil.mock.calls.map(([promise]) => promise));
  }

  function docSyncDeleteFailures() {
    return vi
      .mocked(log.error)
      .mock.calls.filter(
        ([, fields]) =>
          (fields as { event?: string } | undefined)?.event ===
          DOC_SYNC_DELETE_FAILED_EVENT
      );
  }

  it("deletes the Liveblocks room and the doc-sync document under one room id", async () => {
    await deleteDocumentRoom("org-1", "PRD-42");
    await backgroundWork();

    expect(mockDeleteLiveblocksRoom).toHaveBeenCalledWith(expectedRoomId);
    expect(mockDocSyncDeleteDocument).toHaveBeenCalledWith(expectedRoomId);
    expect(docSyncDeleteFailures()).toEqual([]);
  });

  it("returns without waiting on the doc-sync delete, which runs under waitUntil", async () => {
    let finishDocSyncDelete: (result: unknown) => void = () => undefined;
    mockDocSyncDeleteDocument.mockReturnValue(
      new Promise((resolve) => {
        finishDocSyncDelete = resolve;
      })
    );

    await deleteDocumentRoom("org-1", "PRD-42");

    expect(mockDeleteLiveblocksRoom).toHaveBeenCalledWith(expectedRoomId);
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    finishDocSyncDelete({
      ok: true,
      value: { deleted: true, wasLoaded: true },
    });
    await backgroundWork();
  });

  it("logs one doc_sync.delete_failed on a rejected doc-sync delete and still resolves", async () => {
    mockDocSyncDeleteDocument.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 503,
    });

    await expect(
      deleteDocumentRoom("org-1", "PRD-42")
    ).resolves.toBeUndefined();
    await backgroundWork();

    expect(docSyncDeleteFailures()).toEqual([
      [
        expect.any(String),
        {
          event: DOC_SYNC_DELETE_FAILED_EVENT,
          roomId: expectedRoomId,
          failure: InternalCallFailure.Rejected,
          status: 503,
        },
      ],
    ]);
  });

  it("still runs the doc-sync delete when the Liveblocks delete fails", async () => {
    mockDeleteLiveblocksRoom.mockResolvedValue({
      success: false,
      error: "liveblocks down",
    });

    await expect(
      deleteDocumentRoom("org-1", "PRD-42")
    ).resolves.toBeUndefined();

    expect(mockDocSyncDeleteDocument).toHaveBeenCalledWith(expectedRoomId);
  });

  it("logs no error when doc-sync is not configured", async () => {
    mockDocSyncDeleteDocument.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.NotConfigured,
    });

    await deleteDocumentRoom("org-1", "PRD-42");
    await backgroundWork();

    expect(docSyncDeleteFailures()).toEqual([]);
  });
});
