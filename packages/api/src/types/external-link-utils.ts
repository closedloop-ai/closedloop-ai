import { z } from "zod/v4";
import type { DeploymentMetadata, PullRequestMetadata } from "./external-link";
import { GitHubPRState } from "./github";

/** Parsed preview deployment with its URL. */
export type PreviewDeploymentInfo = Partial<DeploymentMetadata> & {
  url: string | null;
};

/**
 * Type-safe parser for PREVIEW_DEPLOYMENT metadata JSON.
 * Returns null if metadata is missing or not a valid object.
 */
export function parseDeploymentMetadata(
  metadata: unknown
): DeploymentMetadata | null {
  const result = deploymentMetadataSchema.safeParse(metadata);
  if (!result.success) {
    return null;
  }
  return {
    statusUrl: result.data.statusUrl,
    deploymentUrl: result.data.deploymentUrl,
    state: result.data.state,
    environment: result.data.environment,
    ref: result.data.ref,
    sha: result.data.sha,
    transient: result.data.transient,
    production: result.data.production,
  };
}

/**
 * Type-safe parser for PULL_REQUEST metadata JSON.
 * Returns null if metadata is missing or not valid.
 */
export function parsePullRequestMetadata(
  metadata: unknown
): PullRequestMetadata | null {
  const result = pullRequestMetadataSchema.safeParse(metadata);
  if (!result.success) {
    return null;
  }
  return result.data;
}

const deploymentMetadataSchema = z.object({
  statusUrl: z.string().optional(),
  deploymentUrl: z.string().optional(),
  state: z.string().optional(),
  environment: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  transient: z.boolean().optional(),
  production: z.boolean().optional(),
});

const pullRequestMetadataSchema = z.object({
  number: z.number(),
  githubId: z.string(),
  headBranch: z.string(),
  baseBranch: z.string(),
  state: z.enum(GitHubPRState),
});
