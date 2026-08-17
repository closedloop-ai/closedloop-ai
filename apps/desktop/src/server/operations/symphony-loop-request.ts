import {
  LoopHarnessSchema,
  type LoopRequestBody,
} from "@closedloop-ai/loops-api/desktop-request";
import { BRANCH_NAME_REGEX } from "@closedloop-ai/loops-api/execution-result";
import { z } from "zod";

const nullableString = z.string().nullable().optional();
const REPOSITORY_FULL_NAME_REGEX = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const BRANCH_NAME_MAX_LENGTH = 256;
// Cloud session tokens are signed JWTs; 4096 is a generous upper bound that
// keeps the value within safe HTTP header limits when forwarded as
// `X-Session-Token` and prevents unbounded header injection.
const CLOUD_SESSION_TOKEN_MAX_LENGTH = 4096;
// `${orgId}/loops/${loopId}/${runId}` (apps/api `loop-state.ts`). Whitespace is
// excluded everywhere; the loop segment is captured so the key can be checked
// against THIS request's loopId. The org prefix and run suffix stay permissive
// (`[^\s]+`) so a dispatcher that deepens either still parses.
const S3_STATE_KEY_REGEX = /^\S+\/loops\/([^\s/]+)\/\S+$/;
// S3 object keys cap at 1024 bytes; Desktop appends `/support/<file>` to this
// prefix, so leave headroom rather than allowing an unbounded string.
const S3_STATE_KEY_MAX_LENGTH = 900;

const supportingArtifactSchema = z
  .object({
    id: z.string().default(""),
    type: z.string().default(""),
    title: z.string().default(""),
    content: z.string(),
    raw: z.record(z.string(), z.unknown()).optional(),
    filename: z.string().optional(),
    fileName: z.string().optional(),
  })
  .passthrough();

const codeEvaluationContextSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  repo: z
    .object({
      fullName: nullableString,
      branch: nullableString,
    })
    .nullable()
    .optional(),
  localRepoPath: nullableString,
  parentBranchName: nullableString,
  parentSessionId: nullableString,
  artifactSlug: nullableString,
  pullRequest: z
    .object({
      number: z.number().nullable().optional(),
      url: nullableString,
      headBranch: nullableString,
      baseBranch: nullableString,
      headSha: nullableString,
      repositoryFullName: nullableString,
    })
    .nullable()
    .optional(),
  detected: z
    .object({
      branch: nullableString,
      headSha: nullableString,
      gitDetectionError: nullableString,
    })
    .nullable()
    .optional(),
});

const branchMaterializationEntrySchema = z
  .object({
    role: z.enum(["primary", "additional"]),
    repositoryFullName: z
      .string()
      .trim()
      .max(256)
      .regex(REPOSITORY_FULL_NAME_REGEX, "Must be in 'owner/repo' format"),
    baseBranch: z
      .string()
      .trim()
      .max(BRANCH_NAME_MAX_LENGTH)
      .regex(BRANCH_NAME_REGEX, "Branch name contains invalid characters"),
    branchName: z
      .string()
      .trim()
      .max(BRANCH_NAME_MAX_LENGTH)
      .regex(BRANCH_NAME_REGEX, "Branch name contains invalid characters"),
  })
  .strict();

const branchMaterializationSchema = z
  .object({
    schemaVersion: z.literal(1),
    branches: z.array(branchMaterializationEntrySchema).min(1),
  })
  .strict();

// PLN-740 T-4.4: cloudSessionToken is now tolerated-but-ignored during the
// migration window. The schema and parseCloudSessionToken helper are kept so
// the field is still stripped from rawBody before the passthrough spread
// (security: keeps unvalidated data out of the loopBody). The parsed value is
// no longer wired into effectiveCloudSessionToken.
// TODO(FEA-1423): Hard-remove cloudSessionTokenSchema, parseCloudSessionToken,
// and the cloudSessionToken field from SymphonyLoopRequestBody once server-side
// S3 (cloud sender removal) has deployed.
const cloudSessionTokenSchema = z
  .string()
  .trim()
  .max(CLOUD_SESSION_TOKEN_MAX_LENGTH);

export type SymphonyLoopSupportingArtifact = z.infer<
  typeof supportingArtifactSchema
>;
export type SymphonyCodeEvaluationContext = z.infer<
  typeof codeEvaluationContextSchema
>;
export type SymphonyBranchMaterialization = z.infer<
  typeof branchMaterializationSchema
>;
export type SymphonyBranchMaterializationEntry = z.infer<
  typeof branchMaterializationEntrySchema
>;

export interface CodeContextFile extends SymphonyCodeEvaluationContext {
  schemaVersion: 1;
}

export type SymphonyLoopRequestBody = LoopRequestBody & {
  supportingArtifacts: SymphonyLoopSupportingArtifact[];
  codeEvaluationContext: SymphonyCodeEvaluationContext | null;
  priorLoopSummaries?: unknown;
  parentBranchName?: string;
  parentSessionId?: string;
  artifactSlug?: string;
  branchMaterialization?: SymphonyBranchMaterialization;
  // cloudSessionToken removed from the type in PLN-740 T-4.4 — the field is
  // still stripped from rawBody in parseSymphonyLoopRequestBody (security) but
  // is no longer propagated downstream.
};

export class SymphonyLoopRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymphonyLoopRequestValidationError";
  }
}

/**
 * Parses Desktop's locally extended loop request without requiring a new
 * @closedloop-ai/loops-api release. Existing LoopRequestBody fields are left
 * untouched while Desktop-only extension fields are normalized for downstream
 * code.
 */
export function parseSymphonyLoopRequestBody(
  rawBody: Record<string, unknown>
): SymphonyLoopRequestBody {
  const supportingArtifacts = parseSupportingArtifacts(
    rawBody.supportingArtifacts
  );
  const codeEvaluationContext = parseCodeEvaluationContext(
    rawBody.codeEvaluationContext
  );
  const branchMaterialization = parseBranchMaterialization(
    rawBody.branchMaterialization
  );
  // PLN-740 T-4.4: parse cloudSessionToken for validation/logging but do NOT
  // re-add it to the return value (the re-add block was the source of the now-
  // removed effectiveCloudSessionToken pipeline). The field is still stripped
  // from rawBody below so it cannot bypass security via the passthrough spread.
  parseCloudSessionToken(rawBody.cloudSessionToken);
  // Strip the raw extension fields so they cannot bypass validation via the
  // untyped `...loopBody` passthrough spread below.
  const {
    branchMaterialization: _rawBranchMaterialization,
    cloudSessionToken: _rawCloudSessionToken,
    harness: rawHarness,
    s3StateKey: rawS3StateKey,
    ...loopBody
  } = rawBody;
  const s3StateKey = parseS3StateKey(rawS3StateKey, rawBody.loopId);
  const harness =
    rawHarness === undefined ? undefined : LoopHarnessSchema.parse(rawHarness);

  return {
    ...(loopBody as unknown as LoopRequestBody),
    ...(harness === undefined ? {} : { harness }),
    ...(s3StateKey ? { s3StateKey } : {}),
    supportingArtifacts,
    codeEvaluationContext,
    ...(branchMaterialization ? { branchMaterialization } : {}),
  };
}

const s3StateKeySchema = z
  .string()
  .min(1)
  .max(S3_STATE_KEY_MAX_LENGTH)
  .regex(
    S3_STATE_KEY_REGEX,
    "Must be '<orgId>/loops/<loopId>/<runId>' with no whitespace"
  );

/**
 * ISS-5154: the cloud dispatcher's S3 run-state prefix, validated at the parse
 * boundary so downstream code can read `body.s3StateKey` as the `string |
 * undefined` the contract declares instead of re-deriving a `typeof` guard.
 *
 * The key is minted as `${orgId}/loops/${loopId}/${runId}` (apps/api
 * `loop-state.ts`) and Desktop appends `/support/<file>` to it when uploading a
 * crash support bundle. `z.string().min(1)` did not validate any of that:
 * whitespace and — worse — ANOTHER loop's prefix both passed, and a failed parse
 * collapsed a present-but-wrong value into omission, at which point
 * `handleLoopRequest` falls back to `existing.s3StateKey` and files this run's
 * bundle under the prior run's key.
 *
 * So the two cases are now kept apart:
 * - ABSENT (`undefined`/`null`): version skew — an older dispatcher omits the
 *   field. Degrade to absent and let the gateway keep the job's existing key.
 * - PRESENT but invalid: surfaced as a request-boundary validation error (a 400
 *   back to the dispatcher, like every other malformed field here) rather than
 *   silently reinterpreted as "keep the previous run's key".
 *
 * The shape check deliberately constrains only what carries the hazard — no
 * whitespace, and a `/loops/<thisLoopId>/` segment — so a dispatcher that grows
 * a deeper org prefix or run suffix still parses.
 */
function parseS3StateKey(value: unknown, loopId: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = s3StateKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new SymphonyLoopRequestValidationError(
      `s3StateKey is malformed: ${formatZodIssues(parsed.error)}`
    );
  }
  const requestLoopId = z.string().min(1).safeParse(loopId);
  if (!requestLoopId.success) {
    throw new SymphonyLoopRequestValidationError(
      "s3StateKey is malformed: cannot be attributed to a loop because loopId is missing"
    );
  }
  const keyLoopId = S3_STATE_KEY_REGEX.exec(parsed.data)?.[1];
  if (keyLoopId !== requestLoopId.data) {
    throw new SymphonyLoopRequestValidationError(
      `s3StateKey is malformed: key belongs to loop '${keyLoopId}', not '${requestLoopId.data}'`
    );
  }
  return parsed.data;
}

function parseSupportingArtifacts(
  value: unknown
): SymphonyLoopSupportingArtifact[] {
  if (value === undefined || value === null) {
    return [];
  }
  const result = z.array(supportingArtifactSchema).safeParse(value);
  if (!result.success) {
    throw new SymphonyLoopRequestValidationError(
      `supportingArtifacts is malformed: ${formatZodIssues(result.error)}`
    );
  }
  return result.data;
}

function parseCodeEvaluationContext(
  value: unknown
): SymphonyCodeEvaluationContext | null {
  if (value === undefined || value === null) {
    return null;
  }
  const result = codeEvaluationContextSchema.safeParse(value);
  if (!result.success) {
    throw new SymphonyLoopRequestValidationError(
      `codeEvaluationContext is malformed: ${formatZodIssues(result.error)}`
    );
  }
  return result.data;
}

function parseBranchMaterialization(
  value: unknown
): SymphonyBranchMaterialization | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const result = branchMaterializationSchema.safeParse(value);
  if (!result.success) {
    throw new SymphonyLoopRequestValidationError(
      `branchMaterialization is malformed: ${formatZodIssues(result.error)}`
    );
  }
  return result.data;
}

function parseCloudSessionToken(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const result = cloudSessionTokenSchema.safeParse(value);
  if (!result.success) {
    throw new SymphonyLoopRequestValidationError(
      `cloudSessionToken is malformed: ${formatZodIssues(result.error)}`
    );
  }
  // Treat an empty/whitespace-only token as absent rather than rejecting the
  // whole loop request — the session token is optional and the heartbeat
  // degrades gracefully without it.
  return result.data.length > 0 ? result.data : undefined;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
