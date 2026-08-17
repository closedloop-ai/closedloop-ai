import { z } from "zod";

import type { JsonObject } from "./common";
import type { RepoExecutionResult } from "./execution-result";
import { RepoExecutionResultSchema } from "./execution-result";
import type { TokensByModel, TokenUsage } from "./tokens";
import { TokensByModelSchema, TokenUsageSchema } from "./tokens";

// --- Event type enum ---

export const LoopEventType = {
  Started: "started",
  Output: "output",
  Progress: "progress",
  ToolCall: "tool_call",
  ArtifactCreated: "artifact_created",
  SupportBundleUploaded: "support_bundle_uploaded",
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
  TokenRefreshed: "token_refreshed",
  TokensCleared: "tokens_cleared",
  ReapReversed: "reap_reversed",
} as const;
export type LoopEventType = (typeof LoopEventType)[keyof typeof LoopEventType];

export const LoopEventTypeSchema = z.enum(LoopEventType);

/**
 * Event types a runner is allowed to POST to `/loops/[id]/events`.
 *
 * Excludes system-internal audit events (`tokens_cleared`, `token_refreshed`)
 * that are emitted exclusively by the orchestrator from inside trusted
 * transactions. Accepting those over the runner-facing endpoint would let a
 * runner with a valid JWT inject fake audit rows that are indistinguishable
 * from those written by the platform.
 */
export const RunnerLoopEventType = {
  Started: LoopEventType.Started,
  Output: LoopEventType.Output,
  Progress: LoopEventType.Progress,
  ToolCall: LoopEventType.ToolCall,
  ArtifactCreated: LoopEventType.ArtifactCreated,
  SupportBundleUploaded: LoopEventType.SupportBundleUploaded,
  Completed: LoopEventType.Completed,
  Error: LoopEventType.Error,
  Cancelled: LoopEventType.Cancelled,
} as const;
export type RunnerLoopEventType =
  (typeof RunnerLoopEventType)[keyof typeof RunnerLoopEventType];

export const RunnerLoopEventTypeSchema = z.enum(RunnerLoopEventType);

// --- Completed event result shape ---

/**
 * Typed shape for the completed event `result` field.
 *
 * Both ECS harness and Electron gateway send these fields. The backend reads
 * specific fields via `extractPrSessionInfo()`. Extra fields are preserved
 * via `.passthrough()` on the schema.
 */
export type LoopCompletedResult = {
  exitCode?: number;
  signal?: string | null;
  durationSeconds?: number;
  prUrl?: string | null;
  prNumber?: number | null;
  branchName?: string | null;
  commitSha?: string | null;
  sessionId?: string | null;
};

export const LoopCompletedResultSchema = z.looseObject({
  exitCode: z.number().optional(),
  signal: z.string().nullable().optional(),
  durationSeconds: z.number().optional(),
  prUrl: z.string().nullable().optional(),
  prNumber: z.number().nullable().optional(),
  branchName: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
});

// --- Individual event types + schemas ---

export type LoopEventStarted = {
  type: "started";
  loopId: string;
  timestamp: string;
  correlationId?: string;
};

export const LoopEventStartedSchema = z.object({
  type: z.literal("started"),
  loopId: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
});

export type LoopEventOutput = {
  type: "output";
  chunk: string;
  timestamp?: string;
  tokenUsage?: TokenUsage;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventOutputSchema = z.object({
  type: z.literal("output"),
  chunk: z.string(),
  timestamp: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventProgress = {
  type: "progress";
  percent: number;
  stage: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventProgressSchema = z.object({
  type: z.literal("progress"),
  percent: z.number(),
  stage: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventToolCall = {
  type: "tool_call";
  tool: string;
  status: "start" | "end";
  input?: unknown;
  output?: unknown;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventToolCallSchema = z.object({
  type: z.literal("tool_call"),
  tool: z.string(),
  status: z.enum(["start", "end"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventArtifactCreated = {
  type: "artifact_created";
  artifactId: string;
  artifactType: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventArtifactCreatedSchema = z.object({
  type: z.literal("artifact_created"),
  artifactId: z.string(),
  artifactType: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopSupportBundleFile = {
  name: string;
  key: string;
  sizeBytes?: number;
};

export const LoopSupportBundleFileSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export type LoopEventSupportBundleUploaded = {
  type: "support_bundle_uploaded";
  keys: string[];
  files?: LoopSupportBundleFile[];
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventSupportBundleUploadedSchema = z.object({
  type: z.literal("support_bundle_uploaded"),
  keys: z.array(z.string().min(1)).min(1).max(2),
  files: z.array(LoopSupportBundleFileSchema).max(2).optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

/**
 * Provenance of a completed loop's accounting, derived deterministically from
 * whether Claude Code's stream-json `result` envelope was present in the run's
 * captured stdout (PRD-538 R2).
 *
 * Verified against the frozen oracle in `packages/golden-sessions/`: no
 * persistent transcript there carries a `result` record, so envelope presence
 * classifies the session without ambiguity.
 */
export const LoopSessionOrigin = {
  /** Captured stdout of a non-interactive `-p` run — authoritative available. */
  HarnessStdout: "harness_stdout",
  /** An interactive/imported transcript — derived reconstruction only. */
  PersistentTranscript: "persistent_transcript",
} as const;
export type LoopSessionOrigin =
  (typeof LoopSessionOrigin)[keyof typeof LoopSessionOrigin];

/** Outcome of comparing our derived cost against the authoritative total. */
export const LoopReconciliationStatus = {
  Matched: "matched",
  Drifted: "drifted",
  /** No authoritative total to compare against — NOT "matched at zero". */
  Unavailable: "unavailable",
} as const;
export type LoopReconciliationStatus =
  (typeof LoopReconciliationStatus)[keyof typeof LoopReconciliationStatus];

/** Session-total token usage, verbatim from the result envelope. */
export type LoopHarnessUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearchRequests: number;
};

/** One per-model row of the envelope's `modelUsage`. */
export type LoopHarnessModelUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number | null;
};

/** A tool call the run refused under its permission mode. */
export type LoopHarnessPermissionDenial = {
  toolName: string;
  toolUseId: string | null;
};

/**
 * Claude Code's own authoritative accounting for a completed loop, plus how it
 * reconciles against our transcript-derived reconstruction (PRD-538 R1/R2).
 *
 * Every field is optional or nullable because the envelope only exists for
 * harness stdout captures. Absent accounting is UNKNOWN — it is never coerced
 * to `0`, and a derived figure is never relabelled as authoritative. The
 * `harness*` fields beyond turns/duration are omitted rather than nulled when
 * absent, per the cross-repo optional-field rule.
 *
 * ONE deliberate exception (ISS-5368): `harnessUsage.webSearchRequests` defaults
 * to `0` when absent. It is a COUNT OF BILLED EVENTS, not a measurement — an
 * omitted key and a zero line item both mean "no web search was billed", so zero
 * is the honest reading rather than a fabricated one. The exception is also load
 * bearing: without it an older build's `harnessUsage` fails the inner object and
 * `.catch(undefined)` discards the WHOLE aggregate, losing four sound token
 * counters over one additive field. Those four counters stay required precisely
 * because the rule above still holds for them — an absent token total is
 * genuinely unknown, and zero-filling it would report a session that consumed
 * nothing.
 */
export type LoopUsageReconciliation = {
  sessionOrigin: LoopSessionOrigin;
  /** Claude Code's `result.total_cost_usd`; null when no envelope. */
  authoritativeCostUsd: number | null;
  /** Our genai-prices-derived total; null when nothing could be priced. */
  derivedCostUsd: number | null;
  reconciliationStatus: LoopReconciliationStatus;
  reconciliationDeltaUsd: number | null;
  harnessNumTurns: number | null;
  harnessDurationMs: number | null;
  harnessDurationApiMs?: number;
  harnessStopReason?: string;
  harnessUsage?: LoopHarnessUsage;
  harnessModelUsage?: Record<string, LoopHarnessModelUsage>;
  harnessPermissionDenials?: LoopHarnessPermissionDenial[];
};

/**
 * Compile-time coverage guard. `satisfies Record<keyof LoopUsageReconciliation,
 * z.ZodTypeAny>` makes the schema total over the contract: a field added to the
 * type without a schema key fails `tsc`, and so does a schema key the type does
 * not declare. Without it a new field is just an unknown key at the boundary —
 * silently dropped by consumers, exactly the drift AGENTS.md warns about.
 */
type LoopUsageReconciliationSchemaShape = Record<
  keyof LoopUsageReconciliation,
  z.ZodTypeAny
>;

/**
 * A COUNT on the wire (tokens, turns): a non-negative integer. `z.number()`
 * already rejects `NaN` and `Infinity` in Zod v4, so `.int().min(0)` is the
 * whole contract. Tokens and turns are discrete, so a fractional or negative
 * value is corrupt input and must never be persisted as accounting.
 */
const LoopWireCountSchema = z.number().int().min(0);

/**
 * A non-negative finite MAGNITUDE on the wire (a duration in ms, a dollar
 * cost). Fractional is legitimate here; negative is not, since neither a
 * duration nor a spend can be below zero for a run that happened.
 */
const LoopWireMagnitudeSchema = z.number().min(0);

/**
 * The authoritative-accounting schema.
 *
 * Two deliberate boundary rules, both aimed at "a bad value must never become
 * plausible accounting" without ever costing us the completion itself:
 *
 * 1. The optional `harness*` AGGREGATES each `.catch(undefined)`. A corrupt
 *    counter drops just that aggregate, so the block still carries the
 *    provenance and reconciliation the rest of the payload proved. Omission is
 *    the honest answer for a value we cannot stand behind; a zero is not.
 * 2. The required scalars do NOT catch, so a payload that is corrupt in its
 *    load-bearing fields fails this schema as a whole. The completed event
 *    survives that: `LoopEventCompletedSchema` catches at the
 *    `usageReconciliation` key, dropping the block rather than 400-ing the
 *    loop completion. Valid-or-absent, never partially-corrupt.
 */
export const LoopUsageReconciliationSchema = z.object({
  sessionOrigin: z.enum(LoopSessionOrigin),
  authoritativeCostUsd: LoopWireMagnitudeSchema.nullable(),
  derivedCostUsd: LoopWireMagnitudeSchema.nullable(),
  reconciliationStatus: z.enum(LoopReconciliationStatus),
  /** `derived - authoritative`, so legitimately SIGNED — only finiteness applies. */
  reconciliationDeltaUsd: z.number().nullable(),
  harnessNumTurns: LoopWireCountSchema.nullable(),
  harnessDurationMs: LoopWireMagnitudeSchema.nullable(),
  harnessDurationApiMs: LoopWireMagnitudeSchema.optional(),
  harnessStopReason: z.string().optional(),
  harnessUsage: z
    .object({
      input: LoopWireCountSchema,
      output: LoopWireCountSchema,
      cacheRead: LoopWireCountSchema,
      cacheWrite: LoopWireCountSchema,
      // ISS-5368 (PRD-538 R4a residual): absent reads as ZERO, not unknown.
      // Scoped deliberately to this one counter. The CLI omits
      // `server_tool_use` entirely when no server tool ran, and a pre-PRD-538
      // desktop build never emitted the field at all — for a per-request billed
      // line item both mean "no web search was billed", which is 0. Without the
      // default, an old build's `harnessUsage` fails this inner object and
      // `.catch(undefined)` discards the WHOLE aggregate, losing four sound
      // token counters over one additive field. The four counters above stay
      // required on purpose: an absent token total is genuinely UNKNOWN, and
      // zero-filling it would report a session that consumed nothing.
      webSearchRequests: LoopWireCountSchema.default(0),
    })
    .optional()
    .catch(undefined),
  harnessModelUsage: z
    .record(
      z.string(),
      z.object({
        input: LoopWireCountSchema,
        output: LoopWireCountSchema,
        cacheRead: LoopWireCountSchema,
        cacheCreation: LoopWireCountSchema,
        costUsd: LoopWireMagnitudeSchema.nullable(),
      })
    )
    .optional()
    .catch(undefined),
  harnessPermissionDenials: z
    .array(
      z.object({
        toolName: z.string(),
        toolUseId: z.string().nullable(),
      })
    )
    .optional()
    .catch(undefined),
} satisfies LoopUsageReconciliationSchemaShape);

export type LoopEventCompleted = {
  type: "completed";
  result: LoopCompletedResult;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    turns?: number;
    models?: string[];
  };
  tokensByModel?: TokensByModel | null;
  /** PRD-538: Claude Code's authoritative accounting + provenance, when known. */
  usageReconciliation?: LoopUsageReconciliation;
  apiKeySource?: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
  warnings?: string[];
  results?: RepoExecutionResult[];
};

export const LoopEventCompletedSchema = z.object({
  type: z.literal("completed"),
  result: LoopCompletedResultSchema,
  tokensUsed: z.object({
    input: z.number(),
    output: z.number(),
    cacheCreationInputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    turns: z.number().optional(),
    models: z.array(z.string()).optional(),
  }),
  tokensByModel: TokensByModelSchema.nullable().optional(),
  // Valid-or-absent: a reconciliation block that fails its own schema is
  // DROPPED, never persisted half-parsed, and never allowed to reject the
  // completion event it rides on. Losing accounting is recoverable; losing the
  // loop's completion because a peer build sent one bad counter is not.
  usageReconciliation:
    LoopUsageReconciliationSchema.optional().catch(undefined),
  apiKeySource: z.string().optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  results: z.array(RepoExecutionResultSchema).optional(),
});

export type LoopEventError = {
  type: "error";
  code: string;
  message: string;
  timestamp: string;
  logTail?: string;
  tokenUsage?: TokenUsage;
  tokensByModel?: TokensByModel | null;
  diagnosticsVersion?: string;
  apiKeySource?: string;
  result?: JsonObject;
  correlationId?: string;
  loopId?: string;
  warnings?: string[];
};

export const LoopEventErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  timestamp: z.string(),
  logTail: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  tokensByModel: TokensByModelSchema.nullable().optional(),
  diagnosticsVersion: z.string().optional(),
  apiKeySource: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

export type LoopEventCancelled = {
  type: "cancelled";
  reason?: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventCancelledSchema = z.object({
  type: z.literal("cancelled"),
  reason: z.string().optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventTokensCleared = {
  type: "tokens_cleared";
  status: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventTokensClearedSchema = z.object({
  type: z.literal("tokens_cleared"),
  status: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

// --- Discriminated union ---

export type LoopEvent =
  | LoopEventStarted
  | LoopEventOutput
  | LoopEventProgress
  | LoopEventToolCall
  | LoopEventArtifactCreated
  | LoopEventSupportBundleUploaded
  | LoopEventCompleted
  | LoopEventError
  | LoopEventCancelled
  | LoopEventTokensCleared;

export const LoopEventSchema = z.discriminatedUnion("type", [
  LoopEventStartedSchema,
  LoopEventOutputSchema,
  LoopEventProgressSchema,
  LoopEventToolCallSchema,
  LoopEventArtifactCreatedSchema,
  LoopEventSupportBundleUploadedSchema,
  LoopEventCompletedSchema,
  LoopEventErrorSchema,
  LoopEventCancelledSchema,
  LoopEventTokensClearedSchema,
]);

// --- Query/response types ---

/**
 * A {@link LoopEvent} enriched with server-authoritative storage metadata, as
 * returned by the read APIs (`getEvents` / `getEventsSince`).
 *
 * - `id` is the DB row id (uuid7) — a stable identity for client-side dedup
 *   and React list keys.
 * - `storedAt` is the DB `createdAt` as an ISO string. Unlike the event's own
 *   `timestamp` (producer-set), `storedAt` reflects DB insertion order, so it
 *   is the keyset cursor incremental polling uses to fetch only newer events.
 */
export type StoredLoopEvent = LoopEvent & {
  id: string;
  storedAt: string;
};

export type LoopEventsFilters = {
  type?: LoopEventType;
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
};

export type LoopEventsPaginatedResponse = {
  data: StoredLoopEvent[];
  total: number;
};
