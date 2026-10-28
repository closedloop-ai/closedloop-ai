import {
  Result,
  type Result as ResultType,
  Status,
} from "@repo/api/src/types/result";
import type {
  SessionMeshDeliveryAckInput,
  SessionMeshFeedbackKind,
  SessionMeshInsights,
  SessionMeshPresenceInput,
  SessionMeshPublishInput,
  SessionMeshWorkspace,
} from "@repo/api/src/types/session-mesh";
import { type Prisma, withDb } from "@repo/database";
import {
  type RecordWriteInTransaction,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { sanitizeMeshContext, sanitizeMeshText } from "./content-safety";
import { FEEDBACK_EVENT_TYPE } from "./feedback-event-type";
import { boundedMeshPage } from "./service/bounded-page";
import { readDeliveryHistoryPage } from "./service/history";
import { readSessionMeshInsights } from "./service/insights";
import { resolvePullRequestHeadBranch } from "./service/pull-request-head-branch";
import { readRosterPage } from "./service/roster";

const NOW = () => new Date();
type MeshPublishResult = {
  message: { id: string };
  deliveries: number;
  idempotent: boolean;
};

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Relevance is deliberately conservative: repository identity is required,
 * then direct path/symbol/branch evidence upgrades a peer to interrupt-worthy. All matching
 * peers remain discoverable through the roster, but only those returned here
 * receive an immediate durable delivery.
 */
function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function lineageValue(
  value: Prisma.JsonValue,
  key: string
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function lineageStrings(value: Prisma.JsonValue, key: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
}

function relevanceFor(
  workspace: SessionMeshWorkspace,
  candidate: Pick<SessionMeshWorkspace, "paths" | "symbols"> & {
    lineage: Prisma.JsonValue;
  },
  lineage: Prisma.JsonValue,
  /** The named PR's head branch, from `resolvePullRequestHeadBranch`. */
  pullRequestHeadBranch?: string
): Record<string, unknown> | null {
  const pathOverlap = workspace.paths.filter((path) =>
    candidate.paths.includes(path)
  );
  const symbolOverlap = workspace.symbols.filter((symbol) =>
    candidate.symbols.includes(symbol)
  );
  const branch = lineageValue(lineage, "branch");
  const candidateBranch = lineageValue(candidate.lineage, "branch");
  const pullRequest = lineageValue(lineage, "pullRequest");
  const candidatePullRequest = lineageValue(candidate.lineage, "pullRequest");
  const artifactOverlap = lineageStrings(lineage, "artifactIds").filter((id) =>
    lineageStrings(candidate.lineage, "artifactIds").includes(id)
  );
  const blocksArtifacts = lineageStrings(lineage, "blocksArtifactIds").filter(
    (id) => lineageStrings(candidate.lineage, "artifactIds").includes(id)
  );
  const blockedByArtifacts = lineageStrings(
    candidate.lineage,
    "blocksArtifactIds"
  ).filter((id) => lineageStrings(lineage, "artifactIds").includes(id));
  // JSON lineage is persisted as evidence, so matching branch/PR remains
  // deterministic even when two engineers have different local revisions.
  const sameBranch = branch !== undefined && branch === candidateBranch;
  // A peer ON the PR's head branch is on that PR even when its own presence
  // never named the number, which is the author's usual case (#8592).
  const samePullRequest =
    (pullRequest !== undefined && pullRequest === candidatePullRequest) ||
    (pullRequestHeadBranch !== undefined &&
      pullRequestHeadBranch === candidateBranch);
  if (
    pathOverlap.length === 0 &&
    symbolOverlap.length === 0 &&
    !sameBranch &&
    !samePullRequest &&
    artifactOverlap.length === 0 &&
    blocksArtifacts.length === 0 &&
    blockedByArtifacts.length === 0
  ) {
    return null;
  }
  let rank = "shared_artifact";
  if (sameBranch || samePullRequest) {
    rank = "branch_or_pull_request";
  }
  if (pathOverlap.length || symbolOverlap.length) {
    rank = "overlap";
  }
  if (blocksArtifacts.length || blockedByArtifacts.length) {
    rank = "explicit_dependency";
  }
  return {
    rank,
    // Relevance is a bounded explanation, not a second copy of the message.
    // Keep exact counts so large overlaps are never represented as complete samples.
    pathOverlap: pathOverlap.slice(0, 8),
    pathOverlapCount: pathOverlap.length,
    symbolOverlap: symbolOverlap.slice(0, 8),
    symbolOverlapCount: symbolOverlap.length,
    sameBranch,
    samePullRequest,
    artifactOverlap,
    blocksArtifacts,
    blockedByArtifacts,
  };
}

async function verifyFeedbackOwnership(
  db: Prisma.TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    messageId?: string;
    agentId?: string;
  }
): Promise<ResultType<void, typeof Status.Forbidden>> {
  if (input.messageId) {
    const delivery = await db.sessionMeshDelivery.findFirst({
      where: {
        organizationId: input.organizationId,
        recipientUserId: input.userId,
        messageId: input.messageId,
      },
      select: { id: true },
    });
    if (!delivery) {
      return Result.err(Status.Forbidden);
    }
  }
  if (input.agentId) {
    const presence = await db.sessionMeshPresence.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.userId,
        agentId: input.agentId,
      },
      select: { id: true },
    });
    if (!presence) {
      return Result.err(Status.Forbidden);
    }
  }
  return Result.ok(undefined);
}

export const sessionMeshService = {
  upsertPresence(
    input: {
      organizationId: string;
      userId: string;
      presence: SessionMeshPresenceInput;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    const expiresAt = new Date(
      NOW().getTime() + input.presence.expiresInSeconds * 1000
    );
    const workspace = input.presence.workspace;
    return withDb.tx(
      async (
        db
      ): Promise<ResultType<{ userId: string }, typeof Status.Forbidden>> => {
        const data = {
          organizationId: input.organizationId,
          userId: input.userId,
          agentId: input.presence.agentId,
          repository: workspace.repository,
          revision: workspace.revision,
          dirtyStateHash: workspace.dirtyStateHash,
          configurationHash: workspace.configurationHash,
          harness: input.presence.harness,
          capabilities: json(input.presence.capabilities),
          lineage: json(input.presence.lineage),
          context: json(sanitizeMeshContext(input.presence.context)),
          paths: json(workspace.paths),
          symbols: json(workspace.symbols),
          expiresAt,
        };
        // Conditional update is the ownership gate. A competing org member can
        // never take a live canonical id by winning a read-then-upsert race.
        let updated = await db.sessionMeshPresence.updateMany({
          where: {
            organizationId: input.organizationId,
            agentId: input.presence.agentId,
            userId: input.userId,
          },
          data,
        });
        if (updated.count === 0) {
          await db.sessionMeshPresence.createMany({
            data,
            skipDuplicates: true,
          });
          updated = await db.sessionMeshPresence.updateMany({
            where: {
              organizationId: input.organizationId,
              agentId: input.presence.agentId,
              userId: input.userId,
            },
            data,
          });
          if (updated.count === 0) {
            return Result.err(Status.Forbidden);
          }
        }
        const presence = await db.sessionMeshPresence.findFirstOrThrow({
          where: {
            organizationId: input.organizationId,
            agentId: input.presence.agentId,
            userId: input.userId,
          },
        });
        await db.sessionMeshMetricEvent.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            agentId: input.presence.agentId,
            eventType: "presence_heartbeat",
          },
          select: { id: true },
        });
        await recordWrite?.(db, { changed: true });
        return Result.ok(presence);
      }
    );
  },

  roster(
    organizationId: string,
    workspace?: Partial<Pick<SessionMeshWorkspace, "repository" | "revision">>
  ) {
    return readRosterPage(organizationId, workspace).then(
      (page) => page.agents
    );
  },

  rosterPage: readRosterPage,

  resolveCurrentPresence(input: {
    organizationId: string;
    userId: string;
    sessionId?: string;
    agentId?: string;
  }) {
    if (!(input.agentId || input.sessionId)) {
      return Promise.resolve(null);
    }
    let identity: Prisma.SessionMeshPresenceWhereInput = {
      id: "__missing_session_mesh_identity__",
    };
    if (input.agentId) {
      identity = { agentId: input.agentId };
    } else if (input.sessionId) {
      identity = { lineage: { path: ["sessionId"], equals: input.sessionId } };
    }
    return withDb((db) =>
      db.sessionMeshPresence.findFirst({
        where: {
          organizationId: input.organizationId,
          userId: input.userId,
          expiresAt: { gt: NOW() },
          ...identity,
        },
        select: { agentId: true, repository: true, revision: true },
        orderBy: { updatedAt: "desc" },
      })
    );
  },

  unregisterPresence(
    input: {
      organizationId: string;
      userId: string;
      agentId: string;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    // Retain canonical ownership for durable replies while removing it from
    // live discovery immediately. The retention sweep removes old identities.
    return writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.sessionMeshPresence.updateMany({
            where: input,
            data: { expiresAt: NOW() },
          })
        ),
      (result) => ({ changed: result.count > 0 })
    );
  },

  async publish(
    input: {
      organizationId: string;
      userId: string;
      authorAgentId?: string;
      message: SessionMeshPublishInput;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    const expiresAt = new Date(
      NOW().getTime() + input.message.expiresInSeconds * 1000
    );
    const workspace = input.message.workspace;
    const pullRequestHeadBranch = await resolvePullRequestHeadBranch({
      organizationId: input.organizationId,
      repository: workspace.repository,
      lineage: input.message.lineage,
    });
    return withDb.tx(
      async (
        tx
      ): Promise<ResultType<MeshPublishResult, typeof Status.Forbidden>> => {
        const author = await tx.sessionMeshPresence.findFirst({
          where: {
            organizationId: input.organizationId,
            userId: input.userId,
            agentId: input.message.authorAgentId,
            expiresAt: { gt: NOW() },
          },
        });
        if (!author) {
          return Result.err(Status.Forbidden);
        }
        if (input.message.replyToMessageId) {
          const replyTarget = await tx.sessionMeshDelivery.findFirst({
            where: {
              organizationId: input.organizationId,
              messageId: input.message.replyToMessageId,
              recipientUserId: input.userId,
              recipientAgentId: input.message.authorAgentId,
            },
            select: { id: true },
          });
          if (!replyTarget) {
            return Result.err(Status.Forbidden);
          }
        }
        const messageData = {
          id: input.message.messageId ?? crypto.randomUUID(),
          organizationId: input.organizationId,
          authorUserId: input.userId,
          authorAgentId: input.message.authorAgentId,
          idempotencyKey: input.message.idempotencyKey,
          recipientAgentIds: json(input.message.recipientAgentIds),
          replyToMessageId: input.message.replyToMessageId,
          kind: input.message.kind,
          repository: workspace.repository,
          revision: workspace.revision,
          dirtyStateHash: workspace.dirtyStateHash,
          configurationHash: workspace.configurationHash,
          lineage: json(input.message.lineage),
          paths: json(workspace.paths),
          symbols: json(workspace.symbols),
          summary: sanitizeMeshText(input.message.summary),
          context: json(sanitizeMeshContext(input.message.context)),
          sensitivity: input.message.sensitivity,
          expiresAt,
        };
        // PostgreSQL ON CONFLICT is the retry boundary; a raced second request
        // reads the winning immutable message and never recreates deliveries.
        const inserted = await tx.sessionMeshMessage.createMany({
          data: messageData,
          skipDuplicates: true,
        });
        const message = await tx.sessionMeshMessage.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.message.idempotencyKey,
            },
          },
        });
        if (!message || message.authorUserId !== input.userId) {
          return Result.err(Status.Forbidden);
        }
        if (!inserted.count) {
          await recordWrite?.(tx, { changed: false });
          return Result.ok({ message, deliveries: 0, idempotent: true });
        }
        const peers = await tx.sessionMeshPresence.findMany({
          where: {
            organizationId: input.organizationId,
            repository: workspace.repository,
            OR: [
              { expiresAt: { gt: NOW() } },
              { agentId: { in: input.message.recipientAgentIds } },
            ],
            ...(input.message.authorAgentId
              ? { agentId: { not: input.message.authorAgentId } }
              : {}),
          },
        });
        const subscriptions = await tx.sessionMeshSubscription.findMany({
          where: {
            organizationId: input.organizationId,
            repository: workspace.repository,
          },
          select: { userId: true, muted: true, digestOnly: true },
        });
        const muted = new Set(
          subscriptions
            .filter((subscription) => subscription.muted)
            .map((row) => row.userId)
        );
        const digestOnly = new Set(
          subscriptions
            .filter((subscription) => subscription.digestOnly)
            .map((subscription) => subscription.userId)
        );
        const deliveries = peers.flatMap((peer) => {
          if (muted.has(peer.userId)) {
            return [];
          }
          const explicit = input.message.recipientAgentIds.includes(
            peer.agentId
          );
          // Restricted context is intentionally never discovered/broadcast.
          // It only reaches a deliberate canonical agent target.
          if (input.message.sensitivity === "restricted" && !explicit) {
            return [];
          }
          const relevance = explicit
            ? { explicit: true }
            : relevanceFor(
                workspace,
                {
                  paths: stringArray(peer.paths),
                  symbols: stringArray(peer.symbols),
                  lineage: peer.lineage,
                },
                input.message.lineage as Prisma.JsonValue,
                pullRequestHeadBranch
              );
          return relevance
            ? [
                {
                  organizationId: input.organizationId,
                  messageId: message.id,
                  recipientUserId: peer.userId,
                  recipientAgentId: peer.agentId,
                  relevance: json(relevance),
                  status:
                    digestOnly.has(peer.userId) ||
                    relevance.rank === "shared_artifact"
                      ? "held"
                      : "queued",
                },
              ]
            : [];
        });
        if (deliveries.length > 0) {
          await tx.sessionMeshDelivery.createMany({
            data: deliveries,
            skipDuplicates: true,
          });
        }
        await tx.sessionMeshMetricEvent.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            agentId: input.message.authorAgentId,
            messageId: message.id,
            eventType: "message_published",
            metadata: json({
              kind: input.message.kind,
              recipients: deliveries.length,
            }),
          },
          select: { id: true },
        });
        await recordWrite?.(tx, { changed: true });
        return Result.ok({
          message,
          deliveries: deliveries.length,
          idempotent: false,
        });
      }
    );
  },

  inbox(input: { organizationId: string; userId: string; agentId: string }) {
    return withDb(async (db) => {
      const muted = new Set(
        (
          await db.sessionMeshSubscription.findMany({
            where: {
              organizationId: input.organizationId,
              userId: input.userId,
              muted: true,
            },
            select: { repository: true },
          })
        ).map((row) => row.repository)
      );
      const rows = await db.sessionMeshDelivery.findMany({
        where: {
          organizationId: input.organizationId,
          recipientUserId: input.userId,
          recipientAgentId: input.agentId,
          // Held digest work remains in human history; it must not interrupt a
          // native turn until the recipient elects to consume the digest.
          status: { in: ["queued", "attempted"] },
          message: {
            expiresAt: { gt: NOW() },
            repository: { notIn: [...muted] },
          },
        },
        include: { message: true },
        orderBy: { queuedAt: "asc" },
        take: 200,
      });
      return boundedMeshPage(rows, 200);
    });
  },

  deliveryHistory(input: {
    organizationId: string;
    userId: string;
    agentId: string;
  }) {
    return readDeliveryHistoryPage(input).then((page) => page.messages);
  },

  deliveryHistoryPage: readDeliveryHistoryPage,

  subscription(input: {
    organizationId: string;
    userId: string;
    repository: string;
  }) {
    return withDb(
      async (db) =>
        (await db.sessionMeshSubscription.findFirst({
          where: input,
          select: { muted: true, digestOnly: true },
        })) ?? { muted: false, digestOnly: false }
    );
  },

  messageForRecipient(input: {
    organizationId: string;
    userId: string;
    agentId: string;
    messageId: string;
  }) {
    return withDb((db) =>
      db.sessionMeshDelivery.findFirst({
        where: {
          organizationId: input.organizationId,
          recipientUserId: input.userId,
          recipientAgentId: input.agentId,
          messageId: input.messageId,
          message: { expiresAt: { gt: NOW() } },
        },
        include: { message: true },
      })
    );
  },

  acknowledge(
    input: {
      organizationId: string;
      userId: string;
      ack: SessionMeshDeliveryAckInput;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    return writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.sessionMeshDelivery.updateMany({
            where: {
              organizationId: input.organizationId,
              recipientUserId: input.userId,
              recipientAgentId: input.ack.agentId,
              messageId: { in: input.ack.messageIds },
              status: { in: ["queued", "attempted", "held", "delivered"] },
            },
            data: { acknowledgedAt: NOW(), status: "acknowledged" },
          })
        ),
      (result) => ({ changed: result.count > 0 })
    );
  },

  disposition(
    input: {
      organizationId: string;
      userId: string;
      agentId: string;
      messageId: string;
      status: "delivered" | "acknowledged" | "held" | "refused" | "dismissed";
      reason?: string;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    const now = NOW();
    let eligibleStatuses = ["queued", "attempted", "held", "delivered"];
    if (input.status === "delivered") {
      eligibleStatuses = ["queued", "attempted", "held"];
    } else if (input.status === "acknowledged") {
      eligibleStatuses = ["delivered", "held", "queued", "attempted"];
    }
    return withDb.tx(async (db) => {
      const result = await db.sessionMeshDelivery.updateMany({
        where: {
          organizationId: input.organizationId,
          recipientUserId: input.userId,
          recipientAgentId: input.agentId,
          messageId: input.messageId,
          status: { in: eligibleStatuses },
        },
        data: {
          status: input.status,
          ...(input.status === "delivered"
            ? {
                deliveredAt: now,
                attemptedAt: now,
                attemptCount: { increment: 1 },
              }
            : {}),
          ...(input.status === "acknowledged" ? { acknowledgedAt: now } : {}),
          ...(input.status === "held" ? { heldAt: now } : {}),
          ...(input.status === "refused" ? { refusedAt: now } : {}),
          ...(input.status === "dismissed" ? { dismissedAt: now } : {}),
          // `failureReason` is a FAILURE field, and the engagement disposition
          // (ISS-11435) carries evidence on a successful `acknowledged`. Writing
          // it here made every acknowledged delivery report that sentence as a
          // failure reason through the inbox and history responses. The reason is
          // still retained on the metric event below for every status.
          ...(input.reason === undefined || input.status === "acknowledged"
            ? {}
            : { failureReason: input.reason }),
        },
      });
      if (result.count > 0) {
        await db.sessionMeshMetricEvent.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            agentId: input.agentId,
            messageId: input.messageId,
            eventType: `delivery_${input.status}`,
            metadata: json(
              input.reason === undefined ? {} : { reason: input.reason }
            ),
          },
          select: { id: true },
        });
      }
      await recordWrite?.(db, { changed: result.count > 0 });
      return result;
    });
  },

  insights(
    organizationId: string,
    requestedWindow?: { from?: Date; to?: Date },
    userId?: string
  ): Promise<SessionMeshInsights> {
    return readSessionMeshInsights(organizationId, requestedWindow, userId);
  },

  upsertSubscription(
    input: {
      organizationId: string;
      userId: string;
      repository: string;
      muted: boolean;
      digestOnly: boolean;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    return writeRecorded(
      recordWrite,
      () =>
        withDb((db) =>
          db.sessionMeshSubscription.upsert({
            where: {
              organizationId_userId_repository: {
                organizationId: input.organizationId,
                userId: input.userId,
                repository: input.repository,
              },
            },
            create: input,
            update: { muted: input.muted, digestOnly: input.digestOnly },
          })
        ),
      () => ({ changed: true })
    );
  },

  recordFeedback(
    input: {
      organizationId: string;
      userId: string;
      idempotencyKey: string;
      messageId?: string;
      agentId?: string;
      kind: SessionMeshFeedbackKind;
      estimatedTimeSavedMinutes?: number;
      estimatedCostSavedUsd?: number;
      coordinationOverheadMs?: number;
      rationale: string;
    },
    recordWrite?: RecordWriteInTransaction<SessionMeshWrite>
  ) {
    return withDb.tx(
      async (
        db
      ): Promise<ResultType<{ id: string }, typeof Status.Forbidden>> => {
        const existing = await db.sessionMeshMetricEvent.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.userId !== input.userId) {
            return Result.err(Status.Forbidden);
          }
          await recordWrite?.(db, { changed: false });
          return Result.ok(existing);
        }
        const owner = await verifyFeedbackOwnership(db, input);
        if (!owner.ok) {
          return owner;
        }
        const created = await db.sessionMeshMetricEvent.createMany({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            ...(input.messageId === undefined
              ? {}
              : { messageId: input.messageId }),
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            eventType: FEEDBACK_EVENT_TYPE[input.kind],
            idempotencyKey: input.idempotencyKey,
            metadata: json({
              rationale: input.rationale,
              estimatedTimeSavedMinutes: input.estimatedTimeSavedMinutes,
              estimatedCostSavedUsd: input.estimatedCostSavedUsd,
              coordinationOverheadMs: input.coordinationOverheadMs,
            }),
          },
          skipDuplicates: true,
        });
        const event = await db.sessionMeshMetricEvent.findUniqueOrThrow({
          where: {
            organizationId_idempotencyKey: {
              organizationId: input.organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (event.userId !== input.userId) {
          return Result.err(Status.Forbidden);
        }
        await recordWrite?.(db, { changed: created.count > 0 });
        return Result.ok(event);
      }
    );
  },
};

/** What a Session Mesh write changed, for its receipt (ISS-12552). */
export type SessionMeshWrite = { changed: boolean };
