import {
  ARTIFACT_COLLABORATOR_BATCH_MAX_IDS,
  ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE,
  type ArtifactCollaboratorBatchResponse,
  type CollaboratorArtifactType,
  normalizeArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import { ApiError } from "../api/api-error";

type CollaboratorHttpClient = {
  get(path: string): Promise<unknown>;
};

/** Read complete requested ID pages through the shared cloud contract. */
export async function readArtifactCollaborators(
  api: CollaboratorHttpClient,
  artifactType: CollaboratorArtifactType,
  artifactIds: readonly string[]
): Promise<ArtifactCollaboratorBatchResponse | null> {
  const uniqueIds = [...new Set(artifactIds)];
  const results: ArtifactCollaboratorBatchResponse["results"] = [];
  const seenResultIds = new Set<string>();
  for (
    let start = 0;
    start < uniqueIds.length;
    start += ARTIFACT_COLLABORATOR_BATCH_MAX_IDS
  ) {
    const ids = uniqueIds.slice(
      start,
      start + ARTIFACT_COLLABORATOR_BATCH_MAX_IDS
    );
    const requestedPageIds = new Set(ids);
    let raw: unknown;
    try {
      raw = await readCollaboratorIdGroup(api, artifactType, ids);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 410 || error.status === 501)
      ) {
        return null;
      }
      throw error;
    }
    for (const entry of normalizeArtifactCollaboratorBatchResponse(
      raw,
      artifactType
    ).results) {
      if (
        !requestedPageIds.has(entry.artifactId) ||
        seenResultIds.has(entry.artifactId)
      ) {
        throw new Error("Unexpected collaborator batch identity");
      }
      seenResultIds.add(entry.artifactId);
      results.push(entry);
    }
  }
  return { results };
}

/** Split only the server's explicit budget failure; every requested ID remains in the result. */
async function readCollaboratorIdGroup(
  api: CollaboratorHttpClient,
  artifactType: CollaboratorArtifactType,
  ids: readonly string[]
): Promise<ArtifactCollaboratorBatchResponse> {
  const params = new URLSearchParams({ artifactType });
  for (const id of ids) {
    params.append("artifactIds", id);
  }
  try {
    const response = normalizeArtifactCollaboratorBatchResponse(
      await api.get(`/artifacts/collaborators?${params.toString()}`),
      artifactType
    );
    const requestedIds = new Set(ids);
    const resultIds = new Set<string>();
    for (const entry of response.results) {
      if (
        !requestedIds.has(entry.artifactId) ||
        resultIds.has(entry.artifactId)
      ) {
        throw new Error("Unexpected collaborator batch identity");
      }
      resultIds.add(entry.artifactId);
    }
    return response;
  } catch (error) {
    if (
      !(
        error instanceof ApiError &&
        error.status === 413 &&
        error.code === ARTIFACT_COLLABORATOR_BATCH_TOO_LARGE &&
        ids.length > 1
      )
    ) {
      throw error;
    }
    const middle = Math.ceil(ids.length / 2);
    const first = normalizeArtifactCollaboratorBatchResponse(
      await readCollaboratorIdGroup(api, artifactType, ids.slice(0, middle)),
      artifactType
    );
    const second = normalizeArtifactCollaboratorBatchResponse(
      await readCollaboratorIdGroup(api, artifactType, ids.slice(middle)),
      artifactType
    );
    return { results: [...first.results, ...second.results] };
  }
}
