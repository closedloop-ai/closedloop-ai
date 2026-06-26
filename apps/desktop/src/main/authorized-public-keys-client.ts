import type { ApiKeyProvenance } from "./api-key-store.js";
import type { DesktopPopSigner } from "./desktop-pop.js";
import {
  buildManagedDesktopPopHeaders,
  type DesktopPopUnavailableReporter,
} from "./desktop-pop-sign-utils.js";

export type OrganizationCommandPublicKey = {
  id?: string;
  userId: string;
  organizationId: string;
  publicKeyBase64: string;
  fingerprint: string;
  createdAt: string;
  ownerName: string;
  ownerEmail?: string;
  targetContext?: unknown;
};

export type FetchOrganizationCommandKeysOptions = {
  apiOrigin: string;
  apiKey: string;
  apiKeyProvenance: ApiKeyProvenance;
  signDesktopRequest?: DesktopPopSigner;
  onDesktopPopUnavailable?: DesktopPopUnavailableReporter;
  computeTargetId?: string;
  gatewayId?: string;
};

type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Lists org-visible browser command-signing public keys from the API. The API
 * narrows visibility; Desktop only receives public key material and metadata.
 */
export async function fetchOrganizationCommandKeys(
  options: FetchOrganizationCommandKeysOptions
): Promise<OrganizationCommandPublicKey[]> {
  const url = new URL("/public-keys", options.apiOrigin);
  if (options.computeTargetId) {
    url.searchParams.set("computeTargetId", options.computeTargetId);
  }
  if (options.gatewayId) {
    url.searchParams.set("gatewayId", options.gatewayId);
  }
  const popHeaders = await buildManagedDesktopPopHeaders({
    apiKeyProvenance: options.apiKeyProvenance,
    signDesktopRequest: options.signDesktopRequest,
    request: {
      method: "GET",
      pathname: url.pathname,
    },
    surface: url.pathname,
    unavailableMessage:
      "PoP signing unavailable for command key listing; continuing bearer-only compatibility mode",
    onUnavailable: options.onDesktopPopUnavailable,
  });
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      ...(popHeaders ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as ApiResult<
    OrganizationCommandPublicKey[]
  > | null;
  if (!(response.ok && payload?.success)) {
    throw new Error(
      payload && !payload.success ? payload.error : "Failed to list public keys"
    );
  }
  if (!isOrganizationCommandPublicKeyArray(payload.data)) {
    throw new Error("Invalid public keys response");
  }
  return payload.data;
}

function isOrganizationCommandPublicKeyArray(
  value: unknown
): value is OrganizationCommandPublicKey[] {
  return Array.isArray(value) && value.every(isOrganizationCommandPublicKey);
}

function isOrganizationCommandPublicKey(
  value: unknown
): value is OrganizationCommandPublicKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<OrganizationCommandPublicKey>;
  return (
    (record.id === undefined || typeof record.id === "string") &&
    typeof record.userId === "string" &&
    typeof record.organizationId === "string" &&
    typeof record.publicKeyBase64 === "string" &&
    typeof record.fingerprint === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.ownerName === "string" &&
    (record.ownerEmail === undefined || typeof record.ownerEmail === "string")
  );
}
