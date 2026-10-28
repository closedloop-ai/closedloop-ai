import {
  MAX_CANDIDATE_REQUEST_KEYS,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { parsePullRequestNumber } from "@repo/api/src/types/session-artifact-link";
import {
  tokenCostSummarySchema,
  tokenEventTransportIdSchema,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import type { HarnessLaunchAttribution } from "@repo/lib/harness/launch-attribution";
import {
  LaunchThreadSource,
  MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS,
} from "@repo/lib/harness/launch-attribution";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import {
  safeStorageCountSchema,
  safeStorageOrdinalSchema,
} from "@repo/lib/harness/safe-counts";
import {
  type ClosedloopResultFacts,
  MAX_NESTED_RESULT_SLUGS,
  MAX_SHELL_OPERATION_IDS,
} from "@repo/lib/harness/tool-result-facts";
import { protoSafeRecord } from "@repo/lib/security/proto-safe-record";
import { z } from "zod";
import { safeStorageTokenCountSchema } from "../../cost/token-counts.js";
import {
  type ClaudeDesktopOrigin,
  type CodexProtocolSupport,
  type CodexRateLimits,
  type CodexRateLimitWindow,
  type NormalizedApiError,
  type NormalizedCodexTokenSnapshot,
  type NormalizedComponentUsage,
  NormalizedDefinitionKind,
  type NormalizedDefinitionSnapshot,
  type NormalizedHookUse,
  type NormalizedMessage,
  type NormalizedPlan,
  type NormalizedSession,
  type NormalizedSkillUse,
  type NormalizedSlashCommand,
  type NormalizedSubagent,
  type NormalizedTokenRecord,
  type NormalizedTokenSeriesTruncation,
  type NormalizedToolResultError,
  type NormalizedToolUse,
} from "../types.js";
import {
  HistoricalParseWorkerLimits,
  isBoundedUnknownValue,
} from "./historical-parse-worker-limits-and-clamping.js";

const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_UNKNOWN_OBJECT_KEYS =
  HistoricalParseWorkerLimits.maxUnknownObjectKeys;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;

/** Optional cache-write TTL subdivision carried by usage and event records. */
export const cacheWriteTtlSchema = z.object({
  fiveM: z.number().int().nonnegative(),
  oneH: z.number().int().nonnegative(),
});

/**
 * Strict historical-worker transport for every `NormalizedTokenRecord` key.
 * The protocol owner also binds this shape to `keyof NormalizedTokenRecord` so
 * a future source-type field cannot be omitted silently.
 */
export const historicalWorkerTokenRecordSchema = z
  .object({
    timestamp: z.string().max(MAX_SHORT_TEXT_LENGTH),
    model: z.string().max(MAX_SHORT_TEXT_LENGTH),
    input: safeStorageTokenCountSchema,
    output: safeStorageTokenCountSchema,
    cacheRead: safeStorageTokenCountSchema,
    cacheWrite: safeStorageTokenCountSchema,
    cacheWriteTtl: cacheWriteTtlSchema.optional(),
    inferred: z.boolean().optional(),
    subagentId: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    transportId: tokenEventTransportIdSchema.optional(),
    sourceIdentity: tokenSourceIdentitySchema.optional(),
    costSummary: tokenCostSummarySchema.optional(),
  })
  .strict();

export const nullableShortTextSchema = z
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

// ISS-12552: a ClosedLoop tool's response-root facts, read before the cap.
// Every member is bounded: short strings, a capped slug list.
const closedloopResultFactsSchema = z
  .object({
    isError: z.boolean(),
    operationReceipt: z
      .object({
        operationId: z.string().max(MAX_SHORT_TEXT_LENGTH),
        outcome: z.string().max(MAX_SHORT_TEXT_LENGTH),
      })
      .strict()
      .optional(),
    primaryEntity: z
      .object({
        id: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
        slug: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
        version: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict()
      .optional(),
    nestedSlugs: z
      .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
      .max(MAX_NESTED_RESULT_SLUGS),
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
    mcpNamespace: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    skillName: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    diffDelta: z
      .object({
        add: z.number(),
        del: z.number(),
      })
      .optional(),
    id: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    providerToolUseId: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    requestKey: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
    candidateRequestKeys: z
      .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
      .max(MAX_CANDIDATE_REQUEST_KEYS)
      .optional(),
    requestUnresolved: z.literal(true).optional(),
    definitionSnapshot: definitionSnapshotSchema.optional(),
    resultTimestamp: optionalNullableShortTextSchema,
    gitBranch: optionalNullableShortTextSchema,
    subagentId: optionalNullableShortTextSchema,
    // ISS-10736: the result's context footprint, counted before `output` above
    // was size-capped. Bounded to the same safe-integer ceiling the invocation
    // wire contract enforces, so a corrupt worker payload is rejected here
    // rather than persisted as a confident measurement.
    outputFootprintTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    resultState: z.enum(ToolResultState).optional(),
    closedloopResultFacts: closedloopResultFactsSchema.optional(),
    shellOperationIds: z
      .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
      .max(MAX_SHELL_OPERATION_IDS)
      .optional(),
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
    isForkReplayed: z.boolean().optional(),
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
// ISS-7534: the tail the response clamp removed from `tokenSeries`. The counts
// shape reuses the same bare-counters schema as the Codex snapshot above rather
// than restating four counters, so the two cannot drift.
const tokenSeriesTruncationSchema = z
  .object({
    droppedRecords: z.number().int().min(1),
    droppedTokens: codexTokenCountsSchema,
  })
  .strict();
assertWorkerSchemaKeysCovered<NormalizedTokenSeriesTruncation>(
  tokenSeriesTruncationSchema.shape
);
/**
 * ISS-7258: one worktree entry, as the TWO DISJOINT shapes the harness emits —
 * a created worktree stating its base, or an entered one stating
 * `enteredExisting`. A union rather than one all-optional object so this
 * boundary rejects a half-formed entry instead of carrying it, matching the
 * valid-or-absent contract the parser enforces on the way in.
 */
type WorktreeEntry = NonNullable<NormalizedSession["worktreeEntries"]>[number];
type WorktreeEntryCreatedArm = Extract<
  WorktreeEntry,
  { originalBranch: string }
>;
type WorktreeEntryEnteredArm = Extract<
  WorktreeEntry,
  { enteredExisting: true }
>;
const worktreeEntryCommonShape = {
  worktreePath: z.string().max(MAX_SHORT_TEXT_LENGTH),
  worktreeName: z.string().max(MAX_SHORT_TEXT_LENGTH),
  worktreeBranch: z.string().max(MAX_SHORT_TEXT_LENGTH),
  originalCwd: z.string().max(MAX_SHORT_TEXT_LENGTH),
  preEnterOriginalCwd: z.string().max(MAX_SHORT_TEXT_LENGTH),
};
/**
 * ISS-7258 (cr-57285): each arm carries the `satisfies` spelling the guard
 * doctrine at the foot of this file recommends for a NEW boundary, because it
 * checks BOTH directions — a field added to either arm of the normalized entry
 * fails `tsc` here, and so does a stray key present only on the schema. The
 * one-directional `assertWorkerSchemaKeysCovered` used by the older schemas
 * cannot be applied to a union's arms, and without either guard a newly emitted
 * field would not merely go missing: these arms are `.strict()`, so it rejects
 * the ENTIRE worker response and re-drops the source on every retry.
 */
const worktreeEntrySchema = z.union([
  z
    .object({
      ...worktreeEntryCommonShape,
      originalBranch: z.string().max(MAX_SHORT_TEXT_LENGTH),
      originalHeadCommit: z.string().max(MAX_SHORT_TEXT_LENGTH),
    } satisfies Record<keyof WorktreeEntryCreatedArm, z.ZodTypeAny>)
    .strict(),
  z
    .object({
      ...worktreeEntryCommonShape,
      enteredExisting: z.literal(true),
    } satisfies Record<keyof WorktreeEntryEnteredArm, z.ZodTypeAny>)
    .strict(),
]);

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
    // ISS-8565: NOT `z.record`, for the same reason as the session-level map
    // below. `opencode-subagent-fold.ts:101` copies the CHILD's `tokensByModel`
    // onto the subagent verbatim, so a model named `__proto__` lost the
    // subagent's whole spend crossing this boundary — the session-level fix
    // alone left the map four lines over on the defective validator
    // (marisolashgrove review).
    tokensByModel: protoSafeRecord(
      z.string().max(MAX_SHORT_TEXT_LENGTH),
      tokenCountsSchema
    ).optional(),
    tokenSeries: z
      .array(tokenRecordSchema)
      .max(MAX_SESSION_ARRAY_ITEMS)
      .optional(),
    definitionSnapshot: definitionSnapshotSchema.optional(),
    // ISS-5797: the key bound AND the entry-count bound are stated here rather
    // than left implicit. Every other record at this boundary gets both from
    // `isBoundedUnknownValue`; this one is a record codec, which caps neither,
    // so a malformed worker message carrying hundreds of thousands of small
    // metadata entries passed the schema untouched (whitlockk review). The producer
    // truncates to the same caps in `clampSessionPayloads`, and both sides ship
    // in one build. Both bounds are retained verbatim below — ISS-10177 swapped
    // only the CONTAINER, and neither codec caps anything on its own.
    //
    // ISS-10177: `protoSafeRecord`, not `z.record`, for the same reason as
    // `tokensByModel` sixteen lines above — `z.record` silently drops an own
    // `__proto__` key crossing this worker boundary. That earlier fix landed on
    // the sibling and left this neighbour on the defective validator.
    metadata: protoSafeRecord(
      z.string().max(MAX_SHORT_TEXT_LENGTH),
      boundedUnknownValueSchema
    )
      .refine(
        (record) => Object.keys(record).length <= MAX_UNKNOWN_OBJECT_KEYS,
        {
          message: `subagent metadata must have at most ${MAX_UNKNOWN_OBJECT_KEYS} entries`,
        }
      )
      .optional(),
  })
  .strict();
/**
 * ISS-7795: per-invocation measured usage. Token counts are bounded to the same
 * safe-integer ceiling the invocation wire contract enforces, so a corrupt
 * worker payload is rejected here rather than persisted. `model` is nullable
 * because an invocation whose turns spanned two models has no single one.
 */
const componentUsageSchema = z
  .object({
    model: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheReadTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    cacheWriteTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    cacheWriteTtl: cacheWriteTtlSchema.optional(),
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
    usage: componentUsageSchema.optional(),
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
    usage: componentUsageSchema.optional(),
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
    // ISS-10736: the stdout footprint, counted at parse time. The count crosses
    // this boundary rather than the stdout itself, so a hook that printed a
    // large block cannot push the worker payload past its caps.
    stdoutFootprintTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();
assertWorkerSchemaKeysCovered<NormalizedDefinitionSnapshot>(
  definitionSnapshotSchema.shape
);
assertWorkerSchemaKeysCovered<NormalizedToolUse>(toolUseSchema.shape);
assertWorkerSchemaKeysCovered<ClosedloopResultFacts>(
  closedloopResultFactsSchema.shape
);
// The runtime schema rejects an unmodelled key, which rejects the containing
// source response and turns that parse request into a nonfatal worker failure.
// This compile-time guard catches the opposite drift: a new record key omitted
// from the worker shape, before that source can reach a utility response.
assertWorkerSchemaKeysCovered<NormalizedTokenRecord>(tokenRecordSchema.shape);
assertWorkerSchemaKeysCovered<NormalizedSubagent>(subagentSchema.shape);
// ISS-7261: `cacheWriteTtl` reaching this schema is what keeps a one-hour cache
// write priced at its own rate; the guard makes the next priced field fail
// `tsc` here rather than be dropped by `.strict()` at runtime.
assertWorkerSchemaKeysCovered<NormalizedComponentUsage>(
  componentUsageSchema.shape
);
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
const artifactPrRefSchema = z.object({
  number: z.string().max(MAX_SHORT_TEXT_LENGTH),
  repo: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
  url: z.string().max(MAX_LONG_TEXT_LENGTH).optional(),
});
const prRefSchema = artifactPrRefSchema.extend({
  number: z
    .string()
    .max(MAX_SHORT_TEXT_LENGTH)
    .refine((number) => parsePullRequestNumber(number) !== null),
});
/**
 * ISS-7198. `title` is the one FREE-TEXT member and is already bounded by the
 * sidecar decoder; the short-text cap here is the boundary's own backstop against
 * a payload that did not come through it. `.strict()` because WE own this shape.
 */
const claudeDesktopOriginSchema = z
  .object({
    sessionId: z.string().max(MAX_SHORT_TEXT_LENGTH),
    title: nullableShortTextSchema,
    scheduledTaskId: nullableShortTextSchema,
    archived: z.boolean(),
  })
  .strict();
/**
 * ISS-7259. Every member is `.optional()` and never `.nullable()`: the facet's
 * contract is omission, so a `null` arriving here is a producer that broke it and
 * should be rejected rather than persisted as a fact. The enum is built from
 * the `LaunchThreadSource` const object itself rather than a restated list, so a
 * member added to the union cannot be silently rejected by this `.strict()` boundary — which, being strict,
 * would drop the WHOLE session payload and not just the key.
 */
const launchAttributionValueSchema = z
  .string()
  .max(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS);
const harnessLaunchAttributionSchema = z
  .object({
    firstAttributedSkill: launchAttributionValueSchema.optional(),
    // ISS-9047 (davetho review, PR #7220): the safe-integer arm, not just
    // `.int()`. `Number.isInteger(1e300)` is `true`, so a magnitude that has
    // already lost precision in JS cleared the old bound and reached the
    // persisted attribution metadata as a confident skill tally.
    observedSkillCount: safeStorageCountSchema.optional(),
    // ISS-7508. An ORDINAL rather than a count, because both are bounded tighter:
    // the index is 1-BASED, and a transcript that carried a nameable skill
    // necessarily carried at least the one record that stated it. A 0 arriving on
    // either is a producer that computed it 0-based or never populated it, and
    // persisting it would sync a record position that does not exist — the same
    // plausible-but-wrong class the `depth` bound rejects. `safeStorageOrdinalSchema`
    // carries the safe-integer arm with it (ISS-9047).
    firstAttributedRecordIndex: safeStorageOrdinalSchema.optional(),
    observedRecordCount: safeStorageOrdinalSchema.optional(),
    promptSource: launchAttributionValueSchema.optional(),
    threadSource: z.enum(LaunchThreadSource),
    agentRole: launchAttributionValueSchema.optional(),
    agentNickname: launchAttributionValueSchema.optional(),
    parentThreadId: launchAttributionValueSchema.optional(),
    depth: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine(checkAttributionPositionPair);
assertWorkerSchemaKeysCovered<HarnessLaunchAttribution>(
  harnessLaunchAttributionSchema.shape
);
assertWorkerSchemaKeysCovered<ClaudeDesktopOrigin>(
  claudeDesktopOriginSchema.shape
);
export const parseQualitySchema = z
  .object({
    totalLines: safeStorageCountSchema,
    malformedLines: safeStorageCountSchema,
    truncatedFinalLine: z.boolean(),
    // FEA-3702: Codex present-but-malformed rate_limits records (last-good
    // preserved). Optional so Claude/other parsers that never set it still pass
    // this `.strict()` boundary; a positive value is a rate-limit data-quality
    // signal, not a parse failure.
    malformedRateLimits: safeStorageCountSchema.optional(),
    // ISS-7970: `pr-link` records whose `prNumber` is not a PR identity. Emitted
    // by the Claude parser only when non-zero, so it is optional here — omitting
    // it from this `.strict()` boundary would reject the whole worker payload of
    // any session that observed one.
    malformedPrLinkNumbers: safeStorageCountSchema.optional(),
    // FEA-3713: unknown-record count; optional so parsers/sessions that don't
    // track it (Claude core, clean rollouts) still pass this .strict() boundary.
    unknownRecords: safeStorageCountSchema.optional(),
    // FEA-3701: tool-output records correlated to no open call (orphaned) or
    // correlated via the legacy positional fallback (ambiguous). Both are
    // emitted by the Codex parser only when non-zero, so they are optional here;
    // omitting them from this `.strict()` boundary rejected the whole worker
    // response and silently dropped the source (the drift the guard below now
    // catches at compile time).
    orphanedToolOutputs: safeStorageCountSchema.optional(),
    ambiguousToolOutputs: safeStorageCountSchema.optional(),
    // ISS-6336: how many folded CHILD files had a benign trailing truncation
    // already discounted out of `malformedLines`. Optional and emitted only
    // when non-zero, so a single-file parse and every clean fold — plus every
    // pre-ISS-6336 cached worker payload — round-trip through this `.strict()`
    // boundary unchanged.
    childTruncatedFinalLines: safeStorageCountSchema.optional(),
    // ISS-12036: the folded-child and folded-descendant shares of
    // `malformedLines`. Optional and emitted only when non-zero, so a clean
    // parse, a single-file session, and every cached worker payload written
    // before this shipped round-trip through this `.strict()` boundary
    // unchanged — the alternative being a rejected response and a silently
    // dropped source, which is what the guard below exists to stop.
    foldedChildMalformedLines: safeStorageCountSchema.optional(),
    foldedDescendantMalformedLines: safeStorageCountSchema.optional(),
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
    // ISS-9047: a COUNT, so bare `z.number()` admitted `-1`, `1.5`, `Infinity`
    // and `1e300` — each of which this `.strict()` boundary then let through to
    // session metadata, and which `session-projection-gate.ts` (ISS-8741)
    // borrows this same schema to stamp known-good. The shared predicate is the
    // whole impossible set, not just the two that come to mind.
    userMessages: safeStorageCountSchema,
    assistantMessages: safeStorageCountSchema,
    // ISS-8565: NOT `z.record` — it drops an own `__proto__` key on the way
    // out, and this is the boundary the boot import and every full catch-up
    // sweep cross (`importHarness` passes the historical runner), so a model
    // named `__proto__` lost its whole token spend here even after the
    // collector-side folds started preserving it.
    tokensByModel: protoSafeRecord(
      z.string().max(MAX_SHORT_TEXT_LENGTH),
      tokenCountsSchema
    ),
    messageTimestamps: z
      .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
      .max(MAX_SESSION_ARRAY_ITEMS),
    toolUses: z.array(toolUseSchema).max(MAX_SESSION_ARRAY_ITEMS),
    mcpCallEvidence: z
      .array(toolUseSchema)
      .max(MAX_SESSION_ARRAY_ITEMS)
      .optional(),
    subagents: z.array(subagentSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    plans: z.array(planSchema).max(MAX_SESSION_ARRAY_ITEMS).optional(),
    parseQuality: parseQualitySchema.optional(),
    compactions: z
      .array(boundedUnknownValueSchema)
      .max(MAX_SESSION_ARRAY_ITEMS),
    apiErrors: z.array(apiErrorSchema).max(MAX_SESSION_ARRAY_ITEMS),
    fileModifiedAt: z.number().nullable(),
    fileCreatedAt: z.number().optional(),
    turnDurations: z.array(turnDurationSchema).max(MAX_SESSION_ARRAY_ITEMS),
    entrypoint: z.string().max(MAX_SHORT_TEXT_LENGTH),
    permissionMode: z.string().max(MAX_SHORT_TEXT_LENGTH).nullable(),
    thinkingBlockCount: safeStorageCountSchema,
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
      reasoning_output_tokens: safeStorageCountSchema.default(0),
      // FEA-3419: the FEA-3496 session-level `cache_creation` blob is GONE from
      // the contract (the split now rides tokensByModel/tokenSeries as typed
      // fields). This plain z.object strips the unknown key from any stale
      // payload that still carries it, so old-shape payloads validate cleanly.
      // PRD-538: session-level web-search request count. `.default(0)` keeps the
      // parsed OUTPUT required (matching the NormalizedSession contract) while
      // letting pre-PRD-538 worker payloads that omit it validate and fill 0. The
      // parser always emits it via `emptyUsageExtras`.
      web_search_requests: safeStorageCountSchema.default(0),
      // ISS-7258: reasoning-effort tiers. `.optional()`, NOT `.default([])` like
      // its two neighbours: the field is optional on `NormalizedSession` itself
      // so that a session stating no effort carries no key, and defaulting here
      // would put one back on every payload that crosses this boundary.
      efforts: z
        .array(z.string().max(MAX_SHORT_TEXT_LENGTH))
        .max(MAX_SESSION_ARRAY_ITEMS)
        .optional(),
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
        filesChanged: safeStorageCountSchema,
        linesAdded: safeStorageCountSchema,
        linesRemoved: safeStorageCountSchema,
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
      prs: z.array(artifactPrRefSchema).max(MAX_SESSION_ARRAY_ITEMS),
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
    // ISS-9047 (whitlockk review, PR #7220): a token magnitude, so it takes the same
    // safe-integer bound as every other stored count. `z.number().nonnegative()`
    // admitted `1.5` and `1e300`, and the Codex accumulator hands whatever it
    // read straight to the metadata builder — a context window of `1e300` then
    // renders as a measured capacity and divides into a "percent used".
    modelContextWindow: safeStorageCountSchema.optional().nullable(),
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
    // ISS-8659: the Claude twin, stamped only when the transcript carried a fork
    // replay — so root Claude sessions and every non-Claude payload round-trip
    // through the worker boundary unchanged under `.strict()`.
    claudeForkedFromSessionId: optionalNullableShortTextSchema,
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
    // ISS-7198: the Desktop launch origin. The WORKER calls the same collector
    // `parse`, so without a wire field the attribution is discarded on the
    // boot/historical path — the normal path for every existing store.
    // `.optional()` mirrors the NormalizedSession contract: a terminal-launched
    // session, every non-Claude parse, and every pre-ISS-7198 cached payload omit
    // it and round-trip through this `.strict()` boundary unchanged.
    claudeDesktopOrigin: claudeDesktopOriginSchema.optional(),
    // ISS-7259: the normalized launch-attribution facet. The WORKER calls the
    // same collector `parse`, so without a wire field the attribution is
    // discarded on the boot/historical path — the normal path for every existing
    // store. `.optional()` mirrors the NormalizedSession contract: an
    // unattributed session, and every pre-ISS-7259 cached payload, omit it and
    // round-trip through this `.strict()` boundary unchanged.
    harnessLaunchAttribution: harnessLaunchAttributionSchema.optional(),
    // ISS-7534: what the clamp cut off `tokenSeries`, so the truncation crosses
    // the boundary with the truncated series rather than being lost at it.
    // `.optional()` mirrors the NormalizedSession contract: an untruncated
    // session — and every pre-ISS-7534 cached payload — omits it and round-trips
    // through this `.strict()` boundary unchanged. `droppedRecords` is `.min(1)`
    // because a report of zero describes a truncation that did not happen.
    tokenSeriesTruncation: tokenSeriesTruncationSchema.optional(),
    // ISS-5822: response-budget clamp signal, stamped by
    // `clampSessionsForWorkerResponse` on the sessions it actually reduced.
    // Teaching this `.strict()` boundary the key is the whole point: an
    // un-modeled field here does not drop the FIELD, it rejects the ENTIRE
    // worker response and silently re-drops the source on every retry. Kept as
    // `z.literal(true).optional()` (matching the Failed envelope's `fatal`) so
    // the omit-never-`false` contract is enforced on both sides of the boundary.
    payloadClamped: z.literal(true).optional(),
    // ISS-7258: worktree provenance and the background-session marker. Optional
    // on both sides — the parser omits rather than nulls them — and teaching
    // this `.strict()` boundary about them is the whole point: an un-modeled
    // field here does not drop the FIELD, it rejects the ENTIRE worker response
    // and silently re-drops the source on every retry.
    worktreeEntries: z
      .array(worktreeEntrySchema)
      .max(MAX_SESSION_ARRAY_ITEMS)
      .optional(),
    sessionKind: z.string().max(MAX_SHORT_TEXT_LENGTH).optional(),
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
export function assertWorkerSchemaKeysCovered<T>(
  _shape: { [Key in keyof T]-?: z.ZodTypeAny }
): void {
  /* type-level check only */
}

/**
 * ISS-7508: enforce the RELATIONSHIP the position members document, which no
 * per-field bound can see.
 *
 * `firstAttributedRecordIndex` and `observedRecordCount` are a PAIR — an
 * ordinal and the denominator that makes it legible ("251 of 381") — and
 * `HarnessLaunchAttribution` states that `firstAttributedRecordIndex <=
 * observedRecordCount` always holds, because the index is drawn from the same
 * counter the total is. Validating each number alone accepts a pair that is
 * individually well-formed and jointly impossible: `{ index: 251, count: 3 }`
 * clears both `.positive()` bounds and syncs an attribution positioned past the
 * end of its own transcript, which a consumer reads as a late attribution in a
 * tiny session — plausible, wrong, and indistinguishable from a real value.
 *
 * One side alone is rejected for the same reason the producer never emits it:
 * an index with no denominator is unreadable (record 251 is late in a 381-record
 * session and early in a 4000-record one), and a denominator with no index
 * asserts a scan whose result is missing. `buildHarnessLaunchAttribution` drops
 * every skill-dependent number together, so no shipped producer can offer half a
 * pair — but this is a WORKER boundary, where the in-process type constrains
 * nothing and a hand-rolled or version-skewed payload is reachable at runtime.
 *
 * Rejecting is the correct outcome, not a silent repair: the containing source
 * response becomes a nonfatal worker failure rather than persisting a record
 * position that does not exist.
 */
function checkAttributionPositionPair(
  facet: {
    firstAttributedRecordIndex?: number;
    observedRecordCount?: number;
  },
  ctx: z.RefinementCtx
): void {
  const { firstAttributedRecordIndex: index, observedRecordCount: count } =
    facet;
  if (index === undefined && count === undefined) {
    return;
  }
  if (index === undefined || count === undefined) {
    ctx.addIssue({
      code: "custom",
      message:
        "firstAttributedRecordIndex and observedRecordCount are a pair: both must be present or both omitted",
      path: [
        index === undefined
          ? "firstAttributedRecordIndex"
          : "observedRecordCount",
      ],
    });
    return;
  }
  if (index > count) {
    ctx.addIssue({
      code: "custom",
      message: `firstAttributedRecordIndex (${index}) cannot exceed observedRecordCount (${count})`,
      path: ["firstAttributedRecordIndex"],
    });
  }
}
