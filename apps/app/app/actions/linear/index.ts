"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  ExportToLinearInput,
  ExportToLinearResult,
  LinearDisconnectResponse,
  LinearIntegrationStatus,
} from "@repo/api/src/types/linear";
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
