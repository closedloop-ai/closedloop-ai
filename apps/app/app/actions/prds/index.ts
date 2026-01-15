"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreatePrdInput,
  Prd,
  UpdatePrdInput,
} from "@repo/api/src/types/prd";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

export async function getPRDs(): Promise<ApiResult<Prd[]>> {
  return await apiClient.get<Prd[]>("/api/prds");
}

export async function getPRDById(id: string): Promise<ApiResult<Prd>> {
  return await apiClient.get<Prd>(`/api/prds/${id}`);
}

export async function createPRD(
  input: CreatePrdInput
): Promise<ApiResult<Prd>> {
  const result = await apiClient.post<Prd>("/api/prds", input);
  if (result.success) {
    revalidatePath("/prds");
  }
  return result;
}

export async function updatePRD(
  input: UpdatePrdInput
): Promise<ApiResult<Prd>> {
  const { id, ...data } = input;
  const result = await apiClient.put<Prd>(`/api/prds/${id}`, data);
  if (result.success) {
    revalidatePath("/prds");
    revalidatePath(`/prds/${id}`);
  }
  return result;
}

export async function deletePRD(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(`/api/prds/${id}`);
  if (result.success) {
    revalidatePath("/prds");
  }
  return result;
}

export async function duplicatePRD(id: string): Promise<ApiResult<Prd>> {
  const result = await apiClient.post<Prd>(`/api/prds/${id}/duplicate`, {});
  if (result.success) {
    revalidatePath("/prds");
  }
  return result;
}

export async function renamePRD(
  id: string,
  title: string,
  fileName: string
): Promise<ApiResult<Prd>> {
  const result = await apiClient.put<Prd>(`/api/prds/${id}`, {
    title,
    fileName,
  });
  if (result.success) {
    revalidatePath("/prds");
    revalidatePath(`/prds/${id}`);
  }
  return result;
}
