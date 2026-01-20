"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateWorkstreamInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamWithProject,
} from "@repo/api/src/types/workstream";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

export async function getWorkstreams(
  projectId?: string
): Promise<ApiResult<WorkstreamWithProject[]>> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("projectId", projectId);
  }

  const query = params.toString();
  return await apiClient.get<WorkstreamWithProject[]>(
    `/api/workstreams${query ? `?${query}` : ""}`
  );
}

export async function getRecentWorkstreams(
  limit = 6
): Promise<ApiResult<WorkstreamWithProject[]>> {
  return await apiClient.get<WorkstreamWithProject[]>(
    `/api/workstreams?limit=${limit}`
  );
}

export async function searchWorkstreams(
  query: string
): Promise<ApiResult<WorkstreamWithProject[]>> {
  return await apiClient.get<WorkstreamWithProject[]>(
    `/api/workstreams?search=${encodeURIComponent(query)}`
  );
}

export async function getWorkstreamById(
  id: string
): Promise<ApiResult<Workstream>> {
  return await apiClient.get<Workstream>(`/api/workstreams/${id}`);
}

export async function createWorkstream(
  input: CreateWorkstreamInput
): Promise<ApiResult<Workstream>> {
  const result = await apiClient.post<Workstream>("/workstreams", input);

  if (result.success) {
    revalidatePath("/workstreams");
  }

  return result;
}

export async function updateWorkstream(
  input: UpdateWorkstreamInput
): Promise<ApiResult<Workstream>> {
  const { id, ...body } = input;
  const result = await apiClient.put<Workstream>(
    `/api/workstreams/${id}`,
    body
  );

  if (result.success) {
    revalidatePath("/workstreams");
    revalidatePath(`/workstreams/${id}`);
  }

  return result;
}

export async function deleteWorkstream(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(
    `/api/workstreams/${id}`
  );

  if (result.success) {
    revalidatePath("/workstreams");
  }

  return result;
}
