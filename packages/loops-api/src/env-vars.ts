import { z } from "zod";

/**
 * Environment variable names passed from the backend API to ECS containers
 * via task definition overrides.
 */
export const LoopEnvVar = {
  LoopId: "LOOP_ID",
  Command: "COMMAND",
  AuthToken: "CLOSEDLOOP_AUTH_TOKEN",
  ApiBaseUrl: "API_BASE_URL",
  OrganizationId: "ORGANIZATION_ID",
  TargetRepo: "TARGET_REPO",
  TargetBranch: "TARGET_BRANCH",
  S3Bucket: "S3_BUCKET",
  S3Region: "S3_REGION",
  S3ContextKey: "S3_CONTEXT_KEY",
  S3ContextUrl: "S3_CONTEXT_URL",
  S3StateKey: "S3_STATE_KEY",
  S3ParentStateKey: "S3_PARENT_STATE_KEY",
  ParentSessionId: "PARENT_SESSION_ID",
  ParentBranchName: "PARENT_BRANCH_NAME",
  CorrelationId: "CORRELATION_ID",
  MaxIterations: "MAX_ITERATIONS",
  ArtifactId: "ARTIFACT_ID",
} as const;
export type LoopEnvVar = (typeof LoopEnvVar)[keyof typeof LoopEnvVar];

/**
 * Zod schema for validating the ECS container environment.
 * Required fields must be present; optional fields may be absent.
 */
export const LoopEnvVarSchema = z.object({
  [LoopEnvVar.LoopId]: z.string(),
  [LoopEnvVar.Command]: z.string(),
  [LoopEnvVar.AuthToken]: z.string(),
  [LoopEnvVar.ApiBaseUrl]: z.string(),
  [LoopEnvVar.OrganizationId]: z.string(),
  [LoopEnvVar.S3Bucket]: z.string(),
  [LoopEnvVar.S3StateKey]: z.string(),
  [LoopEnvVar.TargetRepo]: z.string().optional(),
  [LoopEnvVar.TargetBranch]: z.string().optional(),
  [LoopEnvVar.S3Region]: z.string().optional(),
  [LoopEnvVar.S3ContextKey]: z.string().optional(),
  [LoopEnvVar.S3ContextUrl]: z.string().optional(),
  [LoopEnvVar.S3ParentStateKey]: z.string().optional(),
  [LoopEnvVar.ParentSessionId]: z.string().optional(),
  [LoopEnvVar.ParentBranchName]: z.string().optional(),
  [LoopEnvVar.CorrelationId]: z.string().optional(),
  [LoopEnvVar.MaxIterations]: z.string().optional(),
  [LoopEnvVar.ArtifactId]: z.string().optional(),
});
