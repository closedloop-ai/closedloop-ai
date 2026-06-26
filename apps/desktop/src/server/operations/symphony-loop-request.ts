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
    ...loopBody
  } = rawBody;
  const harness =
    rawHarness === undefined ? undefined : LoopHarnessSchema.parse(rawHarness);

  return {
    ...(loopBody as unknown as LoopRequestBody),
    ...(harness === undefined ? {} : { harness }),
    supportingArtifacts,
    codeEvaluationContext,
    ...(branchMaterialization ? { branchMaterialization } : {}),
  };
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
