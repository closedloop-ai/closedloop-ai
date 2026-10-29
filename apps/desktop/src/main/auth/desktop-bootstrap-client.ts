import {
  type DesktopBootstrapOrganizationHttpRequest,
  type DesktopBootstrapOrganizationRequest,
  type DesktopBootstrapRedeemResult,
  desktopBootstrapRedeemResultSchema,
} from "@repo/api/src/types/desktop-bootstrap";
import {
  type DesktopSessionResult,
  type DesktopSessionTokens,
  mapDesktopSessionErrorResponse,
  parseSessionTokens,
  postSignedDesktopSession,
} from "../session/desktop-session-client.js";
import { uploadDesktopBootstrapLogo } from "./desktop-bootstrap-logo-upload.js";
import type { DesktopPopSigner } from "./desktop-pop.js";

const REDEEM_PATH = "/desktop/bootstrap-authorize/token";
const CREATE_ORGANIZATION_PATH = "/desktop/organizations/bootstrap";
const REQUEST_TIMEOUT_MS = 10_000;

export type RedeemDesktopBootstrapInput = {
  apiOrigin: string;
  code: string;
  codeVerifier: string;
  gatewayId: string;
  redirectUri: string;
  popSigner: DesktopPopSigner;
  fetchImpl?: typeof fetch;
};

export function redeemDesktopBootstrap(
  input: RedeemDesktopBootstrapInput
): Promise<DesktopSessionResult<DesktopBootstrapRedeemResult>> {
  return postSignedDesktopSession({
    apiOrigin: input.apiOrigin,
    path: REDEEM_PATH,
    body: {
      code: input.code,
      codeVerifier: input.codeVerifier,
      gatewayId: input.gatewayId,
      redirectUri: input.redirectUri,
    },
    popSigner: input.popSigner,
    fetchImpl: input.fetchImpl,
    parse: (body) => {
      const parsed = desktopBootstrapRedeemResultSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    },
  });
}

export async function createDesktopBootstrapOrganization(input: {
  apiOrigin: string;
  bootstrapToken: string;
  organization: DesktopBootstrapOrganizationRequest;
  fetchImpl?: typeof fetch;
}): Promise<DesktopSessionResult<DesktopSessionTokens>> {
  let url: URL;
  try {
    url = new URL(CREATE_ORGANIZATION_PATH, input.apiOrigin);
  } catch {
    return { ok: false, error: "network", retryable: false };
  }

  const organization: DesktopBootstrapOrganizationHttpRequest = {
    name: input.organization.name,
    slug: input.organization.slug,
  };
  if (input.organization.logo) {
    const uploaded = await uploadDesktopBootstrapLogo({
      url: url.toString(),
      bootstrapToken: input.bootstrapToken,
      logo: input.organization.logo,
      fetchImpl: input.fetchImpl ?? fetch,
    });
    if (!uploaded.ok) {
      return uploaded;
    }
    organization.logo = uploaded.value;
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(organization),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "network", retryable: true };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      ...mapDesktopSessionErrorResponse(response.status, body),
    };
  }
  const tokens = parseSessionTokens(body);
  return tokens
    ? { ok: true, value: tokens }
    : { ok: false, error: "invalid", retryable: false };
}
