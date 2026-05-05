import type { APIRequestContext } from "@playwright/test";
import type { ArtifactLink, LinkType } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { getApiBaseUrl } from "./api-url";

export async function createArtifactLink(
  request: APIRequestContext,
  {
    sourceId,
    targetId,
    linkType,
    token,
  }: {
    sourceId: string;
    targetId: string;
    linkType: LinkType;
    token: string;
  }
): Promise<void> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/artifact-links`, {
    data: { sourceId, targetId, linkType },
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as ApiResult<ArtifactLink>;
  if (!body.success) {
    throw new Error(`Failed to create artifact link: ${body.error}`);
  }
}
