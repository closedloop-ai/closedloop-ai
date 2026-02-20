import type {
  DisconnectGitHubResponse,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import { successResponse } from "@/lib/route-utils";
import { githubService } from "./service";

/**
 * GET /integrations/github
 *
 * Get the GitHub integration status for the current organization.
 */
export const GET = withAnyAuth<GitHubIntegrationStatus, "/integrations/github">(
  async ({ user }) => {
    const result = await githubService.getIntegrationStatus(
      user.organizationId
    );
    return successResponse(result);
  }
);

/**
 * DELETE /integrations/github
 *
 * Disconnect the GitHub integration for the current organization.
 */
export const DELETE = withAnyAuth<
  DisconnectGitHubResponse,
  "/integrations/github"
>(
  async ({ user }) => {
    await githubService.disconnectInstallation(user.organizationId);
    return successResponse({ disconnected: true });
  },
  { requiredScopes: ["delete"] }
);
