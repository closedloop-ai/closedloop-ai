"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  ProjectPriority,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

// Activity types
export type ActivityItem = {
  id: string;
  type: string;
  actor?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  description: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
};

export type ActivityResponse = {
  activities: ActivityItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
};

/**
 * Get all projects, optionally filtered by team
 */
export async function getProjects(
  teamId?: string
): Promise<ApiResult<ProjectWithDetails[]>> {
  const query = teamId ? `?teamId=${teamId}` : "";
  return await apiClient.get<ProjectWithDetails[]>(`/projects${query}`);
}

/**
 * Get projects by team ID
 */
export async function getProjectsByTeam(
  teamId: string
): Promise<ApiResult<ProjectWithDetails[]>> {
  return await apiClient.get<ProjectWithDetails[]>(
    `/projects?teamId=${teamId}`
  );
}

/**
 * Get a single project by ID
 */
export async function getProjectById(
  id: string
): Promise<ApiResult<ProjectWithDetails>> {
  return await apiClient.get<ProjectWithDetails>(`/projects/${id}`);
}

/**
 * Create a new project
 */
export async function createProject(
  input: CreateProjectInput
): Promise<ApiResult<ProjectWithDetails>> {
  const result = await apiClient.post<ProjectWithDetails>("/projects", {
    ...input,
    targetDate: input.targetDate?.toISOString(),
  });
  if (result.success) {
    revalidatePath("/projects");
    // Revalidate team pages if project is associated with teams
    if (input.teamIds) {
      for (const teamId of input.teamIds) {
        revalidatePath(`/teams/${teamId}/projects`);
      }
    }
  }
  return result;
}

/**
 * Update a project
 */
export async function updateProject(
  input: UpdateProjectInput
): Promise<ApiResult<ProjectWithDetails>> {
  const { id, ...data } = input;
  const result = await apiClient.put<ProjectWithDetails>(`/projects/${id}`, {
    ...data,
    targetDate: data.targetDate?.toISOString(),
  });
  if (result.success) {
    revalidatePath("/projects");
    revalidatePath(`/projects/${id}`);
  }
  return result;
}

/**
 * Delete a project
 */
export async function deleteProject(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(`/projects/${id}`);
  if (result.success) {
    revalidatePath("/projects");
  }
  return result;
}

/**
 * Update project owner
 */
export async function updateProjectOwner(
  projectId: string,
  ownerId: string | null
): Promise<ApiResult<ProjectWithDetails>> {
  return await updateProject({ id: projectId, ownerId });
}

/**
 * Update project target date
 */
export async function updateProjectTargetDate(
  projectId: string,
  targetDate: Date | null
): Promise<ApiResult<ProjectWithDetails>> {
  return await updateProject({ id: projectId, targetDate });
}

/**
 * Update project priority
 */
export async function updateProjectPriority(
  projectId: string,
  priority: ProjectPriority
): Promise<ApiResult<ProjectWithDetails>> {
  return await updateProject({ id: projectId, priority });
}

/**
 * Get project activity feed
 */
export async function getProjectActivity(
  projectId: string,
  page = 1,
  pageSize = 20
): Promise<ApiResult<ActivityResponse>> {
  return await apiClient.get<ActivityResponse>(
    `/projects/${projectId}/activity?page=${page}&pageSize=${pageSize}`
  );
}
