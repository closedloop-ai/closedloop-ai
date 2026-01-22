"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  Team,
  TeamMember,
  TeamRole,
  TeamWithCounts,
} from "@repo/api/src/types/teams";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

/**
 * Get all teams for the current user's organization
 */
export async function getTeams(): Promise<ApiResult<TeamWithCounts[]>> {
  return await apiClient.get<TeamWithCounts[]>("/teams");
}

/**
 * Get a single team by ID
 */
export async function getTeamById(
  id: string
): Promise<ApiResult<TeamWithCounts>> {
  return await apiClient.get<TeamWithCounts>(`/teams/${id}`);
}

/**
 * Create a new team
 */
export async function createTeam(input: {
  name: string;
  slug?: string;
}): Promise<ApiResult<TeamWithCounts>> {
  const result = await apiClient.post<TeamWithCounts>("/teams", input);
  if (result.success) {
    revalidatePath("/teams");
  }
  return result;
}

/**
 * Update a team
 */
export async function updateTeam(
  id: string,
  input: { name?: string; slug?: string }
): Promise<ApiResult<Team>> {
  const result = await apiClient.put<Team>(`/teams/${id}`, input);
  if (result.success) {
    revalidatePath("/teams");
    revalidatePath(`/teams/${id}`);
  }
  return result;
}

/**
 * Delete a team
 */
export async function deleteTeam(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(`/teams/${id}`);
  if (result.success) {
    revalidatePath("/teams");
  }
  return result;
}

// ==================== Team Members ====================

/**
 * Get all members of a team
 */
export async function getTeamMembers(
  teamId: string
): Promise<ApiResult<TeamMember[]>> {
  return await apiClient.get<TeamMember[]>(`/teams/${teamId}/members`);
}

/**
 * Add a member to a team
 */
export async function addTeamMember(
  teamId: string,
  userId: string,
  role?: TeamRole
): Promise<ApiResult<TeamMember>> {
  const result = await apiClient.post<TeamMember>(`/teams/${teamId}/members`, {
    userId,
    role,
  });
  if (result.success) {
    revalidatePath(`/teams/${teamId}`);
  }
  return result;
}

/**
 * Update a team member's role
 */
export async function updateTeamMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole
): Promise<ApiResult<TeamMember>> {
  const result = await apiClient.put<TeamMember>(
    `/teams/${teamId}/members/${userId}`,
    { role }
  );
  if (result.success) {
    revalidatePath(`/teams/${teamId}`);
  }
  return result;
}

/**
 * Remove a member from a team
 */
export async function removeTeamMember(
  teamId: string,
  userId: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(
    `/teams/${teamId}/members/${userId}`
  );
  if (result.success) {
    revalidatePath(`/teams/${teamId}`);
  }
  return result;
}
