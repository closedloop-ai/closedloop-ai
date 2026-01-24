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

export type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
};

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
    `/artifacts?${params.toString()}`
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
    `/artifacts?${params.toString()}`
  );
}

export async function getArtifactsByProject(
  projectId: string,
  latestOnly = true
): Promise<ApiResult<ArtifactWithWorkstream[]>> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  params.set("latestOnly", String(latestOnly));

  return await apiClient.get<ArtifactWithWorkstream[]>(
    `/artifacts?${params.toString()}`
  );
}

export async function getArtifactById(
  id: string,
  options?: { noCache?: boolean }
): Promise<ApiResult<ArtifactWithWorkstream>> {
  return await apiClient.get<ArtifactWithWorkstream>(
    `/artifacts/${id}`,
    options?.noCache ? { cache: "no-store" } : undefined
  );
}

export async function getArtifactVersions(
  id: string
): Promise<ApiResult<ArtifactWithWorkstream[]>> {
  // Step 1: Fetch the artifact to get its documentSlug
  const artifactResult = await apiClient.get<ArtifactWithWorkstream>(
    `/artifacts/${id}`
  );

  if (!artifactResult.success) {
    return artifactResult;
  }

  const artifact = artifactResult.data;

  // Step 2: Explicit null/undefined check for documentSlug
  if (artifact.documentSlug === null || artifact.documentSlug === undefined) {
    return {
      success: false,
      error: "Artifact does not have a documentSlug",
    };
  }

  // Step 3: Fetch versions by documentSlug (server-side filtering)
  const params = new URLSearchParams();
  params.set("type", artifact.type);
  params.set("documentSlug", artifact.documentSlug);
  params.set("latestOnly", "false");

  return await apiClient.get<ArtifactWithWorkstream[]>(
    `/artifacts?${params.toString()}`
  );
}

export async function createArtifact(
  input: CreateArtifactInput
): Promise<ApiResult<Artifact>> {
  const result = await apiClient.post<Artifact>("/artifacts", input);

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
  const result = await apiClient.put<Artifact>(`/artifacts/${id}`, body);

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
  const result = await apiClient.delete<{ deleted: true }>(`/artifacts/${id}`);

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
    `/artifacts/${id}/duplicate`,
    {}
  );

  if (result.success) {
    revalidatePath("/prds");
    revalidatePath("/implementation-plans");
  }

  return result;
}

export type CreateNewVersionInput = {
  id: string;
  content: string;
};

export async function createNewVersion(
  input: CreateNewVersionInput
): Promise<ApiResult<Artifact>> {
  const { id, content } = input;
  const result = await apiClient.post<Artifact>(
    `/artifacts/${id}/new-version`,
    { content }
  );

  if (result.success) {
    revalidatePath(`/implementation-plans/${result.data.id}`);
    revalidatePath("/implementation-plans");
  }

  return result;
}

export async function renameArtifact(
  id: string,
  title: string,
  fileName: string
): Promise<ApiResult<Artifact>> {
  const result = await apiClient.put<Artifact>(`/artifacts/${id}`, {
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
    `/artifacts/${id}/regenerate`,
    {}
  );

  if (result.success) {
    revalidatePath(`/implementation-plans/${id}`);
    revalidatePath("/implementation-plans");
  }

  return result;
}

/**
 * Create an implementation plan artifact and immediately trigger workflow generation.
 * This combines createArtifact + regenerateArtifact into a single action.
 */
export async function createAndGeneratePlan(
  input: CreateArtifactInput
): Promise<ApiResult<Artifact>> {
  // First create the artifact
  const createResult = await apiClient.post<Artifact>("/artifacts", input);

  if (!createResult.success) {
    return createResult;
  }

  // Then trigger regeneration (which dispatches to GitHub)
  const regenerateResult = await apiClient.post<Artifact>(
    `/artifacts/${createResult.data.id}/regenerate`,
    {}
  );

  // Revalidate paths
  if (input.workstreamId) {
    revalidatePath(`/workstreams/${input.workstreamId}`);
  }
  revalidatePath("/prds");
  revalidatePath("/implementation-plans");

  // Return the regenerate result if successful (it has updated version/generatedBy)
  // Otherwise return the original artifact so user can still navigate to it
  if (regenerateResult.success) {
    return regenerateResult;
  }

  // Return original artifact - status will show generation may have failed
  return createResult;
}

/**
 * Get the current generation status for an artifact.
 * Used by the GenerationStatusBanner component for polling.
 */
export async function getGenerationStatus(
  artifactId: string
): Promise<ApiResult<GenerationStatus>> {
  return await apiClient.get<GenerationStatus>(
    `/artifacts/${artifactId}/generation-status`
  );
}

/**
 * Request changes to an implementation plan.
 * Triggers the chat workflow which routes to /symphony-core:amend-plan.
 */
export async function requestPlanChanges(
  artifactId: string,
  changes: string
): Promise<ApiResult<{ success: true; message: string; artifactId: string }>> {
  const result = await apiClient.post<{
    success: true;
    message: string;
    artifactId: string;
  }>(`/artifacts/${artifactId}/request-changes`, { changes });

  if (result.success) {
    // Revalidate both the original and new artifact pages
    revalidatePath(`/implementation-plans/${artifactId}`);
    revalidatePath(`/implementation-plans/${result.data.artifactId}`);
    revalidatePath("/implementation-plans");
  }

  return result;
}
