/**
 * Runtime `.strict()` validators for the dedicated component-invocation sync
 * protocol (FEA-3294 / ISS-4976).
 *
 * ISS-4976 (@whitlockk review): these used to live API-local in
 * `apps/api/lib/desktop-agent-component-invocations-schema.ts`, which left the
 * Desktop producer building the same wire shape through a type-only path with no
 * boundary of its own. `packages/api/AGENTS.md` requires the runtime schema to be
 * exported from `packages/api` beside the contract it validates when multiple
 * packages consume that contract, so it lives here and both sides import it.
 *
 * It is a SIBLING module rather than part of `agent-component-invocation.ts`
 * because that type module is imported by browser-bundled client components in
 * `packages/app/agents/**`, and the root AGENTS.md forbids making a widely used
 * client surface pull in a Zod-carrying module just to read constants. Keeping
 * Zod here means the contract values stay lightweight while the schema still
 * ships from the same package.
 */

import { z } from "zod";
import {
  type AgentComponentFindingsIngestDisposition,
  isAgentComponentFindingsDispositionConsistentWithFunnel,
  isAgentComponentFindingsIngestDisposition,
} from "./agent-component-findings-disposition.ts";
import { isAgentComponentFindingsStoredFunnel } from "./agent-component-findings-funnel.ts";
import {
  AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES,
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncProtocolVersion,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationSyncProtocolVersionForItems,
  agentComponentInvocationSyncUsageProtocolVersionForItems,
  hasAgentComponentInvocationSubagentUsage,
  hasAgentComponentInvocationTelemetry,
  isCanonicalAgentComponentInvocationCost,
  LINE_BEARING_INVOCATION_KINDS,
  SUCCESS_BEARING_INVOCATION_KINDS,
  USAGE_BEARING_INVOCATION_KINDS,
} from "./agent-component-invocation.ts";
import {
  hasAgentComponentInvocationLines,
  isValidInvocationLineCount,
} from "./agent-component-invocation-lines.ts";
import { postgresStorableTextSchema } from "./postgres-text.ts";
import { PR_INT_MAX } from "./session-artifact-link.ts";
import {
  parsableTimestampSchema,
  pgRangedTimestampSchema,
} from "./sync-timestamp.ts";

const textEncoder = new TextEncoder();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * ISS-9174: every string this boundary admits is persisted to a Postgres `text`
 * or `jsonb` column, so each family REJECTS a NUL or a lone surrogate rather
 * than rewriting one — {@link postgresStorableTextSchema} carries why this lane
 * cannot sanitize the way the agent-session lane does.
 */
const nonEmptyStringSchema = postgresStorableTextSchema(
  z.string().trim().min(1)
);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const optionalStorableTextSchema = postgresStorableTextSchema(
  z.string()
).optional();
/**
 * `anchor.timestamp` lands in the `anchor` jsonb column, which has no timestamp
 * floor but does refuse the two text classes; the four `timestamp` columns take
 * {@link wireTimestampSchema}, which adds the floor.
 */
const anchorTimestampSchema = postgresStorableTextSchema(
  parsableTimestampSchema
);
const wireTimestampSchema = postgresStorableTextSchema(pgRangedTimestampSchema);

/**
 * ISS-10718 (@tamsinb review): the literal types come FROM the supported list,
 * never a second hand-written copy of it. The tuple used to spell
 * `[ZodLiteral<1>, ZodLiteral<2>, ZodLiteral<3>]`, so adding a version widened
 * the runtime union while `ParsedAgentComponentInvocationSyncBatch` still typed
 * `protocolVersion` as `1 | 2 | 3` — and the cast hid the disagreement from
 * `tsc`. Deriving the element type means the next version cannot drift it.
 */
const protocolVersionSchema = z.union(
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS.map((version) =>
    z.literal(version)
  ) as [
    z.ZodLiteral<AgentComponentInvocationSyncProtocolVersion>,
    ...z.ZodLiteral<AgentComponentInvocationSyncProtocolVersion>[],
  ]
);

const invocationKindSchema = z.enum(
  Object.values(AgentComponentInvocationKind) as [
    AgentComponentInvocationKind,
    ...AgentComponentInvocationKind[],
  ]
);
const attributionStatusSchema = z.enum(
  Object.values(AgentComponentInvocationAttributionStatus) as [
    AgentComponentInvocationAttributionStatus,
    ...AgentComponentInvocationAttributionStatus[],
  ]
);
const evidenceClassSchema = z.enum(
  Object.values(AgentComponentInvocationEvidenceClass) as [
    AgentComponentInvocationEvidenceClass,
    ...AgentComponentInvocationEvidenceClass[],
  ]
);
/**
 * ISS-11325: WHY a row's findings funnel reads what it reads, over the members an
 * INGEST may declare.
 *
 * A `z.custom` and not a `z.enum` like its `attributionSource` and
 * `usageMeasurement` siblings, because the accepted set is NARROWER than the
 * union: the read-side `unrecorded` fallback is excluded, so a producer cannot
 * write the value a read uses for "nobody said" and make a fresh unplaceable row
 * indistinguishable from a legacy unlabelled one. The guard derives that set
 * from the vocabulary's own descriptor record, so a member added there is
 * admitted or refused by what it declares rather than by a list kept here.
 */
const optionalFindingsDispositionSchema = z
  .custom<AgentComponentFindingsIngestDisposition>(
    isAgentComponentFindingsIngestDisposition
  )
  .optional();

/**
 * ISS-10720: the source that attributed the invocation, when it was not this
 * device's transcript. A `z.enum` like its `usageMeasurement` sibling — an
 * unknown value can only come from a NEWER producer, which declares a protocol
 * version this build refuses at the version gate with the retryable
 * `protocol_unsupported` rather than reaching this schema at all.
 */
const optionalAttributionSourceSchema = z
  .enum(
    Object.values(AgentComponentInvocationAttributionSource) as [
      AgentComponentInvocationAttributionSource,
      ...AgentComponentInvocationAttributionSource[],
    ]
  )
  .optional();

const relationshipSchema = z.enum(
  Object.values(AgentComponentInvocationRelationship) as [
    AgentComponentInvocationRelationship,
    ...AgentComponentInvocationRelationship[],
  ]
);

const anchorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(AgentComponentInvocationAnchorKind.Event),
      eventId: nonEmptyStringSchema,
      providerToolUseId: optionalNonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal(AgentComponentInvocationAnchorKind.Agent),
      agentId: nonEmptyStringSchema,
      externalAgentId: optionalNonEmptyStringSchema,
      transcriptFileId: optionalNonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal(AgentComponentInvocationAnchorKind.UserTurn),
      userTurnId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal(AgentComponentInvocationAnchorKind.Timestamp),
      timestamp: anchorTimestampSchema,
      ordinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(AgentComponentInvocationAnchorKind.Session),
    })
    .strict(),
]);

const optionalTokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(AGENT_COMPONENT_INVOCATION_MAX_TOKENS)
  .optional();

/**
 * A cost the cloud `numeric(14, 6)` column would round on write can never
 * survive the post-ingest generation-hash reconciliation, so the boundary
 * rejects it rather than persisting a value the producer cannot reproduce.
 */
const optionalEstimatedCostSchema = z
  .number()
  .refine(isCanonicalAgentComponentInvocationCost, "invalid_estimated_cost")
  .optional();

/**
 * ISS-10730: a per-invocation line count. `isValidInvocationLineCount` is the
 * SSOT for the whole impossible set (fractional, non-finite, negative, past the
 * safe-integer ceiling), so the boundary and the store-integrity probe reject
 * exactly the same values rather than each spelling a partial predicate.
 */
const optionalLineCountSchema = z
  .number()
  .refine(isValidInvocationLineCount, "invalid_line_count")
  .optional();

/**
 * ISS-10725: a finding count. The impossible set for a count is wider than
 * "negative" — a fractional count and a magnitude past the safe-integer range
 * both render as confident real measurements — so the bound is the same one the
 * token counts take. A string never reaches the numeric checks at all, which is
 * what keeps a blank cell from arriving as a measured `Number("") === 0`.
 */
const optionalFindingsCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(AGENT_COMPONENT_INVOCATION_MAX_TOKENS)
  .optional();

const optionalUsageMeasurementSchema = z
  .enum(
    Object.values(AgentComponentInvocationUsageMeasurement) as [
      AgentComponentInvocationUsageMeasurement,
      ...AgentComponentInvocationUsageMeasurement[],
    ]
  )
  .optional();

/**
 * Keys-covered guard. `satisfies Record<keyof T, z.ZodTypeAny>` fails `tsc` the
 * moment a field is added to `AgentComponentInvocationSyncItem` without being
 * taught to this `.strict()` boundary — which would otherwise reject the ENTIRE
 * part at runtime (silently dropping the whole generation and re-dropping it on
 * every retry) while the in-process producer path never sees the schema at all.
 */
const invocationSyncItemShape = {
  externalInvocationId: nonEmptyStringSchema,
  sourceSessionId: nonEmptyStringSchema,
  childSessionId: optionalNonEmptyStringSchema,
  parentExternalInvocationId: optionalNonEmptyStringSchema,
  externalAgentId: optionalNonEmptyStringSchema,
  kind: invocationKindSchema,
  componentKey: nonEmptyStringSchema,
  rawName: optionalNonEmptyStringSchema,
  normalizedName: optionalNonEmptyStringSchema,
  relationship: relationshipSchema,
  invokedAt: wireTimestampSchema.nullable(),
  sequence: z.number().int().nonnegative().max(PR_INT_MAX),
  anchor: anchorSchema,
  providerInvocationId: optionalNonEmptyStringSchema,
  status: attributionStatusSchema,
  evidenceClass: evidenceClassSchema,
  definitionHash: hashSchema.optional(),
  normalizerContractVersion: z
    .number()
    .int()
    .positive()
    .max(PR_INT_MAX)
    .optional(),
  definitionContent: optionalStorableTextSchema,
  definitionFormat: optionalNonEmptyStringSchema,
  sourcePath: optionalNonEmptyStringSchema,
  sourceModifiedAt: wireTimestampSchema.optional(),
  capturedAt: wireTimestampSchema.optional(),
  repositoryFullName: optionalNonEmptyStringSchema,
  repositoryCommit: optionalNonEmptyStringSchema,
  packId: optionalNonEmptyStringSchema,
  branchName: optionalNonEmptyStringSchema,
  model: optionalNonEmptyStringSchema,
  inputTokens: optionalTokenCountSchema,
  outputTokens: optionalTokenCountSchema,
  cacheReadTokens: optionalTokenCountSchema,
  cacheWriteTokens: optionalTokenCountSchema,
  estimatedCost: optionalEstimatedCostSchema,
  footprintTokens: optionalTokenCountSchema,
  usageMeasurement: optionalUsageMeasurementSchema,
  durationMs: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  linesAdded: optionalLineCountSchema,
  linesRemoved: optionalLineCountSchema,
  findingsEmitted: optionalFindingsCountSchema,
  findingsInvalidated: optionalFindingsCountSchema,
  findingsDisposition: optionalFindingsDispositionSchema,
  // ISS-10718: three-valued on purpose. Absent means "this kind's success is not
  // a transcript fact", which `.optional()` carries and a default would destroy.
  succeeded: z.boolean().optional(),
  attributionSource: optionalAttributionSourceSchema,
} satisfies Record<keyof AgentComponentInvocationSyncItem, z.ZodTypeAny>;

/**
 * ISS-12781: the item's field contract without the whole-item refinements
 * below. The cloud re-reads items it staged after redacting their definition
 * text, and a redaction marker can be longer than the secret it replaced, so
 * the byte ceilings the producer was held to cannot be re-applied there.
 */
export const agentComponentInvocationSyncItemFieldsSchema = z
  .object(invocationSyncItemShape)
  .strict();

export const agentComponentInvocationSyncItemSchema =
  agentComponentInvocationSyncItemFieldsSchema.superRefine((item, context) => {
    const definitionBytes = item.definitionContent
      ? textEncoder.encode(item.definitionContent).byteLength
      : 0;
    if (
      definitionBytes > AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "definition_content_too_large",
        path: ["definitionContent"],
      });
    }

    if (
      textEncoder.encode(JSON.stringify(item)).byteLength >
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES
    ) {
      context.addIssue({ code: "custom", message: "item_too_large" });
    }

    // ISS-4976 (@whitlockk review): `model` and the four token counts plus
    // `estimatedCost` may only ride a kind something actually measures.
    // ISS-7795 widened that set from subagent-only to include `skill` and
    // `command`, whose usage the harness's per-turn attribution stamp measures
    // directly. Accepting them on a kind with no producer would persist a value
    // nothing computed, so the boundary still rejects those.
    // `footprintTokens` is intentionally NOT covered — it is the kind-agnostic
    // context-footprint metric.
    if (
      !USAGE_BEARING_INVOCATION_KINDS.has(item.kind) &&
      hasAgentComponentInvocationSubagentUsage(item)
    ) {
      context.addIssue({
        code: "custom",
        message: "subagent_usage_requires_subagent_kind",
      });
    }

    refineInvocationLines(item, context);

    // ISS-10718 (@whitlockk review): `succeeded` may only ride a kind something
    // actually adjudicates, exactly as `model` and the counts may only ride a
    // kind something measures. Hooks and tool-result kinds are the producers;
    // accepting a boolean on any other kind lets a sync client turn an unknown
    // into a confident verdict, which is the one thing a three-valued field
    // exists to stop.
    if (
      item.succeeded !== undefined &&
      !SUCCESS_BEARING_INVOCATION_KINDS.has(item.kind)
    ) {
      context.addIssue({
        code: "custom",
        message: "succeeded_requires_success_bearing_kind",
        path: ["succeeded"],
      });
    }

    // ISS-7795: a label asserted about no telemetry at all describes nothing,
    // and unlike the converse rule this one needs no version gate — a part
    // carrying the label must already declare v3
    // (`agentComponentInvocationSyncProtocolVersionForItems`), so no v2 producer
    // can trip it. The converse — telemetry that must CARRY a label — is
    // version-dependent and therefore lives on the part, which is the only
    // scope that can see the declared protocol version.
    if (
      item.usageMeasurement !== undefined &&
      !hasAgentComponentInvocationTelemetry(item)
    ) {
      context.addIssue({
        code: "custom",
        message: "usage_measurement_requires_telemetry",
        path: ["usageMeasurement"],
      });
    }

    const cannotCarryVersion =
      item.kind === AgentComponentInvocationKind.Tool ||
      item.kind === AgentComponentInvocationKind.Mcp ||
      item.kind === AgentComponentInvocationKind.Orchestration;
    if (cannotCarryVersion) {
      if (
        item.status !== AgentComponentInvocationAttributionStatus.Unresolved
      ) {
        context.addIssue({
          code: "custom",
          message: "non_definition_kind_must_be_unresolved",
          path: ["status"],
        });
      }
      if (
        item.evidenceClass !== AgentComponentInvocationEvidenceClass.None ||
        item.definitionHash !== undefined ||
        item.normalizerContractVersion !== undefined ||
        item.definitionContent !== undefined ||
        item.definitionFormat !== undefined ||
        item.sourcePath !== undefined ||
        item.sourceModifiedAt !== undefined ||
        item.capturedAt !== undefined ||
        item.repositoryCommit !== undefined ||
        item.packId !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "non_definition_kind_has_provenance_evidence",
        });
      }
    }

    // ISS-10725: the findings pair is both-or-neither and ordered.
    // `findingsInvalidated` alone describes nothing ("invalidated out of
    // what?"), and `invalidated > emitted` makes the DERIVED `confirmed`
    // negative — a value no real run can produce. Both are rejected here rather
    // than persisted, so a stored pair is always one a reader can divide.
    // Unlike the telemetry label this needs no version gate: an item carrying
    // either key already forces the part to v5
    // (`agentComponentInvocationSyncProtocolVersionForItems`), so no older
    // producer can trip it.
    const findingsIssue = findingsPairIssue(item);
    if (findingsIssue !== null) {
      context.addIssue({
        code: "custom",
        message: findingsIssue.message,
        path: [findingsIssue.key],
      });
    }

    refineFindingsDisposition(item, context);

    if (
      item.status === AgentComponentInvocationAttributionStatus.Matched &&
      (item.definitionHash === undefined ||
        item.normalizerContractVersion === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "matched_invocation_missing_version",
      });
    }
  });

export const agentComponentInvocationSyncPartSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    externalSessionId: nonEmptyStringSchema,
    externalGenerationId: hashSchema,
    sourceUpdatedAt: wireTimestampSchema,
    dataRevision: z.number().int().nonnegative().max(PR_INT_MAX),
    sourceSequence: z.number().int().nonnegative().max(PR_INT_MAX),
    partIndex: z.number().int().nonnegative(),
    partCount: z
      .number()
      .int()
      .positive()
      .max(AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS),
    partHash: hashSchema,
    items: z
      .array(agentComponentInvocationSyncItemSchema)
      .max(AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS),
  })
  .strict()
  .superRefine((part, context) => {
    if (part.partIndex >= part.partCount) {
      context.addIssue({
        code: "custom",
        message: "part_index_out_of_range",
        path: ["partIndex"],
      });
    }
    if (part.items.length === 0 && part.partCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "empty_generation_must_have_one_part",
        path: ["items"],
      });
    }
    if (
      part.items.some((item) => item.sourceSessionId !== part.externalSessionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "item_session_mismatch",
        path: ["items"],
      });
    }
    // ISS-4976: a part carrying telemetry MUST declare the telemetry protocol
    // version. This is what keeps v1 honest — an older API's v1 gate is only a
    // safe skew answer if every v1 part really is telemetry-free.
    //
    // ISS-10720 widened what the derivation answers rather than adding a second
    // gate beside it: an item carrying the `otelCounter` evidence class needs
    // v7 for exactly the reason a telemetry item needs v2, so
    // `agentComponentInvocationSyncProtocolVersionForItems` is the one place
    // that decides and this comparison is the one place that enforces. The
    // reason string stays `telemetry_requires_protocol_version` because it is a
    // cross-repo contract value an older peer already maps.
    if (
      part.protocolVersion <
      agentComponentInvocationSyncProtocolVersionForItems(part.items)
    ) {
      context.addIssue({
        code: "custom",
        message: "telemetry_requires_protocol_version",
        path: ["protocolVersion"],
      });
    }
    // ISS-7795: from v3 on, every telemetry number must state how it was
    // arrived at — a bracketed count and a session-average share would
    // otherwise land in one undifferentiated column. Never applied
    // unconditionally; see `unlabelledTelemetryIndex`.
    //
    // ISS-10718 (@whitlockk review): gated on the version the part's USAGE requires,
    // plus the case of a producer that DECLARES the label version itself and so
    // is held to it however little it labels. What it is deliberately NOT gated
    // on any more is the declared version alone: once a field above v3 exists,
    // one hook item carrying `succeeded` lifts the part to v4 and would demand a
    // label of a legacy v2-shape row that predates labels, dead-lettering the
    // whole generation over a field none of those rows carry.
    if (
      part.protocolVersion ===
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION ||
      agentComponentInvocationSyncUsageProtocolVersionForItems(part.items) >=
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION
    ) {
      const unlabelled = unlabelledTelemetryIndex(part.items);
      if (unlabelled !== -1) {
        context.addIssue({
          code: "custom",
          message: "telemetry_requires_usage_measurement",
          path: ["items", unlabelled, "usageMeasurement"],
        });
      }
    }
    const invocationIds = new Set(
      part.items.map((item) => item.externalInvocationId)
    );
    if (invocationIds.size !== part.items.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate_invocation_id_in_part",
        path: ["items"],
      });
    }
    if (
      textEncoder.encode(JSON.stringify(part)).byteLength >
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES
    ) {
      context.addIssue({ code: "custom", message: "part_too_large" });
    }
  });

export const agentComponentInvocationSyncBatchSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    parts: z.array(agentComponentInvocationSyncPartSchema).length(1),
  })
  .strict()
  .superRefine((batch, context) => {
    // The envelope version is what an older API's pre-parse gate reads, so it
    // must not understate the part it carries.
    if (
      batch.parts.some((part) => part.protocolVersion !== batch.protocolVersion)
    ) {
      context.addIssue({
        code: "custom",
        message: "batch_part_protocol_version_mismatch",
        path: ["protocolVersion"],
      });
    }
    if (
      textEncoder.encode(JSON.stringify(batch)).byteLength >
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES
    ) {
      context.addIssue({ code: "custom", message: "batch_too_large" });
    }
  });

export type ParsedAgentComponentInvocationSyncBatch = z.infer<
  typeof agentComponentInvocationSyncBatchSchema
>;

/**
 * ISS-10718 (@tamsinb review): the compile-time half of the protocol-version
 * union, because the runtime half cannot catch this.
 *
 * `protocolVersionSchema` is built by MAPPING the supported list, so a runtime
 * test parses every version and stays green whatever the literal tuple says.
 * What drifts is the TYPE: the tuple was hand-written as `1 | 2 | 3` and the
 * cast made `tsc` agree while the union accepted more. The direction here is
 * load-bearing — EVERY supported version must be assignable to the PARSED
 * field, so a tuple narrower than the list fails typecheck. Asserting the
 * reverse compiles under the bug and proves nothing.
 */
export function supportedProtocolVersionAsParsed(
  version: AgentComponentInvocationSyncProtocolVersion
): ParsedAgentComponentInvocationSyncBatch["parts"][number]["protocolVersion"] {
  return version;
}

/**
 * ISS-6889: this module is the ONE owner of the canonicalization the wire
 * boundary applies, because `nonEmptyStringSchema` trims. The API hashes
 * `parsed.data` — the TRIMMED object — so a producer that hashes its own
 * pre-parse bytes signs a different preimage for the same part: `partHash` and
 * `externalGenerationId` can never reconcile, the 400 is classed permanent
 * `validation_failed`, and the whole generation dead-letters after five
 * identical round trips. Producers run these before computing either hash so
 * both sides hash identical bytes.
 *
 * The rule is never restated at a call site — re-declaring "trim these fields"
 * beside the producer is exactly how this defect returns the next time the
 * schema's canonicalization changes.
 *
 * A value this boundary would reject is returned unchanged, so the producer's
 * existing contract check still reports the real failing field path instead of
 * a canonicalization error that names nothing.
 */
export function canonicalizeAgentComponentInvocationSyncItem(
  item: AgentComponentInvocationSyncItem
): AgentComponentInvocationSyncItem {
  const parsed = agentComponentInvocationSyncItemSchema.safeParse(item);
  return parsed.success ? parsed.data : item;
}

/** Canonicalize a part-level contract string; see {@link canonicalizeAgentComponentInvocationSyncItem}. */
export function canonicalizeAgentComponentInvocationSyncString(
  value: string
): string {
  const parsed = nonEmptyStringSchema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/**
 * Index of the first item carrying telemetry with no measurement label, or -1.
 *
 * ISS-7795 (codex P1 review): the label is required from v3 ON, never on every
 * item unconditionally. v2 is still in
 * `AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS`, so an
 * already-installed or external producer that predates ISS-7795 keeps sending
 * telemetry-carrying v2 parts with no label. Rejecting those returns HTTP 400
 * `validation_failed`, which the Desktop client classes PERMANENT and
 * dead-letters after five attempts — the generation is lost rather than
 * retried. Accepting them is what the repo's cross-repo compatibility rule
 * requires, and it costs nothing: the label is still mandatory the moment a
 * producer declares the version that introduced it.
 */
function unlabelledTelemetryIndex(
  items: readonly Partial<AgentComponentInvocationSyncItem>[]
): number {
  return items.findIndex(
    (item) =>
      item.usageMeasurement === undefined &&
      hasAgentComponentInvocationTelemetry(item)
  );
}

/**
 * ISS-10725: what is wrong with an item's findings pair, or `null`.
 *
 * The admissibility of a COMPLETE pair is
 * {@link isAgentComponentFindingsStoredFunnel}'s to decide, not this module's —
 * the STORED/wire predicate and not the ingest one, because ISS-10739's label
 * is not on this item (ISS-10727 widens it) and asking the ingest question here
 * would refuse every real pair as `findings_invalidated_exceeds_emitted`. The
 * stored contract and the wire boundary must agree on which pairs are real, and
 * they can only do that by asking the same predicate. What lives here is the
 * half-set rule, which is a property of the OPTIONAL wire fields rather than of
 * the funnel type, since a funnel always has both.
 */
function findingsPairIssue(
  item: Partial<AgentComponentInvocationSyncItem>
): { key: "findingsEmitted" | "findingsInvalidated"; message: string } | null {
  const { findingsEmitted, findingsInvalidated } = item;
  if (findingsEmitted === undefined && findingsInvalidated === undefined) {
    return null;
  }
  if (findingsEmitted === undefined) {
    return {
      key: "findingsEmitted",
      message: "findings_pair_incomplete",
    };
  }
  if (findingsInvalidated === undefined) {
    return {
      key: "findingsInvalidated",
      message: "findings_pair_incomplete",
    };
  }
  if (
    !isAgentComponentFindingsStoredFunnel({
      findingsEmitted,
      findingsInvalidated,
    })
  ) {
    return {
      key: "findingsInvalidated",
      message: "findings_invalidated_exceeds_emitted",
    };
  }
  return null;
}

/**
 * ISS-11325 (codex review): the disposition and the pair are two halves of ONE
 * statement, so a contradiction between them is refused at the boundary instead
 * of persisted.
 *
 * Enum membership alone is not enough here. A version-skewed producer can build
 * a type-correct item saying `measured-this-run` with no counts, or a
 * `withheld-*` member beside a real pair, and the row→wire projection
 * ({@link storedAgentComponentFindingsWireProjection}) DROPS a disposition its
 * funnel contradicts — so ingest's reconstruction of the generation hash would
 * no longer reproduce what the producer sent, and the whole generation would
 * dead-letter as a permanent `generation_conflict` that no retry can clear. A
 * loud per-item rejection here costs the one item instead.
 *
 * The consistency rule itself is the vocabulary's, asked through its own
 * predicate rather than restated, so this boundary and the two projections
 * cannot come to disagree about which pairings are real.
 *
 * Nothing older is turned away: no shipped build emits `findingsDisposition` at
 * all, and an item carrying it already forces the part to
 * `AGENT_COMPONENT_INVOCATION_SYNC_FINDINGS_DISPOSITION_PROTOCOL_VERSION`.
 */
function refineFindingsDisposition(
  item: {
    findingsEmitted?: number;
    findingsDisposition?: AgentComponentFindingsIngestDisposition;
  },
  context: z.RefinementCtx
): void {
  if (item.findingsDisposition === undefined) {
    return;
  }
  if (
    !isAgentComponentFindingsDispositionConsistentWithFunnel(
      item.findingsDisposition,
      item.findingsEmitted !== undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "findings_disposition_contradicts_funnel",
      path: ["findingsDisposition"],
    });
  }
}

/**
 * ISS-10730: the two line-attribution rules, extracted so the item schema's
 * `superRefine` stays under the cognitive-complexity ceiling after ISS-10718's
 * and ISS-10725's rules landed on the same function.
 *
 * A line count may only ride a kind built from a single transcript tool call,
 * which is the only thing that carries a per-edit `diffDelta`. A `skill`,
 * `command`, `subagent` or `hook` row holding one would be a value nothing
 * computed — the same rule the usage block applies to its own cohort, and the
 * disjointness of the two sets is what forces the LOC/$ ratio through
 * `resolveInvocationLocPerDollar`.
 *
 * And (#7718 review) the two halves of a delta are ONE measurement that must
 * arrive together. Validated independently, an externally supplied item
 * carrying only `linesAdded` parses and persists as a half-written row — and
 * `persistedInvocationLines` then omits BOTH keys when it reads that row back,
 * so the generation hash no longer reproduces and the row is corrupt persisted
 * state the ingest boundary itself let in. A row that changed nothing is
 * `0`/`0`, never one key; absent means absent on BOTH, which is what keeps
 * omission (not `null`) the wire spelling for a version-skewed producer with no
 * lines to report at all.
 */
function refineInvocationLines(
  item: {
    kind: AgentComponentInvocationKind;
    linesAdded?: number;
    linesRemoved?: number;
  },
  context: z.RefinementCtx
): void {
  if (
    !LINE_BEARING_INVOCATION_KINDS.has(item.kind) &&
    hasAgentComponentInvocationLines(item)
  ) {
    context.addIssue({
      code: "custom",
      message: "lines_require_line_bearing_kind",
    });
  }
  if ((item.linesAdded === undefined) !== (item.linesRemoved === undefined)) {
    context.addIssue({
      code: "custom",
      message: "lines_require_both_halves",
    });
  }
}
