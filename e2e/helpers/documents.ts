import type { APIRequestContext } from "@playwright/test";
import type { ApiResult } from "@repo/api/src/types/common";
import type { DocumentType } from "@repo/api/src/types/document";
import { getApiBaseUrl } from "./api-url";

export type DocumentSummary = {
  id: string;
  slug: string;
  title: string;
};

export async function createDocument(
  request: APIRequestContext,
  {
    projectId,
    type,
    title,
    content,
    token,
  }: {
    projectId: string;
    type: DocumentType;
    title: string;
    content: string;
    token: string;
  }
): Promise<DocumentSummary> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/documents`, {
    data: { projectId, type, title, content },
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as ApiResult<DocumentSummary>;

  if (!body.success) {
    throw new Error(`Failed to create ${type} document: ${body.error}`);
  }

  return {
    id: body.data.id,
    slug: body.data.slug,
    title: body.data.title,
  };
}

export async function deleteDocument(
  request: APIRequestContext,
  documentId: string,
  token: string
): Promise<void> {
  const api = getApiBaseUrl();
  try {
    const response = await request.delete(`${api}/documents/${documentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok()) {
      console.error({
        documentId,
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  } catch {
    console.error({ documentId, status: 0, statusText: "request failed" });
  }
}
