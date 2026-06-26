import { ApiError } from "@repo/app/shared/api/api-error";
import {
  extractRawErrorMessage,
  parseRawErrorBody,
} from "@repo/app/shared/api/api-error-response";
import {
  type ReposResponse as ReposResponseBase,
  reposOptions as reposOptionsBase,
} from "@/lib/git/repos";

export type ReposResponse = ReposResponseBase;
export const reposOptions = reposOptionsBase;

/* ---------- Mutation helpers ---------- */

export async function addRepo(path: string) {
  const response = await fetch("/api/gateway/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await response.json();
  if (!response.ok) {
    throwApiErrorFromBody(response.status, data, "Failed to add repository");
  }
  return data;
}

export async function removeRepo(path: string) {
  const response = await fetch(
    `/api/gateway/repos?path=${encodeURIComponent(path)}`,
    {
      method: "DELETE",
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throwApiErrorFromBody(response.status, data, "Failed to remove repository");
  }
  return data;
}

export async function updateRepoSettings(settings: {
  worktreeParentDir?: string;
  worktreeParentDirConfirmed?: boolean;
}) {
  const response = await fetch("/api/gateway/repos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const data = await response.json();
  if (!response.ok) {
    throwApiErrorFromBody(response.status, data, "Failed to update settings");
  }
  return data;
}

function throwApiErrorFromBody(
  status: number,
  body: unknown,
  fallback: string
): never {
  const parsed = parseRawErrorBody(body);
  throw new ApiError(extractRawErrorMessage(body, fallback), status, {
    code: parsed?.code,
    data: body,
    details: parsed?.details,
    timestamp: parsed?.timestamp,
  });
}
