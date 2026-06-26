import { Buffer } from "node:buffer";
import {
  CURRENT_DESKTOP_API_NAMESPACE,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import {
  BranchViewLocalErrorCode,
  BranchViewLocalGatewayPath,
  BranchViewLocalHeader,
} from "@repo/api/src/types/branch-view-local";
import { auth } from "@repo/auth/server";
import type {
  RelayEncodedBody,
  RelayHttpRequestPayload,
} from "@repo/shared-platform/relay-request-model";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { resolveApiOrigin } from "@/lib/api-origin";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import { collectCommandSigningHeaders } from "@/lib/desktop-command-signing/relay-command-signing";
import { RelayClient, RelayRequestError } from "@/lib/engineer/relay-client";
import { parseRelayHttpResponse } from "@/lib/engineer/relay-response";

type RouteParams = {
  externalLinkId: string;
  path: string[];
};

function localError(status: number, code: BranchViewLocalErrorCode): Response {
  return NextResponse.json({ error: code, code }, { status });
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
  }
}

function toGatewayPath(pathParts: string[], request: NextRequest): string {
  const gatewayPath = `/api/gateway/${pathParts.join("/")}`;
  const url = new URL(gatewayPath, "http://local");
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    url.searchParams.append(key, value);
  }
  return `${url.pathname}${url.search}`;
}

async function encodeBody(request: NextRequest): Promise<RelayEncodedBody> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { kind: "none" };
  }
  const contentType = request.headers.get("content-type");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { kind: "none" };
  }
  const decoder = new TextDecoder();
  if (contentType?.includes("application/json")) {
    try {
      return { kind: "json", value: JSON.parse(decoder.decode(bytes)) };
    } catch {
      throw new InvalidJsonBodyError();
    }
  }
  if (contentType?.startsWith("text/")) {
    return { kind: "text", value: decoder.decode(bytes), contentType };
  }
  return {
    kind: "base64",
    value: Buffer.from(bytes).toString("base64"),
    contentType,
  };
}

function extractProofValue(
  request: NextRequest,
  encodedBody: RelayEncodedBody,
  key: string
): string | null {
  const queryValue = request.nextUrl.searchParams.get(key);
  if (queryValue) {
    return queryValue;
  }
  if (
    encodedBody.kind === "json" &&
    typeof encodedBody.value === "object" &&
    encodedBody.value !== null &&
    !Array.isArray(encodedBody.value)
  ) {
    const bodyValue = encodedBody.value[key];
    return typeof bodyValue === "string" ? bodyValue : null;
  }
  return null;
}

function toRelayHttpResponse(value: unknown): Response {
  const parsed = parseRelayHttpResponse(value);
  if (parsed) {
    const contentType = parsed.headers.get("content-type") ?? "";
    if (
      typeof parsed.body === "string" &&
      !contentType.includes("application/json")
    ) {
      return new Response(parsed.body, {
        status: parsed.status,
        headers: parsed.headers,
      });
    }

    return NextResponse.json(parsed.body, {
      status: parsed.status,
      headers: parsed.headers,
    });
  }

  return NextResponse.json(
    { error: "Relay response missing expected envelope" },
    { status: 502 }
  );
}

async function handleLocalGateway(
  request: NextRequest,
  paramsPromise: Promise<RouteParams>
): Promise<Response> {
  const params = await paramsPromise;
  const targetId = request.headers.get(COMPUTE_TARGET_HEADER);
  if (!targetId) {
    return NextResponse.json(
      { error: "Missing X-Compute-Target header" },
      { status: 400 }
    );
  }
  const { userId, getToken } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = await getToken();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawGatewayPath = toGatewayPath(params.path, request);
  const path = rewriteDesktopApiPath(
    rawGatewayPath,
    CURRENT_DESKTOP_API_NAMESPACE
  );
  const gatewayPathname = new URL(path, "http://local").pathname;
  if (
    gatewayPathname !== BranchViewLocalGatewayPath.List &&
    gatewayPathname !== BranchViewLocalGatewayPath.Diff &&
    gatewayPathname !== BranchViewLocalGatewayPath.CommitPush
  ) {
    return localError(403, BranchViewLocalErrorCode.AuthorizationRequired);
  }

  const body = await encodeBody(request);
  const repoFullName = extractProofValue(request, body, "repoFullName");
  const headBranch = extractProofValue(request, body, "headBranch");
  const prNumber = extractProofValue(request, body, "prNumber");
  if (!(repoFullName && headBranch && prNumber)) {
    return NextResponse.json(
      { error: "repoFullName, headBranch, and prNumber are required" },
      { status: 400 }
    );
  }

  const headers: Record<string, string> = {
    [BranchViewLocalHeader.ExternalLinkId]: params.externalLinkId,
    [BranchViewLocalHeader.RepoFullName]: repoFullName,
    [BranchViewLocalHeader.HeadBranch]: headBranch,
    [BranchViewLocalHeader.PrNumber]: prNumber,
  };
  if (gatewayPathname === BranchViewLocalGatewayPath.CommitPush) {
    headers["x-desktop-force-approval"] = "1";
    headers["x-desktop-approval-reason"] =
      `Commit and push local Branch View changes for ${repoFullName}#${prNumber}`;
  }

  const relayRequest: RelayHttpRequestPayload = {
    method: request.method,
    path,
    headers,
    body,
  };
  const commandSigning = collectCommandSigningHeaders(request.headers);
  const relayClient = new RelayClient(
    resolveApiOrigin(request),
    token,
    env.INTERNAL_API_SECRET
  );
  relayClient.setRefreshToken(getToken);
  const { value } = await relayClient.executeOperation(
    targetId,
    relayRequest,
    commandSigning,
    { localContent: true }
  );
  return toRelayHttpResponse(value);
}

async function handleWithBoundary(
  request: NextRequest,
  params: Promise<RouteParams>
): Promise<Response> {
  try {
    return await handleLocalGateway(request, params);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RelayRequestError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json(
      { error: "Branch View local relay request failed" },
      { status: 502 }
    );
  }
}

export function GET(
  request: NextRequest,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  return handleWithBoundary(request, params);
}

export function POST(
  request: NextRequest,
  { params }: { params: Promise<RouteParams> }
): Promise<Response> {
  return handleWithBoundary(request, params);
}
