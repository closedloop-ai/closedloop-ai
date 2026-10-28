/**
 * ISS-12552: Zod boundary for the `operationEvidence` a
 * Desktop syncs. Each shape object `satisfies Record<keyof T, …>`, so a field
 * added to a claim type fails `tsc` until this boundary learns it.
 *
 * Version-skewed by design: a claim this reader cannot parse (an unknown
 * source or kind a newer extractor emits, or a malformed one) is dropped on
 * its own and counted, never rejecting the session's whole payload.
 */
import { z } from "zod";
import {
  MAX_SYNCED_OPERATION_CLAIMS,
  OperationKind,
} from "./attribution-evidence.ts";
import {
  MAX_CANDIDATE_REQUEST_KEYS,
  MAX_UNSUPPORTED_TOOL_NAMES,
  type OperationClaim,
  type OperationClaimResultEntity,
  OperationClaimSource,
  type OperationClaimTarget,
  type OperationEvidenceCoverage,
  type SessionOperationEvidence,
  ToolResultState,
} from "./operation-claims.ts";

const SHORT_TEXT = 256;
const MAX_LIST_ITEMS = 200;
const DIGEST_RE = /^[0-9a-f]{64}$/;

const shortText = z.string().min(1).max(SHORT_TEXT);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const claimTargetShape = {
  key: shortText,
  slug: shortText.optional(),
  uuid: shortText.optional(),
} satisfies Record<keyof OperationClaimTarget, z.ZodType>;
const claimTargetSchema = z.object(claimTargetShape);

const resultEntityShape = {
  id: shortText.optional(),
  slug: shortText.optional(),
  version: count.optional(),
} satisfies Record<keyof OperationClaimResultEntity, z.ZodType>;

const operationClaimShape = {
  claimKey: shortText,
  ambiguous: z.boolean().optional(),
  source: z.enum(OperationClaimSource),
  toolName: shortText.optional(),
  operationKind: z.enum(OperationKind).optional(),
  providerCallId: shortText.optional(),
  inputTargets: z.array(claimTargetSchema).max(MAX_LIST_ITEMS).optional(),
  relatedTargets: z.array(claimTargetSchema).max(MAX_LIST_ITEMS).optional(),
  resultState: z.enum(ToolResultState).optional(),
  operationIds: z.array(shortText).max(MAX_LIST_ITEMS).optional(),
  primaryResultEntity: z.object(resultEntityShape).optional(),
  nestedReferenceSlugs: z.array(shortText).max(MAX_LIST_ITEMS).optional(),
  referenceSlug: shortText.optional(),
  branch: shortText.optional(),
  requestKeys: z.array(shortText).max(MAX_LIST_ITEMS).optional(),
  agentId: shortText.optional(),
  requestKey: shortText.optional(),
  candidateRequestKeys: z
    .array(shortText)
    .max(MAX_CANDIDATE_REQUEST_KEYS)
    .optional(),
  requestUnresolved: z.literal(true).optional(),
  invokedAt: shortText.optional(),
  resultAt: shortText.optional(),
  requestFingerprint: shortText.optional(),
} satisfies Record<keyof OperationClaim, z.ZodType>;

/** One claim; unknown keys from a newer extractor are dropped. */
export const operationClaimSchema = z.object(operationClaimShape);

const coverageShape = {
  harness: shortText,
  harnessVersion: shortText.optional(),
  evidencePathSupported: z.boolean(),
  closedloopMcpCalls: count,
  shellCallsWithOperationIds: count,
  directApiShellCommands: count,
  unsupportedToolNames: z
    .record(shortText, count)
    .refine(
      (names) => Object.keys(names).length <= MAX_UNSUPPORTED_TOOL_NAMES,
      "too many unsupported tool names"
    ),
  claimsDroppedByCap: count,
} satisfies Record<keyof OperationEvidenceCoverage, z.ZodType>;

export const operationEvidenceCoverageSchema = z.object(coverageShape);

/** The parsed evidence plus how many claims this reader could not parse. */
export type ParsedSessionOperationEvidence = SessionOperationEvidence & {
  unparsedClaims: number;
};

const evidenceShape = {
  extractorVersion: z.number().int().positive(),
  digest: z.string().regex(DIGEST_RE),
  coverage: operationEvidenceCoverageSchema,
  // No row-count ceiling: claims past the cap are dropped and counted below.
  claims: z.array(z.unknown()),
} satisfies Record<keyof SessionOperationEvidence, z.ZodType>;

/**
 * A session's evidence snapshot. The snapshot's own fields must parse; each
 * claim is parsed separately so one this reader does not know drops alone. A
 * claim repeating an earlier claim's key is dropped and counted the same way:
 * the key is the stored row's identity, so a repeat would fail the session's
 * whole ingest. Claims past {@link MAX_SYNCED_OPERATION_CLAIMS} are dropped
 * and counted rather than rejecting the snapshot.
 */
export const sessionOperationEvidenceSchema = z
  .object(evidenceShape)
  .transform((evidence): ParsedSessionOperationEvidence => {
    const claims: OperationClaim[] = [];
    const keys = new Set<string>();
    for (const claim of evidence.claims) {
      if (claims.length >= MAX_SYNCED_OPERATION_CLAIMS) {
        break;
      }
      const parsed = operationClaimSchema.safeParse(claim);
      if (parsed.success && !keys.has(parsed.data.claimKey)) {
        keys.add(parsed.data.claimKey);
        claims.push(parsed.data);
      }
    }
    return {
      ...evidence,
      claims,
      unparsedClaims: evidence.claims.length - claims.length,
    };
  });
