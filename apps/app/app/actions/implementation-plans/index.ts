"use server";

import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateImplementationPlanInput,
  ImplementationPlan,
  ImplementationPlanWithPrd,
  UpdateImplementationPlanInput,
} from "@repo/api/src/types/implementation-plan";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

export async function getImplementationPlans(): Promise<
  ApiResult<ImplementationPlanWithPrd[]>
> {
  return await apiClient.get<ImplementationPlanWithPrd[]>(
    "/api/implementation-plans"
  );
}

export async function getImplementationPlanById(
  id: string
): Promise<ApiResult<ImplementationPlanWithPrd>> {
  return await apiClient.get<ImplementationPlanWithPrd>(
    `/api/implementation-plans/${id}`
  );
}

export async function createImplementationPlan(
  input: CreateImplementationPlanInput
): Promise<ApiResult<ImplementationPlan>> {
  const result = await apiClient.post<ImplementationPlan>(
    "/api/implementation-plans",
    input
  );
  if (result.success) {
    revalidatePath("/implementation-plans");
  }
  return result;
}

export async function updateImplementationPlan(
  input: UpdateImplementationPlanInput
): Promise<ApiResult<ImplementationPlan>> {
  const { id, ...data } = input;
  const result = await apiClient.put<ImplementationPlan>(
    `/api/implementation-plans/${id}`,
    data
  );
  if (result.success) {
    revalidatePath("/implementation-plans");
    revalidatePath(`/implementation-plans/${id}`);
  }
  return result;
}

export async function deleteImplementationPlan(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(
    `/api/implementation-plans/${id}`
  );
  if (result.success) {
    revalidatePath("/implementation-plans");
  }
  return result;
}

export async function regenerateImplementationPlan(
  id: string
): Promise<ApiResult<ImplementationPlan>> {
  const result = await apiClient.post<ImplementationPlan>(
    `/api/implementation-plans/${id}/regenerate`,
    {}
  );
  if (result.success) {
    revalidatePath("/implementation-plans");
    revalidatePath(`/implementation-plans/${id}`);
  }
  return result;
}
