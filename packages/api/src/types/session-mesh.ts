import { z } from "zod";
import { InsightsPeriod, InsightsScope } from "./insights.ts";
import { sessionMeshSavingsValidator } from "./session-mesh-savings.ts";

/** A durable, organization-scoped message is the unit of Mesh coordination. */
export const SESSION_MESH_MESSAGE_KIND = [
  "work_started",
  "claim",
  "conflict",
  "discovery",
  "decision",
  "blocker",
  "request",
  "reply",
  "handoff",
  "session_ended",
] as const;

export const SESSION_MESH_DELIVERY_STATUS = [
  "queued",
  "attempted",
  "delivered",
  "acknowledged",
  "held",
  "refused",
  "dismissed",
  "expired",
  "failed",
] as const;

/** Every recorded feedback outcome. The first three are the forced value ternary. */
export const SESSION_MESH_FEEDBACK_KIND = [
  "useful",
  "not_useful",
  "cant_tell",
  "conflict_resolved",
  "coordination_overhead",
] as const;
export type SessionMeshFeedbackKind =
  (typeof SESSION_MESH_FEEDBACK_KIND)[number];
/**
 * The subset a recipient answers the one engagement prompt with.
 *
 * Load-bearing, not documentation: the desktop context block composes the prompt
 * text from this list, so the prompt cannot name a kind `sessionMeshFeedbackValidator`
 * would reject.
 */
export const SESSION_MESH_VALUE_JUDGEMENT_KIND = [
  "useful",
  "not_useful",
  "cant_tell",
] as const satisfies readonly SessionMeshFeedbackKind[];

export const SESSION_MESH_SCHEMA_VERSION = 1;

export const sessionMeshWorkspaceValidator = z.object({
  repository: z.string().trim().min(1).max(500),
  revision: z.string().trim().min(1).max(256),
  dirtyStateHash: z.string().trim().min(1).max(256).optional(),
  configurationHash: z.string().trim().min(1).max(256).optional(),
  paths: z.array(z.string().trim().min(1).max(1000)).max(200).default([]),
  symbols: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
});

const MAX_CONTEXT_BYTES = 32_768;
function fitsWireRecord(value: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 128 * 1024
  );
}
function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > 6) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 100 &&
      value.every((item) => isBoundedJson(item, depth + 1))
    );
  }
  if (typeof value === "object") {
    return (
      Object.keys(value as Record<string, unknown>).length <= 100 &&
      Object.values(value as Record<string, unknown>).every((item) =>
        isBoundedJson(item, depth + 1)
      )
    );
  }
  return false;
}
const boundedRecord = z
  .record(z.string().max(200), z.unknown())
  .refine(
    (value) =>
      isBoundedJson(value) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
        MAX_CONTEXT_BYTES,
    "Context must be JSON, at most six levels deep and 32 KiB"
  );
export const sessionMeshLineageValidator = z
  .object({
    sessionId: z.string().trim().min(1).max(500).optional(),
    threadId: z.string().trim().min(1).max(500).optional(),
    loopId: z.string().uuid().optional(),
    artifactIds: z.array(z.string().uuid()).max(100).default([]),
    /** Explicit dependency evidence; unlike shared artifact membership it may interrupt peers. */
    blocksArtifactIds: z.array(z.string().uuid()).max(100).default([]),
    branch: z.string().trim().min(1).max(500).optional(),
    pullRequest: z.string().trim().min(1).max(500).optional(),
  })
  .default({ artifactIds: [], blocksArtifactIds: [] });

export const sessionMeshContextValidator = z
  .object({
    revision: z.string().trim().min(1).max(256).optional(),
    summary: z.string().trim().max(8000).optional(),
    artifactRefs: z
      .array(z.string().trim().min(1).max(500))
      .max(100)
      .default([]),
    sensitivity: z.enum(["normal", "restricted"]).default("normal"),
  })
  .default({ artifactRefs: [], sensitivity: "normal" });

export const sessionMeshPresenceValidator = z
  .object({
    /** Canonical agent/session identity, never a scheduler slot alias. */
    agentId: z.string().trim().min(1).max(500),
    workspace: sessionMeshWorkspaceValidator,
    harness: z.enum(["claude", "codex", "unknown"]).default("unknown"),
    capabilities: z
      .array(
        z.enum([
          "poll_inbox",
          "native_delivery",
          "steer_active_turn",
          "context_reply",
        ])
      )
      .max(20)
      .default(["poll_inbox"]),
    lineage: sessionMeshLineageValidator,
    context: sessionMeshContextValidator,
    expiresInSeconds: z.number().int().min(15).max(300).default(90),
  })
  .refine(fitsWireRecord, "Presence must fit the 128 KiB wire record budget");
export const sessionMeshUnregisterValidator = z.object({
  agentId: z.string().trim().min(1).max(500),
});

export const sessionMeshPublishValidator = z
  .object({
    messageId: z.string().uuid().optional(),
    idempotencyKey: z.string().trim().min(1).max(500),
    authorAgentId: z.string().trim().min(1).max(500),
    recipientAgentIds: z
      .array(z.string().trim().min(1).max(500))
      .max(100)
      .default([]),
    replyToMessageId: z.string().uuid().optional(),
    kind: z.enum(SESSION_MESH_MESSAGE_KIND),
    workspace: sessionMeshWorkspaceValidator,
    lineage: sessionMeshLineageValidator,
    summary: z.string().trim().min(1).max(4000),
    context: boundedRecord.default({}),
    sensitivity: z.enum(["normal", "restricted"]).default("normal"),
    expiresInSeconds: z.number().int().min(60).max(86_400).default(3600),
  })
  .refine(fitsWireRecord, "Message must fit the 128 KiB wire record budget");

export const sessionMeshDeliveryAckValidator = z.object({
  agentId: z.string().trim().min(1).max(500),
  messageIds: z.array(z.string().uuid()).min(1).max(200),
});

export const sessionMeshDeliveryDispositionValidator = z.object({
  agentId: z.string().trim().min(1).max(500),
  messageId: z.string().uuid(),
  status: z.enum(["delivered", "acknowledged", "held", "refused", "dismissed"]),
  reason: z.string().trim().max(1000).optional(),
});
export const sessionMeshSubscriptionValidator = z.object({
  repository: z.string().trim().min(1).max(500),
  muted: z.boolean().default(false),
  digestOnly: z.boolean().default(false),
});
export const sessionMeshFeedbackValidator = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    messageId: z.string().uuid().optional(),
    agentId: z.string().trim().min(1).max(500).optional(),
    /**
     * `not_useful` and `cant_tell` are FIRST-CLASS outcomes, not padding
     * (ISS-11435): with only `useful` available, a recipient who read a message
     * and got nothing from it had no way to say so, and its silence was
     * indistinguishable from an unread inbox — which is what made "the Mesh
     * produces no value" unfalsifiable. Additive to the enum, so an older client
     * that never sends them is unaffected.
     */
    kind: z.enum(SESSION_MESH_FEEDBACK_KIND),
    estimatedTimeSavedMinutes: z.number().nonnegative().max(10_000).optional(),
    estimatedCostSavedUsd: z.number().nonnegative().max(1_000_000).optional(),
    coordinationOverheadMs: z
      .number()
      .int()
      .nonnegative()
      .max(600_000)
      .optional(),
    rationale: z.string().trim().min(1).max(2000),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "coordination_overhead" &&
      value.coordinationOverheadMs === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "coordinationOverheadMs is required",
      });
    }
    // A verdict with no message identity cannot be ownership-checked against a
    // delivery and cannot be counted as "a delivery a recipient rated". Required
    // only for the two kinds ISS-11435 ADDS: tightening it on `useful` would
    // reject an older client that has always been allowed to omit it, and the
    // insights rollup already joins on message identity so a message-less
    // `useful` is excluded from `judged` rather than inflating it.
    if (
      (value.kind === "not_useful" || value.kind === "cant_tell") &&
      value.messageId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "messageId is required for a value verdict",
      });
    }
  });

export const sessionMeshInsightsQueryValidator = z
  .object({
    scope: z
      .enum([InsightsScope.Me, InsightsScope.Org])
      .default(InsightsScope.Me),
    period: z
      .enum([
        InsightsPeriod.Week,
        InsightsPeriod.Month,
        InsightsPeriod.Quarter,
        InsightsPeriod.All,
      ])
      .default(InsightsPeriod.Month),
    userId: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === InsightsScope.Org && value.userId) {
      ctx.addIssue({
        code: "custom",
        message: "Organization scope cannot select an individual user",
      });
    }
  });

export const sessionMeshInsightsValidator = z.object({
  scope: z
    .object({
      kind: z.enum([InsightsScope.Me, InsightsScope.Org]).optional(),
      userId: z.string().uuid().optional(),
    })
    .optional(),
  window: z.object({ from: z.string(), to: z.string() }),
  trend: z
    .array(
      z.object({
        day: z.string(),
        published: z.number().int().nonnegative(),
        delivered: z.number().int().nonnegative(),
        acknowledged: z.number().int().nonnegative(),
      })
    )
    .max(100),
  participation: z.object({
    active: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
  }),
  deliveries: z.object({
    attempted: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    /**
     * Engagement: a recipient acted on the delivery. Rendered as "Engaged"; the
     * name stays `acknowledged` because it is the delivery status that backs it.
     */
    acknowledged: z.number().int().nonnegative(),
    useful: z.number().int().nonnegative(),
    conflictsResolved: z.number().int().nonnegative(),
    /**
     * ISS-11435, all OPTIONAL so a newer client reading an OLDER server gets
     * `undefined` — which the card renders as unknown — rather than a parse
     * failure or a fabricated zero.
     *
     * `judged` is the denominator for the value ternary; `recipientActions`
     * counts the held/refused/dismissed dispositions a recipient issued, which
     * is a recipient decision the card never surfaced.
     */
    judged: z.number().int().nonnegative().optional(),
    notUseful: z.number().int().nonnegative().optional(),
    cantTell: z.number().int().nonnegative().optional(),
    recipientActions: z.number().int().nonnegative().optional(),
  }),
  /**
   * ISS-11756: round-trip savings. OPTIONAL and additive, so an older client
   * reading a newer server ignores it and a newer client reading an older
   * server sees `undefined` — unknown — rather than a fabricated zero.
   */
  savings: sessionMeshSavingsValidator.optional(),
  /**
   * ISS-11755: detected collisions per UTC day with that day's active-agent
   * pair count. Optional and additive — an older client ignores it, a newer one
   * reading an older server sees `undefined` rather than an invented empty
   * series.
   */
  collisionDensity: z
    .array(
      z.object({
        day: z.string(),
        /** Delivery rows queued that day — the cohort detection ran over. */
        queued: z.number().int().nonnegative(),
        /** Collisions DETECTED at publish: non-empty path or symbol overlap. */
        detected: z.number().int().nonnegative(),
        /** Detected collisions that actually reached a live peer. */
        surfaced: z.number().int().nonnegative(),
        /** Overlap kinds kept separate — a shared branch is not a shared file. */
        pathCollisions: z.number().int().nonnegative(),
        symbolCollisions: z.number().int().nonnegative(),
        branchCollisions: z.number().int().nonnegative(),
        pullRequestCollisions: z.number().int().nonnegative(),
        artifactCollisions: z.number().int().nonnegative(),
        blockingCollisions: z.number().int().nonnegative(),
        activeAgents: z.number().int().nonnegative(),
        pairs: z.number().int().nonnegative(),
        density: z.number().nonnegative().nullable(),
      })
    )
    .max(100)
    .optional(),
  requestResponseLatencyMs: z.number().nonnegative().nullable(),
  estimatedTimeSavedMinutes: z.number().nonnegative().nullable(),
  estimatedCostSavedUsd: z.number().nonnegative().nullable(),
  coordinationOverheadMs: z.number().nonnegative().nullable(),
  provenance: z.object({
    availability: z.enum(["measured", "partial", "unavailable"]),
    notes: z.array(z.string()).max(20),
  }),
});
export type SessionMeshInsights = z.infer<typeof sessionMeshInsightsValidator>;
export type SessionMeshSubscriptionInput = z.infer<
  typeof sessionMeshSubscriptionValidator
>;

export const sessionMeshPresenceViewValidator = z.object({
  agentId: z.string(),
  repository: z.string(),
  revision: z.string(),
  dirtyStateHash: z.string().nullable(),
  configurationHash: z.string().nullable(),
  harness: z.string(),
  capabilities: z.unknown(),
  lineage: z.unknown(),
  context: z.unknown(),
  paths: z.unknown(),
  symbols: z.unknown(),
  expiresAt: z.string().or(z.date()),
  user: z.object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
  }),
});
export const sessionMeshRosterResponseValidator = z.object({
  agents: z.array(sessionMeshPresenceViewValidator).max(500),
  nextCursor: z.string().optional(),
});
export const sessionMeshInboxResponseValidator = z.object({
  messages: z
    .array(
      z.object({
        id: z.string(),
        messageId: z.string().uuid(),
        recipientAgentId: z.string(),
        status: z.enum(SESSION_MESH_DELIVERY_STATUS),
        relevance: z.unknown(),
        queuedAt: z.string().or(z.date()),
        deliveredAt: z.string().or(z.date()).nullable(),
        acknowledgedAt: z.string().or(z.date()).nullable(),
        failureReason: z.string().nullable(),
        message: z.object({
          id: z.string().uuid(),
          kind: z.enum(SESSION_MESH_MESSAGE_KIND),
          summary: z.string(),
          authorAgentId: z.string().nullable(),
          repository: z.string(),
          revision: z.string(),
          paths: z.unknown(),
          symbols: z.unknown(),
          context: z.unknown(),
          sensitivity: z.string(),
          replyToMessageId: z.string().uuid().nullable(),
          /**
           * When this message stops being delivered — the window during which a
           * `claim` is still current.
           *
           * Additive and optional (ISS-11755): the inbox query already selects
           * the whole message row, so every live server sends it; a response
           * from one that does not simply carries none, and a reader that needs
           * a claim window treats that as unknown rather than as expired.
           */
          expiresAt: z.string().or(z.date()).nullish(),
        }),
      })
    )
    .max(200),
});
export type SessionMeshRosterResponse = z.infer<
  typeof sessionMeshRosterResponseValidator
>;
export type SessionMeshInboxResponse = z.infer<
  typeof sessionMeshInboxResponseValidator
>;
export const sessionMeshRelatedResponseValidator = z.object({
  currentAgentId: z.string(),
  currentWorkspace: z.object({ repository: z.string(), revision: z.string() }),
  roster: z.array(sessionMeshPresenceViewValidator),
  inbox: sessionMeshInboxResponseValidator.shape.messages,
  nextRosterCursor: z.string().optional(),
  nextInboxCursor: z.string().optional(),
  subscription: z
    .object({ muted: z.boolean(), digestOnly: z.boolean() })
    .optional(),
});
export type SessionMeshRelatedResponse = z.infer<
  typeof sessionMeshRelatedResponseValidator
>;

export type SessionMeshWorkspace = z.infer<
  typeof sessionMeshWorkspaceValidator
>;
export type SessionMeshPresenceInput = z.infer<
  typeof sessionMeshPresenceValidator
>;
export type SessionMeshPublishInput = z.infer<
  typeof sessionMeshPublishValidator
>;
export type SessionMeshDeliveryAckInput = z.infer<
  typeof sessionMeshDeliveryAckValidator
>;
export type SessionMeshDeliveryDispositionInput = z.infer<
  typeof sessionMeshDeliveryDispositionValidator
>;

/**
 * The `code` a Session Mesh route puts in a `403` body.
 *
 * Shared because the DESKTOP has to tell these apart, not just emit them: its
 * outbox drain continues past a refusal that is about ONE operation and stops on
 * one that is about the whole source, and an HTML `403` from a proxy carries no
 * code at all. See `isItemScopedSessionMeshRejection` in
 * `apps/desktop/src/main/session-mesh/session-mesh-outbox-policy.ts`.
 */
export const SessionMeshForbiddenCode = {
  /** The account is not in the rollout, or the flag service could not be read. */
  Disabled: "session_mesh_disabled",
  AgentForbidden: "session_mesh_agent_forbidden",
  PublishForbidden: "session_mesh_publish_forbidden",
  FeedbackForbidden: "session_mesh_feedback_forbidden",
} as const;
export type SessionMeshForbiddenCode =
  (typeof SessionMeshForbiddenCode)[keyof typeof SessionMeshForbiddenCode];

/**
 * Whether each code refuses ONE operation rather than every queued one.
 *
 * An exhaustive `Record` rather than a hand-kept list, so a new code fails
 * `tsc` here until someone decides which side it is on. `Disabled` is the
 * source-wide one: it answers the same for every row behind it.
 */
const SESSION_MESH_FORBIDDEN_CODE_IS_ITEM_SCOPED: Record<
  SessionMeshForbiddenCode,
  boolean
> = {
  [SessionMeshForbiddenCode.Disabled]: false,
  [SessionMeshForbiddenCode.AgentForbidden]: true,
  [SessionMeshForbiddenCode.PublishForbidden]: true,
  [SessionMeshForbiddenCode.FeedbackForbidden]: true,
};

/**
 * Whether a parsed `403` code names a refusal of one operation. Anything this
 * build cannot name answers `false`, which is the direction that stops a drain
 * rather than the one that burns every queued row against a source-wide refusal.
 */
export function isItemScopedSessionMeshForbiddenCode(
  code: string | null
): boolean {
  if (!code) {
    return false;
  }
  return (
    SESSION_MESH_FORBIDDEN_CODE_IS_ITEM_SCOPED[
      code as SessionMeshForbiddenCode
    ] === true
  );
}

/** The `403` body shape every Session Mesh route answers with. */
export const sessionMeshForbiddenBodyValidator = z.object({
  success: z.literal(false),
  code: z.string(),
});
