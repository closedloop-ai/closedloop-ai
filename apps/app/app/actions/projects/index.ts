"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateProjectInput,
  Project,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

export async function getProjects(
  organizationId?: string
): Promise<ApiResult<Project[]>> {
  const query = organizationId ? `?organizationId=${organizationId}` : "";
  return await apiClient.get<Project[]>(`/api/projects${query}`);
}

export async function getProjectById(id: string): Promise<ApiResult<Project>> {
  return await apiClient.get<Project>(`/api/projects/${id}`);
}

export async function createProject(
  input: CreateProjectInput
): Promise<ApiResult<Project>> {
  const result = await apiClient.post<Project>("/projects", input);
  if (result.success) {
    revalidatePath("/projects");
  }
  return result;
}

export async function updateProject(
  input: UpdateProjectInput
): Promise<ApiResult<Project>> {
  const { id, ...data } = input;
  const result = await apiClient.put<Project>(`/api/projects/${id}`, data);
  if (result.success) {
    revalidatePath("/projects");
    revalidatePath(`/projects/${id}`);
  }
  return result;
}

export async function deleteProject(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(
    `/api/projects/${id}`
  );
  if (result.success) {
    revalidatePath("/projects");
  }
  return result;
}
