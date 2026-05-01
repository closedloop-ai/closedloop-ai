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

type DefaultRepositoryStub = {
  repoId: string;
  repoFullName: string;
  branch: string;
};

export async function createProject(
  request: APIRequestContext,
  {
    teamIds,
    name,
    defaultRepository,
  }: {
    teamIds: string[];
    name: string;
    defaultRepository?: DefaultRepositoryStub;
  }
): Promise<ProjectSummary> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/projects`, {
    data: { name, teamIds },
  });
  const body = (await response.json()) as ApiResult<ProjectSummary>;

  if (!body.success) {
    throw new Error(body.error);
  }

  const project = {
    id: body.data.id,
    slug: body.data.slug,
    name: body.data.name,
  };

  if (defaultRepository) {
    await setProjectDefaultRepository(request, project.id, defaultRepository);
  }

  return project;
}

async function setProjectDefaultRepository(
  request: APIRequestContext,
  projectId: string,
  defaultRepository: DefaultRepositoryStub
): Promise<void> {
  const api = getApiBaseUrl();
  const response = await request.put(`${api}/projects/${projectId}`, {
    data: { settings: { defaultRepository } },
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to set defaultRepository on project ${projectId}: ${response.status()} ${response.statusText()}`
    );
  }
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
