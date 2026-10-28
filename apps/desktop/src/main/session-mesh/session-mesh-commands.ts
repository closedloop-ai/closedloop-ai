import {
  type SessionMeshPresenceInput,
  sessionMeshDeliveryDispositionValidator,
  sessionMeshFeedbackValidator,
  sessionMeshPublishValidator,
  sessionMeshSubscriptionValidator,
} from "@repo/api/src/types/session-mesh";
import { z } from "zod";

export const meshCommandValidator = z.object({
  operation: z.enum([
    "list",
    "fetch",
    "publish",
    "reply",
    "ack",
    "hold",
    "dismiss",
    "mute",
    "refuse",
    "subscribe",
    "unsubscribe",
    "context",
    "feedback",
  ]),
  agentId: z.string().min(1).max(500),
  payload: z.record(z.string(), z.unknown()).default({}),
});

function contextRequestPath(
  payload: Record<string, unknown>,
  presence: SessionMeshPresenceInput
): string {
  const query = z
    .object({
      cursor: z.string().trim().min(1).max(500).optional(),
      inboxCursor: z.string().uuid().optional(),
    })
    .parse(payload);
  const search = new URLSearchParams({
    agentId: presence.agentId,
    repository: presence.workspace.repository,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.inboxCursor ? { inboxCursor: query.inboxCursor } : {}),
  });
  return `/session-mesh/related?${search}`;
}

/** Explicit model actions, unlike lifecycle hooks, may await the cloud. */
export function executeMeshCommand(
  command: z.infer<typeof meshCommandValidator>,
  presence: SessionMeshPresenceInput,
  request: (endpoint: string, body?: unknown) => Promise<unknown>
): Promise<unknown> {
  const { operation, payload } = command;
  const agentId = presence.agentId;
  switch (operation) {
    case "list": {
      const query = z
        .object({
          cursor: z.string().trim().min(1).max(500).optional(),
          repository: z.string().trim().min(1).max(500).optional(),
        })
        .parse(payload);
      const search = new URLSearchParams();
      if (query.cursor) {
        search.set("cursor", query.cursor);
      }
      if (query.repository) {
        search.set("repository", query.repository);
      }
      return request(
        `/session-mesh/presence${search.size ? `?${search}` : ""}`
      );
    }
    case "context":
      return request(contextRequestPath(payload, presence));
    case "feedback":
      return request(
        "/session-mesh/feedback",
        sessionMeshFeedbackValidator.parse({ ...payload, agentId })
      );
    case "fetch":
      if (payload.messageId !== undefined) {
        const messageId = z.string().uuid().parse(payload.messageId);
        return request(
          `/session-mesh/messages?agentId=${encodeURIComponent(agentId)}&messageId=${encodeURIComponent(messageId)}`
        );
      }
      return request(
        `/session-mesh/inbox?agentId=${encodeURIComponent(agentId)}`
      );
    case "publish":
    case "reply": {
      if (operation === "reply") {
        z.object({
          replyToMessageId: z.string().uuid(),
          recipientAgentIds: z.array(z.string().min(1)).min(1),
        }).parse(payload);
      }
      return request(
        "/session-mesh/messages",
        sessionMeshPublishValidator.parse({
          ...payload,
          kind: operation === "reply" ? "reply" : payload.kind,
          idempotencyKey: payload.idempotencyKey,
          authorAgentId: agentId,
          workspace: presence.workspace,
          lineage: payload.lineage ?? presence.lineage,
        })
      );
    }
    case "ack":
    case "hold":
    case "dismiss":
    case "refuse":
      return request(
        "/session-mesh/inbox/disposition",
        sessionMeshDeliveryDispositionValidator.parse({
          ...payload,
          agentId,
          status: {
            ack: "acknowledged",
            hold: "held",
            dismiss: "dismissed",
            refuse: "refused",
          }[operation],
        })
      );
    case "mute":
    case "subscribe":
    case "unsubscribe":
      return request(
        "/session-mesh/subscriptions",
        sessionMeshSubscriptionValidator.parse({
          ...payload,
          repository: presence.workspace.repository,
          ...(operation === "subscribe" ? { muted: false } : {}),
          ...(operation === "unsubscribe" ? { muted: true } : {}),
        })
      );
    default:
      throw new Error("Unsupported Session Mesh command");
  }
}
