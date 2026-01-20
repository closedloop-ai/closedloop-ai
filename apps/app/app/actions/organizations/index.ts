"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateOrganizationInput,
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

export async function getOrganizations(): Promise<ApiResult<Organization[]>> {
  return await apiClient.get<Organization[]>("/organizations");
}

export async function getOrganizationById(
  id: string
): Promise<ApiResult<Organization>> {
  return await apiClient.get<Organization>(`/organizations/${id}`);
}

export async function createOrganization(
  input: CreateOrganizationInput
): Promise<ApiResult<Organization>> {
  const result = await apiClient.post<Organization>("/organizations", input);
  if (result.success) {
    revalidatePath("/organizations");
  }
  return result;
}

export async function updateOrganization(
  input: UpdateOrganizationInput
): Promise<ApiResult<Organization>> {
  const { id, ...data } = input;
  const result = await apiClient.put<Organization>(
    `/organizations/${id}`,
    data
  );
  if (result.success) {
    revalidatePath("/organizations");
    revalidatePath(`/organizations/${id}`);
  }
  return result;
}

export async function deleteOrganization(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(
    `/organizations/${id}`
  );
  if (result.success) {
    revalidatePath("/organizations");
  }
  return result;
}
