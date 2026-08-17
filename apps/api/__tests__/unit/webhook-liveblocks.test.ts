import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/collaboration/server/webhook", () => ({
  createWebhookHandler: vi.fn(),
  getLiveblocksApiClient: vi.fn(),
}));

vi.mock("@repo/collaboration/server/room-management", () => ({
  markArtifactThreadResolved: vi.fn().mockResolvedValue(undefined),
  markArtifactThreadUnresolved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@repo/collaboration/shared/room-utils", () => {
  const parseArtifactRoomId = vi.fn();
  // service.ts and webhook handlers import parseDocumentRoomId; tests stub
  // parseArtifactRoomId (the legacy alias) — point both at the same vi.fn()
  // so service-internal lookups resolve via the test's mock state.
  return {
    parseArtifactRoomId,
    parseDocumentRoomId: parseArtifactRoomId,
    generateDocumentRoomId: vi.fn(),
  };
});

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    JsonNull: "DbNull",
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

import {
  markArtifactThreadResolved,
  markArtifactThreadUnresolved,
} from "@repo/collaboration/server/room-management";
import {
  createWebhookHandler,
  getLiveblocksApiClient,
} from "@repo/collaboration/server/webhook";
import { parseArtifactRoomId } from "@repo/collaboration/shared/room-utils";
import { log } from "@repo/observability/log";
import {
  handleCommentCreated,
  handleCommentDeleted,
  handleThreadCreated,
  handleThreadResolved,
  handleThreadUnresolved,
} from "@/app/webhooks/liveblocks/handlers";
import { POST } from "@/app/webhooks/liveblocks/route";

const ORG_ID = "org-123";
const ROOM_ID = `${ORG_ID}:artifact:my-artifact`;
// The resolve/unresolve fixtures fire events at this instant. The provider
// thread's `updatedAt` is pinned to the same instant for the legitimate
// (non-superseded) cases so the handler's staleness guard
// (`isSupersededEvent`) does not treat the event as stale; superseded-replay
// tests deliberately advance the provider clock past this instant.
const EVENT_UPDATED_AT = "2025-06-01T00:00:00Z";

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
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[webhook/liveblocks] Event handled",
      {
        eventType: "threadCreated",
        outcome: "processed",
        provider: "liveblocks",
      }
    );
  });

  it("returns 200 for unhandled event types", async () => {
    const event = { type: "storageUpdated", data: { roomId: "room-1" } };
    const mockHandler = { verifyRequest: vi.fn().mockReturnValue(event) };
    vi.mocked(createWebhookHandler).mockReturnValue(mockHandler as never);

    const response = await POST(makeRequest(JSON.stringify(event)));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[webhook/liveblocks] Event handled",
      {
        eventType: "storageUpdated",
        outcome: "unsupported_event",
        provider: "liveblocks",
      }
    );
  });
});

describe("Liveblocks webhook handlers", () => {
  beforeEach(() => {
    // resetAllMocks (vs clearAllMocks) also clears mockImplementations so
    // mockWithDbCall set up by one test doesn't leak into siblings.
    vi.resetAllMocks();
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

    it("upserts the thread row using metadata.version from the webhook payload", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const upsertSpy = vi.fn().mockResolvedValue({ id: "db-th-1" });
      const mockDb = {
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "artifact-1",
            document: { latestVersion: 4 },
          }),
        },
        commentThread: { upsert: upsertSpy },
      };
      mockWithDbCall(mockDb);

      const mockClient = {
        getThread: vi.fn().mockResolvedValue({
          id: "th_1",
          roomId: ROOM_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
          resolved: false,
          metadata: { version: 2 },
          comments: [],
        }),
      };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      await handleThreadCreated({
        type: "threadCreated",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          createdAt: "2025-01-01T00:00:00Z",
          createdBy: "user-1",
        },
      });

      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ createdAtVersion: 2 }),
        })
      );
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
    it("resolves thread with updatedAt timestamp and resolver attribution when the actor is the author", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(EVENT_UPDATED_AT),
        resolved: true,
        metadata: {},
        comments: [{ userId: "user-1" }],
      };
      const mockClient = {
        getThread: vi.fn().mockResolvedValue(mockThread),
      };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          // Satisfies both getThreadAuthorship (createdById/comments) and
          // resolveThread (status/resolvedAt/resolvedById/metadata). The actor
          // "user-1" IS the author (and only participant), so the resolve is
          // allowed and the reject branch never runs.
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "OPEN",
            resolvedAt: null,
            resolvedById: null,
            metadata: {},
            createdById: "user-1",
            comments: [{ authorId: "user-1" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);
      // resolveThread now runs its read-mutate-write inside withDb.tx, so the
      // transactional callback must be wired to the same mock db as well.
      mockWithDbTx(mockDb);

      await handleThreadResolved({
        type: "threadMarkedAsResolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "user-1",
        },
      });

      expect(mockClient.getThread).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        threadId: "th_1",
      });
      expect(mockDb.commentThread.upsert).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "RESOLVED",
            resolvedById: "user-1",
          }),
        })
      );
    });

    it("rejects a non-participant resolve — reopens at Liveblocks and projects unresolved (FEA-4092 authz)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(EVENT_UPDATED_AT),
        resolved: true,
        metadata: {},
        comments: [{ userId: "author-1" }],
      };
      const mockClient = {
        getThread: vi.fn().mockResolvedValue(mockThread),
      };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "OPEN" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          // Author + only participant is "author-1"; the resolving actor below is
          // "attacker-2", who never commented, so it is neither author nor
          // participant and the resolve is rejected.
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolvedById: null,
            metadata: {},
            createdById: "author-1",
            comments: [{ authorId: "author-1" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadResolved({
        type: "threadMarkedAsResolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "attacker-2",
        },
      });

      // Source of truth (Liveblocks) is reverted to unresolved.
      expect(markArtifactThreadUnresolved).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        threadId: "th_1",
        userId: "author-1",
      });
      // Local projection is set OPEN (unresolve), never RESOLVED, for this event.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "OPEN" }),
        })
      );
    });

    it("allows a non-author participant (replier) resolve — projects resolved, does not reopen (FEA-4092)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(EVENT_UPDATED_AT),
        resolved: true,
        metadata: {},
        comments: [{ userId: "author-1" }, { userId: "replier-2" }],
      };
      const mockClient = {
        getThread: vi.fn().mockResolvedValue(mockThread),
      };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          // Author is "author-1"; "replier-2" authored a reply, so it is a
          // participant and may resolve even though it did not create the thread.
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "OPEN",
            resolvedAt: null,
            resolvedById: null,
            metadata: {},
            createdById: "author-1",
            comments: [{ authorId: "author-1" }, { authorId: "replier-2" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadResolved({
        type: "threadMarkedAsResolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "replier-2",
        },
      });

      // The participant resolve is NOT reverted at Liveblocks.
      expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
      // Local projection is set RESOLVED, attributed to the resolving participant.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "RESOLVED",
            resolvedById: "replier-2",
          }),
        })
      );
    });

    it("mirrors provider unresolved state on a stale resolve delivered out of order", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      // Provider is UNRESOLVED as of this fetch (a later unresolve already won);
      // the resolve event is stale.
      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolved: false,
        metadata: {},
        comments: [],
      };
      const mockClient = { getThread: vi.fn().mockResolvedValue(mockThread) };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "OPEN" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolvedById: "user-1",
            metadata: {},
            createdById: "user-1",
            comments: [{ authorId: "user-1" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

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

      // Never touches the author-check / resolve path; projects OPEN to match
      // the provider and never resolves.
      expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "OPEN" }),
        })
      );
    });

    it("allows a replier whose comment is only in the provider payload, not yet projected (FEA-4092 projection-lag)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      // Provider payload already carries the replier's comment, but the DB
      // projection lags (only the author's comment landed). The union of the two
      // must count "replier-2" as a participant so their resolve is NOT reopened.
      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(EVENT_UPDATED_AT),
        resolved: true,
        metadata: {},
        comments: [{ userId: "author-1" }, { userId: "replier-2" }],
      };
      const mockClient = { getThread: vi.fn().mockResolvedValue(mockThread) };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          // DB projection is missing replier-2's comment (webhook lag).
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "OPEN",
            resolvedAt: null,
            resolvedById: null,
            metadata: {},
            createdById: "author-1",
            comments: [{ authorId: "author-1" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadResolved({
        type: "threadMarkedAsResolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "replier-2",
        },
      });

      // The provider-only replier is a valid participant → resolve stands.
      expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "RESOLVED",
            resolvedById: "replier-2",
          }),
        })
      );
    });

    it("does not authorize a superseded resolve event — mirrors current resolved state, never reopens (FEA-4092 replay)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      // resolve(attacker) → unresolve(author) → resolve(participant): the first
      // (attacker) event arrives last. Provider is resolved (participant's win),
      // its updatedAt is NEWER than this stale attacker event. The handler must
      // skip actor authorization and keep the thread resolved, not reopen it.
      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date("2025-06-02T00:00:00Z"),
        resolved: true,
        metadata: {},
        comments: [{ userId: "author-1" }, { userId: "participant-3" }],
      };
      const mockClient = { getThread: vi.fn().mockResolvedValue(mockThread) };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolvedById: "participant-3",
            metadata: {},
            createdById: "author-1",
            comments: [{ authorId: "author-1" }, { authorId: "participant-3" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadResolved({
        type: "threadMarkedAsResolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          // Stale event: older than the provider's current updatedAt above.
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "attacker-2",
        },
      });

      // The stale attacker actor is never authorized; the participant's valid
      // resolution is preserved and no reopen is attempted. The provider is
      // already RESOLVED, so mirroring it is an idempotent no-op — the key
      // guarantee is that the thread is never projected OPEN (reopened) and the
      // Liveblocks reopen is never called.
      expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "OPEN" }),
        })
      );
    });
  });

  describe("handleThreadUnresolved", () => {
    it("mirrors provider resolved state on a stale unresolve delivered out of order", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      // Provider is RESOLVED as of this fetch (a later resolve already won); the
      // unresolve event is stale.
      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date("2025-06-02T00:00:00Z"),
        resolved: true,
        metadata: {},
        comments: [],
      };
      const mockClient = { getThread: vi.fn().mockResolvedValue(mockThread) };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "OPEN",
            resolvedAt: null,
            resolvedById: null,
            metadata: {},
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadUnresolved({
        type: "threadMarkedAsUnresolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: "2025-06-01T00:00:00Z",
          updatedBy: "user-1",
        },
      });

      // Projects RESOLVED to match the provider instead of applying the stale
      // unresolve.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "RESOLVED" }),
        })
      );
    });

    it("rejects a non-author reopen — re-resolves at Liveblocks and projects resolved (author-only reopen authz)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      // Provider is unresolved (the SDK reopen landed), event is current. Reopen
      // is AUTHOR-ONLY; "replier-2" is a participant but not the author, so the
      // reopen is reverted and the thread is re-resolved.
      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(EVENT_UPDATED_AT),
        resolved: false,
        metadata: {},
        comments: [{ userId: "author-1" }, { userId: "replier-2" }],
      };
      const mockClient = { getThread: vi.fn().mockResolvedValue(mockThread) };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "RESOLVED" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "OPEN",
            resolvedAt: null,
            resolvedById: null,
            metadata: {},
            createdById: "author-1",
            comments: [{ authorId: "author-1" }, { authorId: "replier-2" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadUnresolved({
        type: "threadMarkedAsUnresolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "replier-2",
        },
      });

      // Source of truth (Liveblocks) is re-resolved, attributed to the author.
      expect(markArtifactThreadResolved).toHaveBeenCalledWith({
        roomId: ROOM_ID,
        threadId: "th_1",
        userId: "author-1",
      });
      // Local projection is set RESOLVED, never OPEN, for this illegitimate reopen.
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "RESOLVED" }),
        })
      );
    });

    it("allows the author to reopen — projects open, does not re-resolve (author-only reopen authz)", async () => {
      vi.mocked(parseArtifactRoomId).mockReturnValue({
        organizationId: ORG_ID,
        slug: "my-artifact",
      });

      const mockThread = {
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(EVENT_UPDATED_AT),
        resolved: false,
        metadata: {},
        comments: [{ userId: "author-1" }],
      };
      const mockClient = { getThread: vi.fn().mockResolvedValue(mockThread) };
      vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);

      const updateSpy = vi
        .fn()
        .mockResolvedValue({ id: "db-th-1", status: "OPEN" });
      const mockDb = {
        commentThread: {
          upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolvedById: "author-1",
            metadata: {},
            createdById: "author-1",
            comments: [{ authorId: "author-1" }],
          }),
          update: updateSpy,
        },
        $queryRaw: vi.fn().mockResolvedValue([]),
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);
      mockWithDbTx(mockDb);

      await handleThreadUnresolved({
        type: "threadMarkedAsUnresolved",
        data: {
          projectId: "proj-1",
          roomId: ROOM_ID,
          threadId: "th_1",
          updatedAt: EVENT_UPDATED_AT,
          updatedBy: "author-1",
        },
      });

      // The author's reopen stands: not reverted, projected OPEN.
      expect(markArtifactThreadResolved).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "OPEN" }),
        })
      );
    });
  });
});
