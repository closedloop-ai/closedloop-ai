/**
 * Runtime `.strict()` validators for the dedicated component-invocation sync
 * protocol (FEA-3294 / ISS-4976).
 *
 * ISS-4976 (@wongk review): these used to live API-local in
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
  AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES,
  AGENT_COMPONENT_INVOCATION_MAX_TOKENS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  agentComponentInvocationSyncProtocolVersionForItems,
  hasAgentComponentInvocationSubagentUsage,
  isCanonicalAgentComponentInvocationCost,
} from "./agent-component-invocation.ts";

const textEncoder = new TextEncoder();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
const isoDateSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid_date");

const protocolVersionSchema = z.union(
  AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS.map((version) =>
    z.literal(version)
  ) as [z.ZodLiteral<1>, z.ZodLiteral<2>]
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
      timestamp: isoDateSchema,
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
  invokedAt: isoDateSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  anchor: anchorSchema,
  providerInvocationId: optionalNonEmptyStringSchema,
  status: attributionStatusSchema,
  evidenceClass: evidenceClassSchema,
  definitionHash: hashSchema.optional(),
  normalizerContractVersion: z.number().int().positive().optional(),
  definitionContent: z.string().optional(),
  definitionFormat: optionalNonEmptyStringSchema,
  sourcePath: optionalNonEmptyStringSchema,
  sourceModifiedAt: isoDateSchema.optional(),
  capturedAt: isoDateSchema.optional(),
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
} satisfies Record<keyof AgentComponentInvocationSyncItem, z.ZodTypeAny>;

export const agentComponentInvocationSyncItemSchema = z
  .object(invocationSyncItemShape)
  .strict()
  .superRefine((item, context) => {
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

    // ISS-4976 (@wongk review): `model` and the four token counts plus
    // `estimatedCost` are per-SUBAGENT-TURN usage, and both Prisma schemas say
    // so ("other kinds leave them NULL"). Accepting them on a tool, skill, or
    // hook row would persist a value the column's own contract forbids, so the
    // boundary rejects it. `footprintTokens` is intentionally NOT covered — it
    // is the kind-agnostic context-footprint metric.
    if (
      item.kind !== AgentComponentInvocationKind.Subagent &&
      hasAgentComponentInvocationSubagentUsage(item)
    ) {
      context.addIssue({
        code: "custom",
        message: "subagent_usage_requires_subagent_kind",
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
    sourceUpdatedAt: isoDateSchema,
    dataRevision: z.number().int().nonnegative(),
    sourceSequence: z.number().int().nonnegative(),
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
