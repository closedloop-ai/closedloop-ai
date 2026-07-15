import {
  GitHubDataConnectionSource,
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { z } from "zod";
import {
  fetchSessionJson,
  type SessionFetchOptions,
} from "./api-response-utils.js";

export type DesktopGitHubIntegrationStatusFetchOptions = SessionFetchOptions;

const gitHubInstallationInfoSchema = z
  .object({
    id: z.string(),
    installationId: z.string(),
    accountLogin: z.string(),
    accountType: z.string(),
    status: z.enum(GitHubInstallationStatus),
    repositorySelection: z.string().nullable(),
    repositoryCount: z.number(),
    claimedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough();
const gitHubDataConnectionStatusSchema = z
  .object({
    connected: z.boolean(),
    sources: z.array(z.enum(GitHubDataConnectionSource)),
    oauthRequiredReasons: z.array(z.enum(GitHubOAuthRequiredReason)),
  })
  .passthrough();
const gitHubIntegrationStatusSchema = z.discriminatedUnion("connected", [
  z
    .object({
      connected: z.literal(true),
      installation: gitHubInstallationInfoSchema,
      githubDataConnection: gitHubDataConnectionStatusSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      connected: z.literal(false),
      githubDataConnection: gitHubDataConnectionStatusSchema.optional(),
    })
    .passthrough(),
]);

/**
 * Fetches the cloud GitHub integration status for Desktop Insights. Transport,
 * response, and schema failures return null so the renderer can keep a
 * backward-compatible authorize fallback instead of trusting malformed data.
 * Auth uses the current first-party Desktop session, not the configured API
 * key, because GitHub user-grant recovery is evaluated for the request user.
 */
export function fetchGitHubIntegrationStatus(
  options: DesktopGitHubIntegrationStatusFetchOptions
): Promise<GitHubIntegrationStatus | null> {
  return fetchSessionJson(
    options,
    "/integrations/github",
    gitHubIntegrationStatusSchema
  );
}
