"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { apiClient } from "@/lib/api-client";

/**
 * Get all users in the organization
 */
export async function getOrganizationUsers(): Promise<ApiResult<User[]>> {
  return await apiClient.get<User[]>("/users");
}
