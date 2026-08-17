import { z } from "zod";
import { safeStorageTokenCountSchema } from "../../cost/token-counts.js";
import type {
  OpencodeWithheldSubagentReport,
  OpencodeWithheldSubagentRoot,
} from "../opencode/opencode-withheld-subagents.js";
import {
  type CodexProtocolSupport,
  type CodexRateLimits,
  type CodexRateLimitWindow,
  deriveEndedOnUnrecoveredError,
  HarnessValues,
  type NormalizedApiError,
  type NormalizedCodexTokenSnapshot,
  NormalizedDefinitionKind,
  type NormalizedDefinitionSnapshot,
  type NormalizedHookUse,
  type NormalizedMessage,
  type NormalizedParseQuality,
  type NormalizedPlan,
  type NormalizedSession,
  type NormalizedSkillUse,
  type NormalizedSlashCommand,
  type NormalizedSubagent,
  type NormalizedTokenRecord,
  type NormalizedToolResultError,
  type NormalizedToolUse,
} from "../types.js";
import { isBoundedUnknownValue } from "./historical-parse-worker-bounded-value.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits.js";
import {
  clampSessionsForWorkerResponse,
  summarizeWorkerResponsePayload,
} from "./historical-parse-worker-response-budget.js";
import { boundedDiagnosticText } from "./historical-parse-worker-stderr-sanitize.js";
import {
  cacheWriteTtlSchema,
  historicalWorkerTokenRecordSchema,
} from "./historical-parse-worker-token-schema.js";

const MAX_WORKER_SESSIONS_PER_SOURCE =
  HistoricalParseWorkerLimits.maxWorkerSessionsPerSource;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_UNKNOWN_OBJECT_KEYS =
  HistoricalParseWorkerLimits.maxUnknownObjectKeys;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_RESPONSE_ISSUE_COUNT = 5;
const MAX_RESPONSE_ISSUE_TEXT_LENGTH = 160;
const MAX_RESPONSE_ISSUE_UNION_DEPTH = 4;
const WORKER_INVALID_RESPONSE_MESSAGE_PREFIX =
  "historical parse worker sent an invalid response";
const nullableShortTextSchema = z
  .string()
  .max(MAX_SHORT_TEXT_LENGTH)
  .nullable();
const optionalNullableShortTextSchema = nullableShortTextSchema.optional();
const tokenCountsSchema = z.object({
  input: safeStorageTokenCountSchema,
  output: safeStorageTokenCountSchema,
  cacheRead: safeStorageTokenCountSchema,
  cacheWrite: safeStorageTokenCountSchema,
  // FEA-3419: per-model cache-write TTL subdivision.
  cacheWriteTtl: cacheWriteTtlSchema.optional(),
  // FEA-2085: fallback-attribution marker (see NormalizedTokenCounts).
  inferred: z.boolean().optional(),
});
const messageTokenCountsSchema = z.object({
  input: safeStorageTokenCountSchema,
  output: safeStorageTokenCountSchema,
  cacheRead: safeStorageTokenCountSchema.optional(),
  cacheWrite: safeStorageTokenCountSchema.optional(),
});
const boundedUnknownValueSchema = z.custom<unknown>((value) =>
  isBoundedUnknownValue(value, 0)
);
const workerMessageRequestIdSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .passthrough();

const definitionSnapshotSchema = z
  .object({
    kind: z.enum([
      NormalizedDefinitionKind.Command,
      NormalizedDefinitionKind.Skill,
      NormalizedDefinitionKind.Subagent,
    ]),
    rawName: z.string().max(MAX_SHORT_TEXT_LENGTH),
    normalizedName: z.string().max(MAX_SHORT_TEXT_LENGTH),
    content: z.string().max(MAX_LONG_TEXT_LENGTH),
    capturedAt: nullableShortTextSchema,
  })
  .strict();

const toolUseSchema = z
  .object({
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    rawName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    normalizedName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    // FEA-2642 (TC-038): builtin | harness | mcp classification.
    kind: z.enum(["builtin", "harness", "mcp"]).optional(),
    timestamp: nullableShortTextSchema,
    input: boundedUnknownValueSchema.optional(),
    output: boundedUnknownValueSchema.optional(),
    isError: z.boolean().optional(),
    mcpServer: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    mcpMethod: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    skillName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    diffDelta: z
      .object({
        add: z.number(),
        del: z.number(),
      })
      .optional(),
    id: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    providerToolUseId: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    definitionSnapshot: definitionSnapshotSchema.optional(),
    resultTimestamp: optionalNullableShortTextSchema,
    gitBranch: optionalNullableShortTextSchema,
    subagentId: optionalNullableShortTextSchema,
  })
  .strict();
const apiErrorSchema = z
  .object({
    type: optionalNullableShortTextSchema,
    message: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
const toolResultErrorSchema = z
  .object({
    content: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
const turnDurationSchema = z.object({
  durationMs: z.number(),
  timestamp: nullableShortTextSchema,
});
const messageSchema = z
  .object({
    role: z.union([
      z.literal("human"),
      z.literal("assistant"),
      z.literal("system"),
    ]),
    timestamp: nullableShortTextSchema,
    text: z.string().max(MAX_LONG_TEXT_LENGTH).nullable(),
    model: optionalNullableShortTextSchema,
    tokens: messageTokenCountsSchema.optional(),
    isThinking: z.boolean().optional(),
    isSynthetic: z.boolean().optional(),
  })
  .strict();
const tokenRecordSchema = historicalWorkerTokenRecordSchema;
// FEA-3526: Codex-only authoritative per-turn `last_token_usage` snapshot
// (metadata; never alters token totals). Bounded token counters plus the
// parser-derived delta it reconciles against and the drift flag. The counts
// shape is `tokenCountsSchema` minus the attribution-only `inferred` flag (the
// snapshot carries no model-attribution signal) — mirrors the
// `NormalizedTokenCountsBare = Omit<NormalizedTokenCounts, "inferred">` type.
const codexTokenCountsSchema = tokenCountsSchema.omit({ inferred: true });
const codexLastTokenUsageSchema = z
  .object({
    timestamp: nullableShortTextSchema,
    model: z.string().max(MAX_SHORT_TEXT_LENGTH),
    lastTokenUsage: codexTokenCountsSchema,
    derivedDelta: codexTokenCountsSchema,
    drifted: z.boolean(),
  })
  .strict();
const subagentSchema = z
  .object({
    id: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
    parentId: optionalNullableShortTextSchema,
    childSessionId: optionalNullableShortTextSchema,
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    rawName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    normalizedName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    type: optionalNullableShortTextSchema,
    task: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    startedAt: optionalNullableShortTextSchema,
    endedAt: optionalNullableShortTextSchema,
    status: optionalNullableShortTextSchema,
    nativeSubagentId: optionalNullableShortTextSchema,
    toolUses: z.array(toolUseSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    tokensByModel: z
      .record(z.string().max(MAX_SHORT_TEXT_LENGTH), tokenCountsSchema)
      .optional(),
    tokenSeries: z
      .array(tokenRecordSchema)
      .max(MAX_SESSION_ARRAY_ITEMS)
      .optional(),
    definitionSnapshot: definitionSnapshotSchema.optional(),
    // ISS-5797: the key bound AND the entry-count bound are stated here rather
    // than left implicit. Every other record at this boundary gets both from
    // `isBoundedUnknownValue`; this one is a Zod `z.record`, which caps neither,
    // so a malformed worker message carrying hundreds of thousands of small
    // metadata entries passed the schema untouched (wongk review). The producer
    // truncates to the same caps in `clampSessionPayloads`, and both sides ship
    // in one build.
    metadata: z
      .record(z.string().max(MAX_SHORT_TEXT_LENGTH), boundedUnknownValueSchema)
      .refine(
        (record) => Object.keys(record).length <= MAX_UNKNOWN_OBJECT_KEYS,
        {
          message: `subagent metadata must have at most ${MAX_UNKNOWN_OBJECT_KEYS} entries`,
        }
      )
      .optional(),
  })
  .strict();
const slashCommandSchema = z
  .object({
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    timestamp: z.string().max(MAX_SHORT_TEXT_LENGTH),
    userTurnId: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    rawName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    normalizedName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    definitionSnapshot: definitionSnapshotSchema.optional(),
  })
  .strict();
const skillUseSchema = z
  .object({
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    rawName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    normalizedName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    timestamp: nullableShortTextSchema,
    subagentId: optionalNullableShortTextSchema,
    providerToolUseId: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    definitionSnapshot: definitionSnapshotSchema.optional(),
  })
  .strict();
// FEA-4093: a Hook firing (`attachment.type` hook_success/hook_error). The
// `command` field can be a full shell command line, so it is bounded to the
// long-text cap rather than the short one. `.strict()` rejects any un-modeled
// key; the keys-covered guard below makes a new NormalizedHookUse field fail
// `tsc` here instead of silently dropping the whole worker response at runtime.
const hookUseSchema = z
  .object({
    name: z.string().max(MAX_SHORT_TEXT_LENGTH),
    event: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    command: z.string().max(MAX_LONG_TEXT_LENGTH).nullable(),
    succeeded: z.boolean(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
assertWorkerSchemaKeysCovered<NormalizedDefinitionSnapshot>(
  definitionSnapshotSchema.shape
);
assertWorkerSchemaKeysCovered<NormalizedToolUse>(toolUseSchema.shape);
// The runtime schema rejects an unmodelled key, which rejects the containing
// source response and turns that parse request into a nonfatal worker failure.
// This compile-time guard catches the opposite drift: a new record key omitted
// from the worker shape, before that source can reach a utility response.
assertWorkerSchemaKeysCovered<NormalizedTokenRecord>(tokenRecordSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedSubagent>(subagentSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedSlashCommand>(slashCommandSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedSkillUse>(skillUseSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedHookUse>(hookUseSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedApiError>(apiErrorSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedToolResultError>(
  toolResultErrorSchema.shape
);
assertWorkerSchemaKeysCovered<NormalizedMessage>(messageSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedCodexTokenSnapshot>(
  codexLastTokenUsageSchema.shape
);
const planSchema = z
  .object({
    source: optionalNullableShortTextSchema,
    content: z.string().max(MAX_LONG_TEXT_LENGTH).nullable().optional(),
    timestamp: nullableShortTextSchema,
  })
  .strict();
assertWorkerSchemaKeysCovered<NormalizedPlan>(planSchema.shape);
// FEA-2771: parse-quality signal (malformed-line drops). Optional so parsers
// that don't track it still pass this .strict() boundary validator.
const prRefSchema = z.object({
  number: z.string().max(MAX_SHORT_TEXT_LENGTH),
  repo: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
  url: z.string().max(MAX_LONG_TEXT_LENGTH).optional(),
});
const parseQualitySchema = z
  .object({
    totalLines: z.number(),
    malformedLines: z.number(),
    truncatedFinalLine: z.boolean(),
    // FEA-3702: Codex present-but-malformed rate_limits records (last-good
    // preserved). Optional so Claude/other parsers that never set it still pass
    // this `.strict()` boundary; a positive value is a rate-limit data-quality
    // signal, not a parse failure.
    malformedRateLimits: z.number().optional(),
    // FEA-3713: unknown-record count; optional so parsers/sessions that don't
    // track it (Claude core, clean rollouts) still pass this .strict() boundary.
    unknownRecords: z.number().optional(),
    // FEA-3701: tool-output records correlated to no open call (orphaned) or
    // correlated via the legacy positional fallback (ambiguous). Both are
    // emitted by the Codex parser only when non-zero, so they are optional here;
    // omitting them from this `.strict()` boundary rejected the whole worker
    // response and silently dropped the source (the drift the guard below now
    // catches at compile time).
    orphanedToolOutputs: z.number().optional(),
    ambiguousToolOutputs: z.number().optional(),
  })
  .strict();

/**
 * Compile-time exhaustiveness guard (see AGENTS.md "Exhaustiveness"): a key
 * added to `NormalizedParseQuality` that `parseQualitySchema` does not know
 * fails to build here. Without it, the `.strict()` boundary rejects the whole
 * worker response at runtime and the source is silently dropped — the exact
 * FEA-3701 regression this guards against. Runtime no-op.
 */
function assertParseQualityKeysCovered(
  _shape: Record<keyof NormalizedParseQuality, z.ZodTypeAny>
): void {
  /* type-level check only */
}
assertParseQualityKeysCovered(parseQualitySchema.shape);

// FEA-3524: one Codex `rate_limits` window (primary/secondary). Each field is
// nullable, matching the parser's permissive capture; `.strict()` rejects any
// extra keys so a shape drift surfaces at the worker boundary.
const codexRateLimitWindowObjectSchema = z
  .object({
    used_percent: z.number().nullable(),
    window_minutes: z.number().nullable(),
    resets_at: z.number().nullable(),
  })
  .strict();
assertWorkerSchemaKeysCovered<CodexRateLimitWindow>(
  codexRateLimitWindowObjectSchema.shape
);
const codexRateLimitWindowSchema = codexRateLimitWindowObjectSchema.nullable();

// FEA-3524: the positional primary/secondary window pair. Extracted from the
// session shape so `.shape` stays reachable for the keys-covered guard; the
// `.nullable().optional()` wrappers are applied at the use site.
const codexRateLimitsSchema = z
  .object({
    primary: codexRateLimitWindowSchema,
    secondary: codexRateLimitWindowSchema,
  })
  .strict();
assertWorkerSchemaKeysCovered<CodexRateLimits>(codexRateLimitsSchema.shape);

// FEA-3715: the reviewed Codex protocol pin. Extracted for the same reason as
// the rate-limit pair above; `.optional()` is applied at the use site.
const codexProtocolSupportSchema = z
  .object({
    referenceRepo: z.string().max(MAX_SHORT_TEXT_LENGTH),
    pinnedCommit: z.string().max(MAX_SHORT_TEXT_LENGTH),
    reviewedOn: z.string().max(MAX_SHORT_TEXT_LENGTH),
    supportedRange: z.string().max(MAX_SHORT_TEXT_LENGTH),
  })
  .strict();
assertWorkerSchemaKeysCovered<CodexProtocolSupport>(
  codexProtocolSupportSchema.shape
);

export const HistoricalParseWorkerRequestType = {
  ParseSource: "parseSource",
} as const;

export type HistoricalParseWorkerRequestType =
  (typeof HistoricalParseWorkerRequestType)[keyof typeof HistoricalParseWorkerRequestType];

export const HistoricalParseWorkerResponseType = {
  Parsed: "parsed",
  Failed: "failed",
} as const;

export type HistoricalParseWorkerResponseType =
  (typeof HistoricalParseWorkerResponseType)[keyof typeof HistoricalParseWorkerResponseType];

/** Worker request envelope for one bounded parser job. */
export const historicalParseWorkerRequestSchema = z.object({
  type: z.literal(HistoricalParseWorkerRequestType.ParseSource),
  requestId: z.string().min(1),
  collectorKey: z.enum(HarnessValues),
  source: z.string().min(1),
});

export type HistoricalParseWorkerRequest = z.infer<
  typeof historicalParseWorkerRequestSchema
>;

/** Runtime validator for parser output crossing the utility-process boundary. */
const normalizedSessionObjectSchema = z
  .object({
    sessionId: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
    name: z.string().max(MAX_LONG_TEXT_LENGTH),
    cwd: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    model: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    // FEA-4376: flags `model` as a `/model`-switch display-label fallback rather
    // than a real assistant wire id, so the importer keeps the model column
    // upgradeable. `.optional()` (not `.default`) mirrors the NormalizedSession
    // contract: pre-FEA-4376 cached worker payloads omit it and round-trip
    // through this `.strict()` boundary unchanged (the importer treats an absent
    // flag as false — a stored model that is not flagged a fallback stays sticky).
    modelIsFallback: z.boolean().optional(),
    version: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    slug: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    gitBranch: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    startedAt: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    endedAt: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    teams: z.array(boundedUnknownValueSchema).max(MAX_SESSION_ARRAY_ITEMS),
    userMessages: z.number(),
    assistantMessages: z.number(),
    tokensByModel: z.record(
      z.string().max(MAX_SHORT_TEXT_LENGTH),
      tokenCountsSchema
    ),
    messageTimestamps: z
      .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
      .max(MAX_SESSION_ARRAY_ITEMS),
    toolUses: z.array(toolUseSchema).max(MAX_SESSION_ARRAY_ITEMS),
    subagents: z.array(subagentSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    plans: z.array(planSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    parseQuality: parseQualitySchema.optional(),
    compactions: z
      .array(boundedUnknownValueSchema)
      .max(MAX_SESSION_ARRAY_ITEMS),
    apiErrors: z.array(apiErrorSchema).max(MAX_SESSION_ARRAY_ITEMS),
    fileModifiedAt: z.number().nullable(),
    turnDurations: z.array(turnDurationSchema).max(MAX_SESSION_ARRAY_ITEMS),
    entrypoint: z.string().max(MAX_SHORT_TEXT_LENGTH),
    permissionMode: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    thinkingBlockCount: z.number(),
    toolResultErrors: z
      .array(toolResultErrorSchema)
      .max(MAX_SESSION_ARRAY_ITEMS),
    usageExtras: z.object({
      service_tiers: z
        .array(boundedUnknownValueSchema)
        .max(MAX_SESSION_ARRAY_ITEMS),
      speeds: z.array(boundedUnknownValueSchema).max(MAX_SESSION_ARRAY_ITEMS),
      inference_geos: z
        .array(boundedUnknownValueSchema)
        .max(MAX_SESSION_ARRAY_ITEMS),
      // FEA-3527: Codex reasoning-output subdivision (subset of output_tokens,
      // never additive). `.default(0)` keeps the parsed OUTPUT required (matching
      // the NormalizedSession contract) while letting pre-FEA-3527 worker
      // payloads that omit it validate and fill 0. The parser always emits it via
      // `emptyUsageExtras`.
      reasoning_output_tokens: z.number().default(0),
      // FEA-3419: the FEA-3496 session-level `cache_creation` blob is GONE from
      // the contract (the split now rides tokensByModel/tokenSeries as typed
      // fields). This plain z.object strips the unknown key from any stale
      // payload that still carries it, so old-shape payloads validate cleanly.
      // PRD-538: session-level web-search request count. `.default(0)` keeps the
      // parsed OUTPUT required (matching the NormalizedSession contract) while
      // letting pre-PRD-538 worker payloads that omit it validate and fill 0. The
      // parser always emits it via `emptyUsageExtras`.
      web_search_requests: z.number().default(0),
    }),
    messages: z.array(messageSchema).max(MAX_SESSION_ARRAY_ITEMS),
    tokenSeries: z.array(tokenRecordSchema).max(MAX_SESSION_ARRAY_ITEMS),
    // FEA-3526: optional so non-Codex parsers and pre-existing payloads that
    // omit it round-trip; the Codex parser emits it only when present.
    codexLastTokenUsage: z
      .array(codexLastTokenUsageSchema)
      .max(MAX_SESSION_ARRAY_ITEMS)
      .optional(),
    diffStats: z
      .object({
        filesChanged: z.number(),
        linesAdded: z.number(),
        linesRemoved: z.number(),
      })
      .nullable(),
    slashCommands: z.array(slashCommandSchema).max(MAX_SESSION_ARRAY_ITEMS),
    // FEA-2642 (TC-039): first-class Skill invocations (per-agent via subagentId).
    skills: z.array(skillUseSchema).max(MAX_SESSION_ARRAY_ITEMS),
    // FEA-4093: first-class Hook firings. `.default([])` keeps the parsed
    // OUTPUT required (matching the NormalizedSession contract, where the
    // parser always emits it via `createNormalizedSession`) while letting a
    // pre-FEA-4093 cached worker payload that omits the field validate and
    // fill an empty list under this `.strict()` boundary.
    hooks: z.array(hookUseSchema).max(MAX_SESSION_ARRAY_ITEMS).default([]),
    artifacts: z.object({
      prs: z.array(prRefSchema).max(MAX_SESSION_ARRAY_ITEMS),
      issues: z
        .array(
          z.object({
            key: z.string().max(MAX_SHORT_TEXT_LENGTH),
          })
        )
        .max(MAX_SESSION_ARRAY_ITEMS),
      repo: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    }),
    prLinks: z.array(prRefSchema).max(MAX_SESSION_ARRAY_ITEMS),
    // FEA-3525: Codex model context-window size (tokens). `.optional()` lets
    // pre-FEA-3525 worker payloads that omit it validate under `.strict()`
    // (mirroring the FEA-3496 default-for-round-trip precedent for an OPTIONAL
    // field); the codex parser omits it entirely when unreported.
    modelContextWindow: z.number().nonnegative().optional().nullable(),
    // FEA-3524: Codex `token_count` rate_limits snapshot. `.optional()` (not
    // `.default`) mirrors the NormalizedSession contract, where the field is
    // absent unless a well-formed block was captured — so rate_limits-null Codex
    // sessions and every non-Codex payload round-trip through the worker
    // boundary unchanged. Each numeric window field is nullable; a `.strict()`
    // object rejects the harness's un-modeled extras (limit_id, plan_type, …),
    // which the parser already strips before this boundary.
    codexRateLimits: codexRateLimitsSchema.nullable().optional(),
    // FEA-3708: Codex parent-rollout lineage pointer (session_meta.forked_from_id).
    // `optionalNullableShortTextSchema` (like the sibling short-text fields)
    // mirrors the NormalizedSession contract: the field is absent unless the
    // rollout was forked/resumed, so root Codex sessions and every non-Codex
    // payload round-trip through the worker boundary unchanged under `.strict()`.
    codexForkedFromId: optionalNullableShortTextSchema,
    // FEA-3715: static Codex protocol pin recorded in parser output. `.optional()`
    // (not `.default`) mirrors the NormalizedSession contract — non-Codex parsers
    // and pre-FEA-3715 worker payloads omit it entirely and round-trip through the
    // `.strict()` boundary unchanged. A `.strict()` inner object rejects any
    // un-modeled extra so the pin shape stays reviewed.
    codexProtocolSupport: codexProtocolSupportSchema.optional(),
    // FEA-4187: failed-run signal stamped from the FULL parsed session before
    // the response clamp (see createHistoricalParseWorkerParsedResponse), so
    // the import path classifies a run that ended on an unrecovered API error
    // as ERROR, not COMPLETED. `.optional()` (not `.default`) mirrors the
    // NormalizedSession contract: pre-FEA-4187 cached worker payloads omit it
    // and round-trip through this `.strict()` boundary unchanged, and the
    // import path falls back to re-deriving from the on-hand arrays when absent.
    endedOnUnrecoveredError: z.boolean().optional(),
  })
  .strict();

/**
 * Fields deliberately NOT carried across the historical-parse-worker boundary:
 * both are transient live-watcher/main-process context (`importMode` is absent on
 * browser/historical parsers; `invocationDefinitionEvidence` is created only
 * during the original live watcher pass), so the historical parser never emits
 * them and the response schema intentionally omits them. Excluded from the
 * key-coverage guard below so their absence is a documented boundary decision,
 * not an accidental gap.
 */
type WorkerBoundaryOmittedSessionKeys =
  | "importMode"
  | "invocationDefinitionEvidence";

/**
 * Compile-time key-coverage guard for `normalizedSessionSchema` (mirrors
 * `assertParseQualityKeysCovered`). `z.ZodType<NormalizedSession>` only enforces
 * assignability, so a newly-added — especially conditionally-emitted — field
 * on `NormalizedSession` can be OMITTED from the object schema above and still
 * typecheck: the `.strict()` boundary would then reject the whole worker payload
 * at runtime and silently drop the session (the FEA-3701 class of regression).
 * Typing the raw shape as `Record<keyof …, z.ZodTypeAny>` over every carried key
 * makes the next omitted field fail `tsc` here instead of production. Runtime
 * no-op.
 */
function assertNormalizedSessionKeysCovered(
  _shape: Record<
    Exclude<keyof NormalizedSession, WorkerBoundaryOmittedSessionKeys>,
    z.ZodTypeAny
  >
): void {
  /* type-level check only */
}
assertNormalizedSessionKeysCovered(normalizedSessionObjectSchema.shape);

export const normalizedSessionSchema: z.ZodType<NormalizedSession> =
  normalizedSessionObjectSchema;

export type HistoricalParseWorkerResponse = z.infer<
  typeof historicalParseWorkerResponseSchema
>;

export type HistoricalParseWorkerFailureKind =
  | "parser_output_validation"
  | "worker_failure";

/**
 * Error raised by the main-process runner for schema-valid worker failures.
 * Rebuild code uses the kind to separate parser-output validation failures
 * from benign read/source errors that should simply retry next launch.
 */
export class HistoricalParseWorkerFailureError extends Error {
  readonly kind: HistoricalParseWorkerFailureKind;
  readonly diagnostic?: string;

  constructor(
    message: string,
    kind: HistoricalParseWorkerFailureKind,
    diagnostic?: string
  ) {
    super(message);
    this.name = "HistoricalParseWorkerFailureError";
    this.kind = kind;
    this.diagnostic = diagnostic;
  }
}

/**
 * ISS-5266 (wongk review): the WITHHELD-subagent side-report, on the wire.
 *
 * The OpenCode collector produces this as a SIDE EFFECT of `parse`, and in the
 * in-process path it reaches the store through the collector's injected
 * `recordWithheld` sink. A historical/boot parse runs in the utility process
 * instead, where the collector is a DIFFERENT instance with no DB handle and no
 * sink — so without a wire field the report is simply discarded and the store's
 * withheld table stays empty for every source imported the normal way.
 *
 * Modelled OPTIONALLY and additively, per the repo's cross-version contract: a
 * worker build that does not send it (and every non-OpenCode parse, which never
 * has one) parses exactly as before, and the field is OMITTED rather than sent
 * as `null` when there is nothing to report.
 */
const withheldSubagentRootSchema = z
  .object({
    rootRawId: z.string().max(MAX_SHORT_TEXT_LENGTH),
    withheldCount: z.number().int().nonnegative(),
    reason: z.string().max(MAX_SHORT_TEXT_LENGTH),
    withheldTokens: safeStorageTokenCountSchema.nullable(),
    withheldCacheTokens: safeStorageTokenCountSchema.nullable(),
    earliestChildStartedAt: nullableShortTextSchema,
    latestChildEndedAt: nullableShortTextSchema,
    windowPartial: z.boolean(),
  })
  .strict();
assertWorkerSchemaKeysCovered<OpencodeWithheldSubagentRoot>(
  withheldSubagentRootSchema.shape
);

const withheldSubagentReportSchema = z
  .object({
    sourcePath: z.string().max(MAX_LONG_TEXT_LENGTH),
    roots: z.array(withheldSubagentRootSchema).max(MAX_SESSION_ARRAY_ITEMS),
  })
  .strict();
assertWorkerSchemaKeysCovered<OpencodeWithheldSubagentReport>(
  withheldSubagentReportSchema.shape
);

/** Worker response envelope. */
export const historicalParseWorkerResponseSchema = z.union([
  z
    .object({
      type: z.literal(HistoricalParseWorkerResponseType.Parsed),
      requestId: z.string().min(1),
      sessions: z
        .array(normalizedSessionSchema)
        .max(MAX_WORKER_SESSIONS_PER_SOURCE),
      /**
       * ISS-5266: present only for an OpenCode parse that produced a report.
       * The Parsed branch is a PLAIN `z.object`, so an unmodelled key here would
       * be silently STRIPPED rather than rejected (see
       * {@link assertWorkerSchemaKeysCovered}) — the quiet half of the FEA-3701
       * failure mode, and precisely how this field would have gone missing.
       */
      withheldOpencodeSubagents: withheldSubagentReportSchema.optional(),
    })
    .superRefine((response, context) => {
      const summary = summarizeWorkerResponsePayload(response.sessions);
      if (
        summary.arrayItems >
        HistoricalParseWorkerLimits.maxWorkerResponseArrayItems
      ) {
        context.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: HistoricalParseWorkerLimits.maxWorkerResponseArrayItems,
          origin: "array",
          inclusive: true,
          message: "historical parse worker response has too many rows",
        });
      }
      if (
        summary.textBytes >
        HistoricalParseWorkerLimits.maxWorkerResponseTextBytes
      ) {
        context.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: HistoricalParseWorkerLimits.maxWorkerResponseTextBytes,
          origin: "string",
          inclusive: true,
          message: "historical parse worker response text payload is too large",
        });
      }
    }),
  z.object({
    type: z.literal(HistoricalParseWorkerResponseType.Failed),
    requestId: z.string().min(1),
    message: z.string().max(MAX_LONG_TEXT_LENGTH),
    fatal: z.literal(true).optional(),
    diagnostic: z.string().max(MAX_LONG_TEXT_LENGTH).optional(),
  }),
]);

/**
 * Validate parser output before it leaves the utility process. Parsed sessions
 * are first clamped to the worker response budget; if malformed data still
 * fails the response schema, return a small nonfatal diagnostic instead of
 * sending an oversized or invalid structured clone into Electron's main process.
 */
export function createHistoricalParseWorkerParsedResponse(
  requestId: string,
  sessions: NormalizedSession[],
  // ISS-5266: the parse's side-report, when it produced one. Optional so every
  // existing caller and every non-OpenCode parse is unchanged, and OMITTED from
  // the envelope (never sent as `null`) when absent.
  withheldOpencodeSubagents?: OpencodeWithheldSubagentReport
): HistoricalParseWorkerResponse {
  // FEA-4187: stamp the failed-run signal from the FULL parsed session BEFORE
  // the response array clamp, so a truncated trailing `apiErrors`/`messages`
  // tail can't erase it. The import path (write-core) reads this flag to
  // classify a run that ended on an unrecovered API error as ERROR rather than
  // COMPLETED. Preserve an explicit flag a parser already set (never downgrade
  // a known failure); otherwise derive it here.
  const signaledSessions = sessions.map((session) => ({
    ...session,
    endedOnUnrecoveredError:
      session.endedOnUnrecoveredError === true ||
      deriveEndedOnUnrecoveredError(session),
  }));
  let clampedSessions: NormalizedSession[];
  try {
    clampedSessions = clampSessionsForWorkerResponse(signaledSessions);
  } catch (error) {
    return createHistoricalParseWorkerFailedResponse(
      requestId,
      invalidResponseMessage(requestId),
      {
        diagnostic: error instanceof Error ? error.message : String(error),
      }
    );
  }

  const response = {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId,
    sessions: clampedSessions,
    ...(withheldOpencodeSubagents ? { withheldOpencodeSubagents } : {}),
  };
  const parsedResponse =
    historicalParseWorkerResponseSchema.safeParse(response);
  if (parsedResponse.success) {
    return parsedResponse.data;
  }

  // The response envelope is a plain `z.union`, so a single failing session
  // collapses the whole error to a root-level `invalid_union` with no path (the
  // unhelpful `<root>:invalid_union` operators were seeing). Re-validate the
  // sessions array on its own to surface the offending field
  // (e.g. `sessions.0.name:too_big`); fall back to the envelope error only when
  // the sessions are individually valid — i.e. the failure was the response-wide
  // size budget in the Parsed branch's superRefine.
  const sessionsResult = z
    .object({ sessions: z.array(normalizedSessionSchema) })
    .safeParse({ sessions: clampedSessions });
  const diagnostic = sessionsResult.success
    ? summarizeHistoricalWorkerResponseIssues(parsedResponse.error)
    : summarizeHistoricalWorkerResponseIssues(sessionsResult.error);

  return createHistoricalParseWorkerFailedResponse(
    requestId,
    invalidResponseMessage(requestId),
    {
      diagnostic,
    }
  );
}

/**
 * Build a schema-valid bounded failure envelope for one worker request. Parser
 * output validation failures are nonfatal by default so the parent rejects only
 * the affected request; pass `fatal: true` only for infrastructure-terminal
 * worker failures.
 */
export function createHistoricalParseWorkerFailedResponse(
  requestId: string,
  message: string,
  options?: {
    diagnostic?: string;
    fatal?: boolean;
  }
): HistoricalParseWorkerResponse {
  const safeRequestId = requestId.trim() || "unknown-request";
  const safeMessage = boundedDiagnosticText(message);
  const safeDiagnostic = options?.diagnostic
    ? boundedDiagnosticText(options.diagnostic)
    : undefined;
  const response = {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: safeRequestId,
    message: safeMessage || "historical parse worker failed",
  };
  const responseWithOptionalFields = {
    ...response,
    ...(options?.fatal ? { fatal: true as const } : {}),
    ...(safeDiagnostic ? { diagnostic: safeDiagnostic } : {}),
  };
  const parsed = historicalParseWorkerResponseSchema.safeParse(response);
  const parsedWithOptionalFields =
    historicalParseWorkerResponseSchema.safeParse(responseWithOptionalFields);
  if (parsedWithOptionalFields.success) {
    return parsedWithOptionalFields.data;
  }
  if (parsed.success) {
    return parsed.data;
  }
  const fallback = {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: safeRequestId,
    message: "historical parse worker failed",
  };
  return options?.fatal ? { ...fallback, fatal: true } : fallback;
}

/** Return bounded schema diagnostics without echoing raw transcript payloads. */
export function summarizeHistoricalWorkerResponseIssues(
  error: z.ZodError
): string {
  const flatIssues = flattenZodIssues(error.issues);
  const issues = flatIssues.slice(0, MAX_RESPONSE_ISSUE_COUNT).map((issue) => {
    const path = issue.path.map(String).join(".") || "<root>";
    const message = truncateResponseIssueText(issue.message);
    return `${path}:${issue.code}:${message}`;
  });
  const suffix =
    flatIssues.length > MAX_RESPONSE_ISSUE_COUNT
      ? `; +${flatIssues.length - MAX_RESPONSE_ISSUE_COUNT} more`
      : "";
  return `${issues.join("; ")}${suffix}`;
}

/** True when a runner error represents malformed parser output. */
export function isHistoricalParseWorkerParserOutputError(
  error: unknown
): boolean {
  return (
    error instanceof HistoricalParseWorkerFailureError &&
    error.kind === "parser_output_validation"
  );
}

/** Classify a schema-valid worker failure response for runner callers. */
export function errorFromHistoricalParseWorkerFailure(
  response: Extract<
    HistoricalParseWorkerResponse,
    { type: typeof HistoricalParseWorkerResponseType.Failed }
  >
): HistoricalParseWorkerFailureError {
  return new HistoricalParseWorkerFailureError(
    response.message,
    response.message.startsWith(WORKER_INVALID_RESPONSE_MESSAGE_PREFIX)
      ? "parser_output_validation"
      : "worker_failure",
    response.diagnostic
  );
}

/** Extract a safe request id from an otherwise malformed worker payload. */
export function requestIdFromWorkerMessage(message: unknown): string | null {
  const parsedMessage = workerMessageRequestIdSchema.safeParse(message);
  return parsedMessage.success ? parsedMessage.data.requestId : null;
}

function truncateResponseIssueText(message: string): string {
  if (message.length <= MAX_RESPONSE_ISSUE_TEXT_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_RESPONSE_ISSUE_TEXT_LENGTH)}...`;
}

function invalidResponseMessage(requestId: string): string {
  return `${WORKER_INVALID_RESPONSE_MESSAGE_PREFIX} for ${requestId}`;
}

function flattenZodIssues(issues: z.ZodIssue[], depth = 0): z.ZodIssue[] {
  const flattened: z.ZodIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      if (depth >= MAX_RESPONSE_ISSUE_UNION_DEPTH) {
        flattened.push(issue);
        continue;
      }
      let nestedIssueCount = 0;
      for (const nested of issue.errors) {
        const nestedIssues = flattenZodIssues(nested, depth + 1);
        nestedIssueCount += nestedIssues.length;
        flattened.push(...nestedIssues);
      }
      if (nestedIssueCount === 0) {
        flattened.push(issue);
      }
      continue;
    }
    flattened.push(issue);
  }
  return flattened;
}

/**
 * Compile-time guard for worker-boundary schemas over normalized types.
 *
 * FEA-3597: applies to BOTH schema kinds, which fail differently when a key is
 * unmodelled — a `.strict()` schema rejects the whole worker response (loud, the
 * source is dropped and retried); a plain `z.object` silently STRIPS the key
 * (quiet, the field is simply gone and every consumer sees a default). The
 * guard is therefore most valuable on the non-strict schemas, where nothing
 * else would ever surface the omission.
 *
 * ONE-DIRECTIONAL, deliberately. Callers pass `schema.shape`, a property access
 * rather than a fresh object literal, so TypeScript applies ordinary structural
 * assignability and NOT excess-property checking: a key ADDED to the normalized
 * type and left untaught here fails `tsc` (the FEA-3701 case this exists for),
 * but a STRAY key present on the schema and absent from the type does not. The
 * `satisfies Record<keyof T, z.ZodTypeAny>` spelling used on shape literals
 * elsewhere in the repo catches both directions; prefer it for a NEW boundary,
 * and read a green result here as "nothing is missing", not "nothing is extra".
 */
function assertWorkerSchemaKeysCovered<T>(
  _shape: { [Key in keyof T]-?: z.ZodTypeAny }
): void {
  /* type-level check only */
}
