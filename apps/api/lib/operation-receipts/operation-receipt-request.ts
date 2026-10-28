import "server-only";

import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import type { AuthContext } from "@/lib/auth/with-auth";
import { validateInternalSecret } from "@/lib/internal-auth";

const OPAQUE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Who made an API-key write and how it can be matched to a transcript call. */
export type OperationReceiptRequest = {
  organizationId: string;
  principalUserId: string;
  apiKeyId?: string;
  source: typeof OperationSource.Mcp | typeof OperationSource.Api;
  clientCallId?: string;
  requestFingerprint?: string;
  requestedAt: Date;
  /** The route template that took the write, such as `/documents/[id]`. */
  route?: string;
};

/**
 * The receipt context for a write, or null when the write gets no receipt.
 *
 * Only API-key writes get one (PRD-800 "Writes made outside the
 * Closedloop MCP"): a browser or Desktop session has no agent transcript to
 * match. A request is `mcp` only when it carries BOTH a valid internal secret
 * and the MCP client marker, because the `apps/app` gateway relay and
 * `apps/relay` hold the same secret. The call id and fingerprint are read only
 * for `mcp` requests and are opaque match keys, never identity.
 */
export function readOperationReceiptRequest(
  context: AuthContext,
  request: Request,
  requestedAt: Date = new Date()
): OperationReceiptRequest | null {
  if (context.authMethod !== "api_key") {
    return null;
  }
  const base = {
    organizationId: context.user.organizationId,
    principalUserId: context.user.id,
    ...(context.apiKeyId ? { apiKeyId: context.apiKeyId } : {}),
    requestedAt,
  };
  if (!isMcpRequest(request)) {
    return { ...base, source: OperationSource.Api };
  }
  const clientCallId = readOpaqueKey(
    request,
    OperationEvidenceHeader.ClientCallId
  );
  const requestFingerprint = readOpaqueKey(
    request,
    OperationEvidenceHeader.RequestFingerprint
  );
  return {
    ...base,
    source: OperationSource.Mcp,
    ...(clientCallId ? { clientCallId } : {}),
    ...(requestFingerprint ? { requestFingerprint } : {}),
  };
}

function isMcpRequest(request: Request): boolean {
  return (
    request.headers.get(OperationEvidenceHeader.McpClient) ===
      MCP_CLIENT_HEADER_VALUE && validateInternalSecret(request)
  );
}

function readOpaqueKey(request: Request, header: string): string | undefined {
  const value = request.headers.get(header)?.trim();
  return value && OPAQUE_KEY.test(value) ? value : undefined;
}

/**
 * ISS-12552: the route template a request reached, such as
 * `/documents/[id]/threads/[threadId]`, from the route's own params, so a
 * receipt names the route and never an id.
 */
export function receiptRouteTemplate(
  request: Request,
  params: Readonly<Record<string, string | string[] | undefined>>
): string {
  const segmentNames = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    for (const segment of [value ?? []].flat()) {
      segmentNames.set(segment, `[${name}]`);
    }
  }
  return new URL(request.url).pathname
    .split("/")
    .map((segment) => segmentNames.get(decodeSegment(segment)) ?? segment)
    .join("/");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
