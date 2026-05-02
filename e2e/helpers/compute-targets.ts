import type { APIRequestContext } from "@playwright/test";
import type { ApiResult } from "@repo/api/src/types/common";
import type {
  ComputePreference,
  ComputePreferenceResponse,
  RegisterComputeTargetResponse,
} from "@repo/api/src/types/compute-target";
import { getApiBaseUrl } from "./api-url";

type RegisteredComputeTarget = {
  id: string;
  machineName: string;
};

export async function getComputePreference(
  request: APIRequestContext,
  token: string
): Promise<ComputePreferenceResponse> {
  const api = getApiBaseUrl();
  const response = await request.get(`${api}/settings/compute-preference`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as ApiResult<ComputePreferenceResponse>;
  if (!body.success) {
    throw new Error(`Failed to get compute preference: ${body.error}`);
  }
  return body.data;
}

export async function setComputePreference(
  request: APIRequestContext,
  {
    mode,
    computeTargetId,
    token,
  }: {
    mode: ComputePreference;
    computeTargetId?: string;
    token: string;
  }
): Promise<void> {
  const api = getApiBaseUrl();
  const response = await request.put(`${api}/settings/compute-preference`, {
    data: {
      mode,
      ...(computeTargetId ? { computeTargetId } : {}),
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to set compute preference: ${response.status()} ${response.statusText()}`
    );
  }
}

export async function restoreComputePreference(
  request: APIRequestContext,
  preference: ComputePreferenceResponse | null,
  token: string
): Promise<void> {
  if (!preference) {
    return;
  }
  await setComputePreference(request, {
    mode: preference.preferredComputeMode,
    computeTargetId: preference.computeTargetId,
    token,
  });
}

export async function registerComputeTarget(
  request: APIRequestContext,
  {
    machineName,
    token,
  }: {
    machineName: string;
    token: string;
  }
): Promise<RegisteredComputeTarget> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/compute-targets/register`, {
    data: {
      machineName,
      platform: "e2e",
      capabilities: { source: "feature-evaluation-e2e" },
      supportedOperations: ["loop.run"],
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  const body =
    (await response.json()) as ApiResult<RegisterComputeTargetResponse>;
  if (!body.success) {
    throw new Error(`Failed to register compute target: ${body.error}`);
  }
  return { id: body.data.id, machineName: body.data.machineName };
}

export async function deleteComputeTarget(
  request: APIRequestContext,
  computeTargetId: string | null,
  token: string
): Promise<void> {
  if (!computeTargetId) {
    return;
  }
  const api = getApiBaseUrl();
  try {
    const response = await request.delete(
      `${api}/compute-targets/${computeTargetId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok()) {
      console.error({
        computeTargetId,
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  } catch {
    console.error({
      computeTargetId,
      status: 0,
      statusText: "request failed",
    });
  }
}
