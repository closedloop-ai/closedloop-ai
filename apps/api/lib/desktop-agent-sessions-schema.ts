import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/api/src/session-trace/derivation";
import type {
  DesktopAgentSessionsPayload as ParsedDesktopAgentSessionsPayload,
  SyncedAgentSession as ParsedSyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION as API_AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT as API_DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  AgentSessionSyncMode as ApiAgentSessionSyncMode,
  DesktopAgentSessionsAckReason as ApiDesktopAgentSessionsAckReason,
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import {
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "@repo/api/src/types/session-artifact-link";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./json-schema";

export type {
  DesktopAgentSessionsAck,
  DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";

export const DESKTOP_AGENT_SESSIONS_SOCKET_EVENT =
  API_DESKTOP_AGENT_SESSIONS_SOCKET_EVENT;
export const DesktopAgentSessionsAckReason = ApiDesktopAgentSessionsAckReason;
export const AGENT_SESSION_SYNC_SCHEMA_VERSION =
  API_AGENT_SESSION_SYNC_SCHEMA_VERSION;

const syncModeValues = Object.values(ApiAgentSessionSyncMode) as [
  (typeof ApiAgentSessionSyncMode)[keyof typeof ApiAgentSessionSyncMode],
  ...(typeof ApiAgentSessionSyncMode)[keyof typeof ApiAgentSessionSyncMode][],
];

const isoDateSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    "invalid_date"
  );

const nullableTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

const optionalPreservedTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

const optionalJsonObjectSchema = z
  .unknown()
  .pipe(jsonObjectSchema)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const syncedAgentSessionTokenUsageSchema = z.object({
  model: z.string().trim().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
});

export const sessionPrSchema = z.object({
  num: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]),
  title: z.string().trim().min(1).max(500),
  status: z.string().trim().min(1).max(64),
});

export const activityBucketSchema = z.object({
  label: z.string().trim().min(1).max(80),
  cIn: z.number().finite().nonnegative(),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
  total: z.number().int().nonnegative(),
  toolStart: z.number().int().nonnegative(),
  tl0: z.number().int().nonnegative().nullable(),
  byModel: z.record(
    z.string().trim().min(1).max(120),
    z.object({
      cIn: z.number().finite().nonnegative(),
      cOut: z.number().finite().nonnegative(),
      cCache: z.number().finite().nonnegative(),
    })
  ),
});

export const sessionSpanSchema = z.object({
  first: z.string().trim().min(1).max(80),
  last: z.string().trim().min(1).max(80),
});

export const sessionMarkerSchema = z.object({
  kind: z.enum(["commit", "pr", "fail", "frust", "prompt"]),
  x: z.number().finite().min(0).max(100),
  t: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(300),
  tl: z.number().int().nonnegative(),
  illustrative: z.boolean().optional(),
});

export const sessionThrottleSchema = z.object({
  x0: z.number().finite().min(0).max(100),
  t0: z.string().trim().min(1).max(80),
  t1: z.string().trim().min(1).max(80),
  durMin: z.number().finite().nonnegative(),
  tl: z.number().int().nonnegative(),
});

export const sessionTracePhaseSourceSchema = z.object({
  sourceType: z.enum(SessionTracePhaseSourceType),
  phaseKey: z
    .string()
    .trim()
    .min(1)
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText),
  label: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullish(),
});

export const sessionTraceThrottleSourceSchema = z.object({
  sourceType: z.enum(SessionTraceThrottleSourceType),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText),
  observedAt: isoDateSchema,
  limitKind: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  statusCode: z.number().int().min(100).max(599).nullish(),
  errorCode: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  resetAt: isoDateSchema.nullish(),
  retryAfterSeconds: z.number().finite().nonnegative().nullish(),
});

export const sessionTraceCorrectionSourceSchema = z.object({
  kind: z.enum(SessionTraceCorrectionSourceKind),
  observedAt: isoDateSchema,
  label: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  sourceType: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
});

export const sessionPhaseSchema = z.object({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  dur: z.string().trim().min(1).max(80),
  cost: z.string().trim().min(1).max(80),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
  cIn: z.number().finite().nonnegative(),
});

export const phaseLoopbackSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  depth: z.number().finite().nonnegative(),
});

export const syncedAgentSessionAgentSchema = z.object({
  externalAgentId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  subagentType: nullableTrimmedStringSchema,
  status: z.string().trim().min(1),
  task: nullableTrimmedStringSchema,
  currentTool: nullableTrimmedStringSchema,
  startedAt: isoDateSchema.nullable().optional(),
  updatedAt: isoDateSchema.nullable().optional(),
  endedAt: isoDateSchema.nullable().optional(),
  awaitingInputSince: isoDateSchema.nullable().optional(),
  parentExternalAgentId: nullableTrimmedStringSchema,
  metadata: optionalJsonObjectSchema,
});

export const syncedAgentSessionEventSchema = z.object({
  externalEventId: z.string().trim().min(1),
  agentExternalId: nullableTrimmedStringSchema,
  eventType: z.string().trim().min(1),
  toolName: nullableTrimmedStringSchema,
  summary: nullableTrimmedStringSchema,
  data: jsonValueSchema.optional(),
  createdAt: isoDateSchema,
});

const syncedAgentSessionAttributionSchema = z
  .object({
    repositoryFullName: nullableTrimmedStringSchema,
    worktreePath: nullableTrimmedStringSchema,
    sourceArtifactId: nullableTrimmedStringSchema,
    sourceLoopId: nullableTrimmedStringSchema,
    issueId: nullableTrimmedStringSchema,
    baseBranch: nullableTrimmedStringSchema,
  })
  .optional()
  .transform((value) => value ?? null);

const syncedAgentSessionSchema = z.object({
  externalSessionId: z.string().trim().min(1),
  name: nullableTrimmedStringSchema,
  status: z.string().trim().min(1),
  // Per-session billing mode the desktop resolves from its local billing_mode
  // column (e.g. "api", "pro", "subscription_unknown"). Accepted opaquely and
  // additive — older desktop builds omit it. The usage cost split uses it to
  // classify DESKTOP_SYNC sessions that have no source Loop.
  billingMode: z.string().trim().min(1).max(64).nullish(),
  harness: nullableTrimmedStringSchema,
  cwd: nullableTrimmedStringSchema,
  model: nullableTrimmedStringSchema,
  startedAt: isoDateSchema,
  updatedAt: isoDateSchema,
  endedAt: isoDateSchema.nullable().optional(),
  awaitingInputSince: isoDateSchema.nullable().optional(),
  metadata: optionalJsonObjectSchema,
  attribution: syncedAgentSessionAttributionSchema,
  /** FEA-1459: device IANA timezone for timezone-aware day attribution. */
  deviceTimeZone: z.string().min(1).max(64).nullish(),
  branch: optionalPreservedTrimmedStringSchema,
  issues: z.array(z.string().trim().min(1).max(120)).max(100).nullish(),
  prs: z.array(sessionPrSchema).max(100).nullish(),
  wallClock: optionalPreservedTrimmedStringSchema,
  activeAgent: optionalPreservedTrimmedStringSchema,
  waitingUser: optionalPreservedTrimmedStringSchema,
  linesAdded: z.number().int().nonnegative().nullable().optional(),
  linesRemoved: z.number().int().nonnegative().nullable().optional(),
  filesChanged: z.number().int().nonnegative().nullable().optional(),
  gitDiffStats: z
    .object({
      linesAdded: z.number().int().nonnegative(),
      linesRemoved: z.number().int().nonnegative(),
      filesChanged: z.number().int().nonnegative(),
      source: z.string().trim().min(1).max(64),
    })
    .nullable()
    .optional(),
  branchDiffStats: z
    .object({
      linesAdded: z.number().int().nonnegative(),
      linesRemoved: z.number().int().nonnegative(),
      filesChanged: z.number().int().nonnegative(),
      source: z.string().trim().min(1).max(64),
    })
    .nullable()
    .optional(),
  turns: z.number().int().nonnegative().nullable().optional(),
  steeringEpisodes: z.number().int().nonnegative().nullable().optional(),
  autonomy: z.number().int().min(0).max(100).nullable().optional(),
  activityBuckets: z.array(activityBucketSchema).max(500).nullish(),
  span: sessionSpanSchema.nullish(),
  markers: z.array(sessionMarkerSchema).max(500).nullish(),
  throttles: z.array(sessionThrottleSchema).max(100).nullish(),
  tracePhaseSources: z
    .array(sessionTracePhaseSourceSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.phaseSources)
    .nullish(),
  throttleSources: z
    .array(sessionTraceThrottleSourceSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.throttleSources)
    .nullish(),
  correctionSources: z
    .array(sessionTraceCorrectionSourceSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.correctionSources)
    .nullish(),
  phases: z.array(sessionPhaseSchema).max(50).nullish(),
  phaseIterations: z.record(z.string(), z.number().int().positive()).nullish(),
  phaseLoopbacks: z.array(phaseLoopbackSchema).max(50).nullish(),
  dataRevision: z.number().int().min(1).nullish(),
  artifactRefs: z.array(syncedArtifactRefSchema).max(100).optional(),
  prRefs: z.array(syncedSessionPrRefSchema).max(100).optional(),
  agents: z.array(syncedAgentSessionAgentSchema),
  events: z.array(syncedAgentSessionEventSchema),
  tokenUsageByModel: z.array(syncedAgentSessionTokenUsageSchema),
});

const desktopAgentSessionsPayloadSchema = z
  .object({
    schemaVersion: z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION),
    batchId: z.string().uuid(),
    syncMode: z.enum(syncModeValues),
    sessionCount: z.number().int().nonnegative(),
    sessions: z.array(syncedAgentSessionSchema).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.sessionCount !== value.sessions.length) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionCount"],
        message: "session_count_mismatch",
      });
    }
    for (const [index, session] of value.sessions.entries()) {
      const sourcePayload = {
        tracePhaseSources: session.tracePhaseSources,
        throttleSources: session.throttleSources,
        correctionSources: session.correctionSources,
      };
      const bytes = Buffer.byteLength(JSON.stringify(sourcePayload));
      if (bytes > SESSION_TRACE_SOURCE_LIMITS.aggregatePayloadBytes) {
        ctx.addIssue({
          code: "custom",
          path: ["sessions", index],
          message: "session_trace_source_payload_too_large",
        });
      }
    }
  });

export type DesktopAgentSessionsParseResult =
  | { ok: true; payload: ParsedDesktopAgentSessionsPayload }
  | { ok: false; reason: string };

export function parseDesktopAgentSessionsPayload(
  payload: unknown
): DesktopAgentSessionsParseResult {
  const parsed = desktopAgentSessionsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: summarizeParseIssues(parsed.error.issues),
    };
  }

  return {
    ok: true,
    payload: {
      schemaVersion: parsed.data.schemaVersion,
      batchId: parsed.data.batchId,
      syncMode: parsed.data.syncMode,
      sessionCount: parsed.data.sessionCount,
      sessions: parsed.data.sessions as ParsedSyncedAgentSession[],
    },
  };
}

function summarizeParseIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>
): string {
  const issue = issues[0];
  if (!issue) {
    return "payload_invalid";
  }
  const [root, ...rest] = issue.path;
  if (root === "schemaVersion") {
    return "schema_version_invalid";
  }
  if (root === "batchId") {
    return "batch_id_invalid";
  }
  if (root === "syncMode") {
    return "sync_mode_invalid";
  }
  if (root === "sessionCount") {
    return issue.message === "session_count_mismatch"
      ? "session_count_mismatch"
      : "session_count_invalid";
  }
  if (root === "sessions") {
    if (issue.message === "session_trace_source_payload_too_large") {
      return issue.message;
    }
    return rest.length > 0 ? "session_invalid" : "sessions_invalid";
  }
  return "payload_invalid";
}
