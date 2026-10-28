import type { WebhookEvent } from "@repo/collaboration/server/webhook";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/collaboration/server/webhook", () => ({
  createWebhookHandler: vi.fn(),
  getLiveblocksApiClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/route-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-utils")>()),
  logRequestCompleted: vi.fn(),
  scheduleLogFlush: vi.fn(),
}));

vi.mock("@/app/webhooks/liveblocks/handlers", () => ({
  handleCommentCreated: vi.fn(),
  handleCommentDeleted: vi.fn(),
  handleCommentEdited: vi.fn(),
  handleCommentReactionAdded: vi.fn(),
  handleCommentReactionRemoved: vi.fn(),
  handleThreadCreated: vi.fn(),
  handleThreadDeleted: vi.fn(),
  handleThreadResolved: vi.fn(),
  handleThreadUnresolved: vi.fn(),
}));

import { createWebhookHandler } from "@repo/collaboration/server/webhook";
import { log } from "@repo/observability/log";
import {
  commentCreatedEvent,
  commentDeletedEvent,
  commentEditedEvent,
  commentReactionAddedEvent,
  commentReactionRemovedEvent,
  threadCreatedEvent,
  threadDeletedEvent,
  threadResolvedEvent,
  threadUnresolvedEvent,
} from "@/__tests__/support/webhooks/liveblocks/liveblocks-events.test-fixtures";
import {
  handleCommentCreated,
  handleCommentDeleted,
  handleCommentEdited,
  handleCommentReactionAdded,
  handleCommentReactionRemoved,
  handleThreadCreated,
  handleThreadDeleted,
  handleThreadResolved,
  handleThreadUnresolved,
} from "@/app/webhooks/liveblocks/handlers";
import { POST } from "@/app/webhooks/liveblocks/route";
import { LiveblocksWebhookOutcome } from "@/app/webhooks/liveblocks/webhook-outcome";

const handlers = {
  handleCommentCreated,
  handleCommentDeleted,
  handleCommentEdited,
  handleCommentReactionAdded,
  handleCommentReactionRemoved,
  handleThreadCreated,
  handleThreadDeleted,
  handleThreadResolved,
  handleThreadUnresolved,
};

type HandlerName = keyof typeof handlers;

const HANDLER_NAMES = Object.keys(handlers) as HandlerName[];

const DISPATCH_CASES: { event: WebhookEvent; handler: HandlerName }[] = [
  { event: threadCreatedEvent(), handler: "handleThreadCreated" },
  { event: commentCreatedEvent(), handler: "handleCommentCreated" },
  { event: commentEditedEvent(), handler: "handleCommentEdited" },
  { event: commentDeletedEvent(), handler: "handleCommentDeleted" },
  {
    event: commentReactionAddedEvent(),
    handler: "handleCommentReactionAdded",
  },
  {
    event: commentReactionRemovedEvent(),
    handler: "handleCommentReactionRemoved",
  },
  { event: threadDeletedEvent(), handler: "handleThreadDeleted" },
  { event: threadResolvedEvent(), handler: "handleThreadResolved" },
  { event: threadUnresolvedEvent(), handler: "handleThreadUnresolved" },
];

function makeRequest(event: WebhookEvent): Request {
  return new Request("http://localhost:3002/webhooks/liveblocks", {
    method: "POST",
    body: JSON.stringify(event),
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_123",
      "webhook-timestamp": "1614588800000",
      "webhook-signature": "v1,test",
    },
  });
}

describe("POST /webhooks/liveblocks dispatch", () => {
  beforeEach(() => {
    for (const name of HANDLER_NAMES) {
      vi.mocked(handlers[name]).mockResolvedValue(
        LiveblocksWebhookOutcome.Processed
      );
    }
  });

  it.each(DISPATCH_CASES)(
    "routes $event.type to $handler only and logs one processed outcome",
    async ({ event, handler }) => {
      const verifyRequest = vi.fn().mockReturnValue(event);
      vi.mocked(createWebhookHandler).mockReturnValue({
        verifyRequest,
      } as never);

      const response = await POST(makeRequest(event));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        message: "Event processed",
        ok: true,
      });
      expect(handlers[handler]).toHaveBeenCalledTimes(1);
      expect(handlers[handler]).toHaveBeenCalledWith(event);
      for (const other of HANDLER_NAMES.filter((name) => name !== handler)) {
        expect(handlers[other]).not.toHaveBeenCalled();
      }
      // pins current behavior; looks odd because ISS-8450 moved only the
      // GitHub route's processed log to `debug`, but the trimmed
      // webhooks/AGENTS.md Logging Conventions (#7943) now read as if every
      // provider logs a processed delivery at `debug`.
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        "[webhook/liveblocks] Event handled",
        {
          eventType: event.type,
          outcome: "processed",
          provider: "liveblocks",
        }
      );
    }
  );
});
