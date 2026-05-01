import type { APIRequestContext } from "@playwright/test";
import { getApiBaseUrl } from "./api-url";

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

type ProjectSummary = {
  id: string;
  slug: string | null;
  name: string;
};

export async function createProject(
  request: APIRequestContext,
  { teamIds, name }: { teamIds: string[]; name: string }
): Promise<ProjectSummary> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/projects`, {
    data: { name, teamIds },
  });
  const body = (await response.json()) as ApiResult<ProjectSummary>;

  if (!body.success) {
    throw new Error(body.error);
  }

  return { id: body.data.id, slug: body.data.slug, name: body.data.name };
}

export async function deleteProject(
  request: APIRequestContext,
  projectId: string
): Promise<void> {
  const api = getApiBaseUrl();
  try {
    const response = await request.delete(`${api}/projects/${projectId}`);

    if (!response.ok()) {
      console.error({
        projectId,
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  } catch {
    console.error({ projectId, status: 0, statusText: "request failed" });
  }
}
