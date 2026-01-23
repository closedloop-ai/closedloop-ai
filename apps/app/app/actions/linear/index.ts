"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  ExportToLinearInput,
  ExportToLinearResult,
  LinearDisconnectResponse,
  LinearIntegrationStatus,
} from "@repo/api/src/types/linear";
import { auth, generateOAuthToken } from "@repo/auth/server";
import { apiClient } from "@/lib/api-client";

/**
 * Get the Linear integration status for the current organization.
 * Returns connection status, organization name, and available teams.
 */
export async function getLinearIntegrationStatus(): Promise<
  ApiResult<LinearIntegrationStatus>
> {
  return await apiClient.get<LinearIntegrationStatus>("/integrations/linear");
}

/**
 * Generate the Linear OAuth URL with a signed auth token.
 *
 * This is needed because the app and API are on different domains,
 * so Clerk cookies aren't available when the browser redirects to the API.
 * Instead, we generate a short-lived signed token that the API can verify.
 *
 * @returns The full OAuth URL to redirect to, or null if not authenticated
 */
export async function getLinearOAuthUrl(): Promise<string | null> {
  const { userId, orgId } = await auth();

  if (!(userId && orgId)) {
    return null;
  }

  const token = generateOAuthToken({ userId, orgId });
  const apiUrl = process.env.API_URL || "http://localhost:3002";

  return `${apiUrl}/integrations/linear/oauth?auth_token=${encodeURIComponent(token)}`;
}

/**
 * Export an approved implementation plan to Linear.
 * Creates standalone issues for each task in the plan.
 */
export async function exportToLinear(
  input: ExportToLinearInput
): Promise<ApiResult<ExportToLinearResult>> {
  return await apiClient.post<ExportToLinearResult>(
    "/integrations/linear/export",
    input
  );
}

/**
 * Disconnect the Linear integration for the current organization.
 * Revokes access and removes stored tokens.
 */
export async function disconnectLinear(): Promise<
  ApiResult<LinearDisconnectResponse>
> {
  return await apiClient.delete<LinearDisconnectResponse>(
    "/integrations/linear"
  );
}
