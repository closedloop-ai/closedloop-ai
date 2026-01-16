"use server";

import type {
  Artifact,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { revalidatePath } from "next/cache";
import { apiClient } from "@/lib/api-client";

export async function getArtifacts(
  workstreamId: string,
  type?: string,
  latestOnly = true
): Promise<ApiResult<ArtifactWithWorkstream[]>> {
  const params = new URLSearchParams();
  params.set("workstreamId", workstreamId);
  if (type) {
    params.set("type", type);
  }
  params.set("latestOnly", String(latestOnly));

  return await apiClient.get<ArtifactWithWorkstream[]>(
    `/api/artifacts?${params.toString()}`
  );
}

export async function getArtifactsByType(
  type: string,
  latestOnly = true
): Promise<ApiResult<ArtifactWithWorkstream[]>> {
  const params = new URLSearchParams();
  params.set("type", type);
  params.set("latestOnly", String(latestOnly));

  return await apiClient.get<ArtifactWithWorkstream[]>(
    `/api/artifacts?${params.toString()}`
  );
}

export async function getArtifactById(
  id: string
): Promise<ApiResult<ArtifactWithWorkstream>> {
  return await apiClient.get<ArtifactWithWorkstream>(`/api/artifacts/${id}`);
}

export async function createArtifact(
  input: CreateArtifactInput
): Promise<ApiResult<Artifact>> {
  const result = await apiClient.post<Artifact>("/api/artifacts", input);

  if (result.success) {
    if (input.workstreamId) {
      revalidatePath(`/workstreams/${input.workstreamId}`);
    }
    revalidatePath("/prds");
    revalidatePath("/implementation-plans");
  }

  return result;
}

export async function updateArtifact(
  input: UpdateArtifactInput
): Promise<ApiResult<Artifact>> {
  const { id, ...body } = input;
  const result = await apiClient.put<Artifact>(`/api/artifacts/${id}`, body);

  if (result.success) {
    revalidatePath(`/artifacts/${id}`);
    revalidatePath("/prds");
    revalidatePath("/implementation-plans");
  }

  return result;
}

export async function deleteArtifact(
  id: string
): Promise<ApiResult<{ deleted: true }>> {
  const result = await apiClient.delete<{ deleted: true }>(
    `/api/artifacts/${id}`
  );

  if (result.success) {
    revalidatePath("/prds");
    revalidatePath("/implementation-plans");
  }

  return result;
}

export async function duplicateArtifact(
  id: string
): Promise<ApiResult<Artifact>> {
  const result = await apiClient.post<Artifact>(
    `/api/artifacts/${id}/duplicate`,
    {}
  );

  if (result.success) {
    revalidatePath("/prds");
    revalidatePath("/implementation-plans");
  }

  return result;
}

export async function renameArtifact(
  id: string,
  title: string,
  fileName: string
): Promise<ApiResult<Artifact>> {
  const result = await apiClient.put<Artifact>(`/api/artifacts/${id}`, {
    title,
    fileName,
  });

  if (result.success) {
    revalidatePath(`/prds/${id}`);
    revalidatePath(`/implementation-plans/${id}`);
    revalidatePath("/prds");
    revalidatePath("/implementation-plans");
  }

  return result;
}

export async function regenerateArtifact(
  id: string
): Promise<ApiResult<Artifact>> {
  const result = await apiClient.post<Artifact>(
    `/api/artifacts/${id}/regenerate`,
    {}
  );

  if (result.success) {
    revalidatePath(`/implementation-plans/${id}`);
    revalidatePath("/implementation-plans");
  }

  return result;
}
