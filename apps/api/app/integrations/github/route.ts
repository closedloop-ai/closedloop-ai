import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type {
  DisconnectGitHubResponse,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  recordNoOpUnlessRecorded,
  recordOrganizationWrite,
} from "@/lib/organization-write-receipt";
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
      user.organizationId,
      user.id
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
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, _request, _params, receipts) => {
      await githubService.disconnectInstallation(
        user.organizationId,
        recordOrganizationWrite(receipts)
      );
      // ISS-12552: with no installation to disconnect nothing is written.
      await recordNoOpUnlessRecorded(receipts);
      return successResponse(
        withOperationReceipt({ disconnected: true }, receipts)
      );
    }
  ),
  { requiredScopes: ["delete"] }
);
