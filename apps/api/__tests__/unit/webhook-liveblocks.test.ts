import { describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/collaboration/webhook", () => ({
  createWebhookHandler: vi.fn(),
  getLiveblocksApiClient: vi.fn(),
}));

vi.mock("@repo/collaboration/room-utils", () => ({
  parseArtifactRoomId: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

import { parseArtifactRoomId } from "@repo/collaboration/room-utils";
import {
  createWebhookHandler,
  getLiveblocksApiClient,
} from "@repo/collaboration/webhook";
import {
  handleCommentCreated,
  handleCommentDeleted,
  handleThreadCreated,
  handleThreadResolved,
} from "@/app/webhooks/liveblocks/handlers";
import { POST } from "@/app/webhooks/liveblocks/route";

const ORG_ID = "org-123";
const ROOM_ID = `${ORG_ID}:artifact:my-artifact`;

function makeRequest(body: string, headers?: Record<string, string>): Request {
  return new Request("http://localhost:3002/webhooks/liveblocks", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_123",
      "webhook-timestamp": "1614588800000",
      "webhook-signature": "v1,test",
      ...headers,
    },
  });
}

describe("Liveblocks webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when webhook not configured", async () => {
    vi.mocked(createWebhookHandler).mockReturnValue(null);

    const response = await POST(makeRequest("{}"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(false);
  });

  it("returns 401 when signature is invalid", async () => {
    const mockHandler = {
      verifyRequest: vi.fn().mockImplementation(() => {
        throw new Error("Invalid signature");
      }),
    };
    vi.mocked(createWebhookHandler).mockReturnValue(mockHandler as never);

    const response = await POST(makeRequest("{}"));
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.ok).toBe(false);
  });

  it("dispatches threadCreated event", async () => {
    const event = {
      type: "threadCreated" as const,
      data: {
        projectId: "proj-1",
        roomId: ROOM_ID,
        threadId: "th_1",
        createdAt: "2025-01-01T00:00:00Z",
        createdBy: "user-1",
      },
    };
    const mockHandler = { verifyRequest: vi.fn().mockReturnValue(event) };
    vi.mocked(createWebhookHandler).mockReturnValue(mockHandler as never);

    // Mock the handler dependencies
    vi.mocked(parseArtifactRoomId).mockReturnValue({
      organizationId: ORG_ID,
      slug: "my-artifact",
    });
    const mockClient = {
      getThread: vi.fn().mockResolvedValue({
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolved: false,
        metadata: {},
        comments: [],
      }),
    };
    vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

    const response = await POST(makeRequest(JSON.stringify(event)));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("returns 200 for unhandled event types", async () => {
    const event = { type: "storageUpdated", data: { roomId: "room-1" } };
    const mockHandler = { verifyRequest: vi.fn().mockReturnValue(event) };
    vi.mocked(createWebhookHandler).mockReturnValue(mockHandler as never);

    const response = await POST(makeRequest(JSON.stringify(event)));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

describe("Liveblocks webhook handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleThreadCreated", () => {
    it("skips non-artifact rooms", async () => {
      vi.mocked(parseArtifactRoomId).mockImplementation(() => {
        throw new Error("Invalid room ID format");
      });

      await handleThreadCreated({
        type: "threadCreated",
        data: {
          projectId: "proj-1",
          roomId: "some-other-room",
          threadId: "th_1",
          createdAt: "2025-01-01T00:00:00Z",
          createdBy: "user-1",
        },
      });

      expect(getLiveblocksApiClient).not.toHaveBeenCalled();
    });
  });

  describe("handleCommentCreated", () => {
    it("fetches thread first then comment (thread-first upsert)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolved: false,
        metadata: {},
        comments: [],
      };
      const mockComment = {
        id: "cm_1",
        threadId: "th_1",
        roomId: ROOM_ID,
        userId: "user-1",
        createdAt: new Date(),
        body: { version: 1, content: [] },
        reactions: [],
        attachments: [],
      };

      const mockClient = {
        getThread: vi.fn().mockResolvedValue(mockThread),
        getComment: vi.fn().mockResolvedValue(mockComment),
      };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      await handleCommentCreated({
        type: "commentCreated",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          commentId: "cm_1",
          createdAt: "2025-01-01T00:00:00Z",
          createdBy: "user-1",
        },
      });

      // Thread fetched first
      expect(mockClient.getThread).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        threadId: "th_1",
      });
      // Then comment
      expect(mockClient.getComment).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        threadId: "th_1",
        commentId: "cm_1",
      });
    });
  });

  describe("handleCommentDeleted", () => {
    it("skips non-artifact rooms", async () => {
      vi.mocked(parseArtifactRoomId).mockImplementation(() => {
        throw new Error("Invalid room ID format");
      });

      await handleCommentDeleted({
        type: "commentDeleted",
        data: {
          projectId: "proj-1",
          roomId: "some-other-room",
          threadId: "th_1",
          commentId: "cm_1",
          deletedAt: "2025-01-01T00:00:00Z",
        },
      });

      // No API client call, no service call
      expect(getLiveblocksApiClient).not.toHaveBeenCalled();
    });
  });

  describe("handleThreadResolved", () => {
    it("resolves thread with updatedAt timestamp", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolved: true,
        metadata: {},
        comments: [],
      };
      const mockClient = {
        getThread: vi.fn().mockResolvedValue(mockThread),
      };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          update: vi
            .fn()
            .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" }),
        },
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      await handleThreadResolved({
        type: "threadMarkedAsResolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: "2025-06-01T00:00:00Z",
          updatedBy: "user-1",
        },
      });

      expect(mockClient.getThread).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        threadId: "th_1",
      });
      expect(mockDb.commentThread.upsert).toHaveBeenCalled();
      expect(mockDb.commentThread.update).toHaveBeenCalled();
    });
  });
});
