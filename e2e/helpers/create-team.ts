import type { APIRequestContext } from "@playwright/test";
import type { ApiResult } from "@repo/api/src/types/common";
import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { getApiBaseUrl } from "./api-url";

type TeamSummary = {
  id: string;
  slug: string;
  name: string;
};

export async function createTeam(
  request: APIRequestContext,
  { name, token }: { name: string; token: string }
): Promise<TeamSummary> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/teams`, {
    data: { name },
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as ApiResult<TeamWithCounts>;

  if (!body.success) {
    throw new Error(body.error);
  }

  return { id: body.data.id, slug: body.data.slug, name: body.data.name };
}

export async function deleteTeam(
  request: APIRequestContext,
  teamId: string,
  token: string
): Promise<void> {
  const api = getApiBaseUrl();
  try {
    const response = await request.delete(`${api}/teams/${teamId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok()) {
      console.error({
        teamId,
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  } catch {
    console.error({ teamId, status: 0, statusText: "request failed" });
  }
}
