/**
 * ISS-12552: Zod boundary for the attribution evidence contract in
 * `attribution-evidence.ts`. Each shape object `satisfies Record<keyof T, …>`,
 * so a field added to a contract type fails `tsc` until this boundary learns it.
 *
 * Two parsers are deliberately lenient: the public receipt (its outcome is
 * open-ended for clients) and the SESSION-row evidence a newer API may extend,
 * so an older reader passes unknown keys through instead of rejecting the row.
 */

import { z } from "zod";
import {
  type AttributionArtifactIdentity,
  type AttributionCoverage,
  type AttributionDurableResult,
  type AttributionEvidenceAnchor,
  type AttributionOperationIdentity,
  type AttributionRelationshipEvidence,
  AttributionRelationshipKind,
  type AttributionRevision,
  type AttributionUsageAssociation,
  type AttributionUsageIdentity,
  OperationEvidenceOutcome,
  OperationKind,
  type OperationReceipt,
  OperationSource,
  parseOperationId,
  type SessionLinkAttributionEvidence,
  type SessionLinkAttributionOperation,
  UnresolvedReason,
  UsageAssociationMethod,
  UsageTokenCategory,
} from "./attribution-evidence.ts";
import { RELATIONSHIP_STRENGTH } from "./attribution-provenance-kind.ts";

const nonEmptyString = z.string().min(1);
const tokenCount = z.number().int().nonnegative();
const versionNumber = z.number().int().positive();

/** A `clop_<uuid>` operation id. */
export const operationIdSchema = z
  .string()
  .refine((value) => parseOperationId(value) !== null, {
    message: "invalid_operation_id",
  });

const artifactIdentityShape = {
  organizationId: nonEmptyString.optional(),
  artifactId: nonEmptyString.optional(),
  artifactType: nonEmptyString.optional(),
  observedSlug: nonEmptyString.optional(),
  observedUuid: nonEmptyString.optional(),
} satisfies Record<keyof AttributionArtifactIdentity, z.ZodTypeAny>;

export const attributionArtifactIdentitySchema = z
  .object(artifactIdentityShape)
  .strict();

const operationIdentityShape = {
  operationId: operationIdSchema.optional(),
  providerCallId: nonEmptyString.optional(),
  source: z.enum(OperationSource),
  sessionId: nonEmptyString.optional(),
  agentId: nonEmptyString.optional(),
  operationKind: z.enum(OperationKind),
  outcome: z.enum(OperationEvidenceOutcome),
} satisfies Record<keyof AttributionOperationIdentity, z.ZodTypeAny>;

export const attributionOperationIdentitySchema = z
  .object(operationIdentityShape)
  .strict();

const durableResultShape = {
  createdArtifactId: nonEmptyString.optional(),
  versionNumber: versionNumber.optional(),
  changedFields: z.array(nonEmptyString).optional(),
  commentId: nonEmptyString.optional(),
  linkId: nonEmptyString.optional(),
  repositoryOutput: z
    .object({ repository: nonEmptyString, headRef: nonEmptyString })
    .strict()
    .optional(),
} satisfies Record<keyof AttributionDurableResult, z.ZodTypeAny>;

export const attributionDurableResultSchema = z
  .object(durableResultShape)
  .strict();

const evidenceAnchorShape = {
  toolName: nonEmptyString.optional(),
  providerToolUseId: nonEmptyString.optional(),
  recordOrdinal: tokenCount.optional(),
} satisfies Record<keyof AttributionEvidenceAnchor, z.ZodTypeAny>;

const relationshipEvidenceShape = {
  evidenceId: nonEmptyString,
  kind: z.enum(AttributionRelationshipKind),
  target: attributionArtifactIdentitySchema,
  operation: attributionOperationIdentitySchema.optional(),
  durableResult: attributionDurableResultSchema.optional(),
  unresolvedReason: z.enum(UnresolvedReason).optional(),
  anchors: z.array(z.object(evidenceAnchorShape).strict()).optional(),
} satisfies Record<keyof AttributionRelationshipEvidence, z.ZodTypeAny>;

export const attributionRelationshipEvidenceSchema = z
  .object(relationshipEvidenceShape)
  .strict();

const usageIdentityShape = {
  sourceKey: nonEmptyString,
  sessionId: nonEmptyString,
  agentId: nonEmptyString.optional(),
  model: nonEmptyString,
  category: z.enum(UsageTokenCategory),
  tokens: tokenCount,
  occurredAt: nonEmptyString,
  priced: z.boolean(),
} satisfies Record<keyof AttributionUsageIdentity, z.ZodTypeAny>;

export const attributionUsageIdentitySchema = z
  .object(usageIdentityShape)
  .strict();

const usageAssociationShape = {
  sourceKey: nonEmptyString,
  recipientKey: nonEmptyString,
  phase: nonEmptyString,
  evidenceId: nonEmptyString,
  method: z.enum(UsageAssociationMethod),
  limitation: nonEmptyString.optional(),
} satisfies Record<keyof AttributionUsageAssociation, z.ZodTypeAny>;

export const attributionUsageAssociationSchema = z
  .object(usageAssociationShape)
  .strict();

const coverageShape = {
  measuredTokens: tokenCount,
  provenTokens: tokenCount,
  estimatedTokens: tokenCount,
  unattributedTokens: tokenCount,
  unpricedTokens: tokenCount,
  allocatedCostMicros: tokenCount.optional(),
  sessionCostGapMicros: z.number().int().optional(),
  unresolvedOperations: tokenCount,
  unsupportedOperations: tokenCount,
  extractionComplete: z.boolean(),
} satisfies Record<keyof AttributionCoverage, z.ZodTypeAny>;

export const attributionCoverageSchema = z.object(coverageShape).strict();

const revisionShape = {
  contractVersion: versionNumber,
  policyVersion: versionNumber,
  extractorVersion: versionNumber,
  effectiveAt: nonEmptyString.optional(),
} satisfies Record<keyof AttributionRevision, z.ZodTypeAny>;

export const attributionRevisionSchema = z.object(revisionShape).strict();

const operationReceiptShape = {
  operationId: operationIdSchema,
  outcome: nonEmptyString,
} satisfies Record<keyof OperationReceipt, z.ZodTypeAny>;

/**
 * The public receipt on a write response. `outcome` stays a plain string so a
 * value added later still parses; read it with `parseOperationReceiptOutcome`.
 */
export const operationReceiptSchema = z.object(operationReceiptShape).loose();

const sessionLinkOperationShape = {
  operationId: operationIdSchema.optional(),
  relationshipKind: z.enum(AttributionRelationshipKind),
  operationKind: z.enum(OperationKind),
  outcome: z.enum(OperationEvidenceOutcome),
  // Loose here: an API newer than this reader may add a durable-result field.
  durableResult: z.object(durableResultShape).loose().optional(),
} satisfies Record<keyof SessionLinkAttributionOperation, z.ZodTypeAny>;

const sessionLinkOperationSchema = z.object(sessionLinkOperationShape).loose();

const knownRelationshipKind = z.enum(AttributionRelationshipKind);

const sessionLinkEvidenceShape = {
  contractVersion: versionNumber,
  policyVersion: versionNumber,
  extractorVersion: versionNumber,
  // Any string here; a kind a newer API added is re-derived below.
  relationshipKind: z.string(),
  // Each operation parses on its own, so one of a kind or outcome a newer API
  // added is dropped instead of taking the row's known evidence with it.
  operations: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const operation = sessionLinkOperationSchema.safeParse(item);
      return operation.success ? [operation.data] : [];
    })
  ),
} satisfies Record<keyof SessionLinkAttributionEvidence, z.ZodTypeAny>;

/**
 * Evidence on a SESSION row of the resolved-links read and the
 * `list-artifact-links` MCP output. Loose, so an MCP server older than the API
 * passes fields it does not know through; an operation it cannot read is
 * dropped, and the row keeps its relationship.
 */
export const sessionLinkAttributionEvidenceSchema = z
  .object(sessionLinkEvidenceShape)
  .loose()
  .transform((evidence, ctx) => {
    // The API names the strongest of the row's operations; a kind this reader
    // does not know is re-derived the same way from the operations it read.
    const relationshipKind =
      knownRelationshipKind.safeParse(evidence.relationshipKind).data ??
      RELATIONSHIP_STRENGTH.find((kind) =>
        evidence.operations.some(
          (operation) => operation.relationshipKind === kind
        )
      );
    if (!relationshipKind) {
      ctx.addIssue({
        code: "custom",
        message: "no relationship kind this reader knows",
      });
      return z.NEVER;
    }
    return { ...evidence, relationshipKind };
  });
