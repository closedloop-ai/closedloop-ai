"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import { apiClient } from "@/lib/api-client";

type SyncResult = {
  synced: boolean;
  userId: string;
  organizationId: string;
};

/**
 * Sync current Clerk user to database.
 * Call this on app load to ensure user exists in DB (for local dev without webhooks).
 */
export async function syncUser(): Promise<ApiResult<SyncResult>> {
  return await apiClient.post<SyncResult>("/auth/sync", {});
}
