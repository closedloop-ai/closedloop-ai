import { Buffer } from "node:buffer";
import type { ApiResult } from "@repo/api/src/types/common";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";
import {
  isStreamingEngineerRequest,
  RelayClient,
  type RelayEncodedBody,
  type RelayHttpRequestPayload,
  RelayRequestError,
} from "@/lib/engineer/relay-client";

const ENGINEER_RELAY_PREFIX = "/api/engineer-relay/";
const ENGINEER_PATH_PREFIX = "/api/engineer/";

function toEngineerPath(request: NextRequest): string {
  const pathname = request.nextUrl.pathname.startsWith(ENGINEER_RELAY_PREFIX)
    ? request.nextUrl.pathname.replace(
        ENGINEER_RELAY_PREFIX,
        ENGINEER_PATH_PREFIX
      )
    : request.nextUrl.pathname;
  return `${pathname}${request.nextUrl.search}`;
}

function collectRelayHeaders(request: NextRequest): Record<string, string> {
  const blocked = new Set([
    "authorization",
    "cookie",
    "x-compute-target",
    "host",
    "content-length",
  ]);

  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (blocked.has(key.toLowerCase())) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
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
    const jsonText = decoder.decode(bytes);
    try {
      return { kind: "json", value: JSON.parse(jsonText) };
    } catch {
      throw new RelayRequestError("Invalid JSON body", 400);
    }
  }

  if (
    contentType?.startsWith("text/") ||
    contentType?.includes("application/x-www-form-urlencoded")
  ) {
    return { kind: "text", value: decoder.decode(bytes), contentType };
  }

  return {
    kind: "base64",
    value: Buffer.from(bytes).toString("base64"),
    contentType,
  };
}

function toRelayHttpResponse(value: unknown): Response {
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value &&
    typeof (value as { status: unknown }).status === "number"
  ) {
    const status = (value as { status: number }).status;
    const body = (value as { body: unknown }).body;
    const headers = new Headers(
      (value as { headers?: Record<string, string> }).headers
    );

    const contentType = headers.get("content-type") ?? "";
    if (typeof body === "string" && !contentType.includes("application/json")) {
      return new Response(body, { status, headers });
    }

    return NextResponse.json(body, { status, headers });
  }

  return NextResponse.json(value);
}

type TargetOwnershipCheck = {
  id: string;
  isOnline: boolean;
};

async function ensureTargetOwnedAndOnline(
  apiOrigin: string,
  authToken: string,
  targetId: string
): Promise<void> {
  const response = await fetch(`${apiOrigin}/compute-targets`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as ApiResult<
    TargetOwnershipCheck[]
  > | null;

  if (!response.ok) {
    if (payload && !payload.success) {
      throw new RelayRequestError(payload.error, response.status);
    }
    throw new RelayRequestError(
      "Failed to validate compute target",
      response.status
    );
  }

  if (!payload?.success) {
    throw new RelayRequestError("Failed to validate compute target", 502);
  }

  const target = payload.data.find((entry) => entry.id === targetId);
  if (!target) {
    throw new RelayRequestError("Forbidden compute target", 403);
  }
  if (!target.isOnline) {
    throw new RelayRequestError("Compute target offline", 503);
  }
}

async function handleRelayRequest(request: NextRequest): Promise<Response> {
  const targetId = request.headers.get("x-compute-target");
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

  const apiOrigin = resolveApiOrigin(request);
  await ensureTargetOwnedAndOnline(apiOrigin, token, targetId);

  const path = toEngineerPath(request);
  const relayRequest: RelayHttpRequestPayload = {
    method: request.method,
    path,
    headers: collectRelayHeaders(request),
    body: await encodeBody(request),
  };

  const relayClient = new RelayClient(apiOrigin, token);
  const isStreaming = isStreamingEngineerRequest(
    request.method,
    path,
    request.headers.get("accept")
  );

  if (isStreaming) {
    const stream = await relayClient.streamOperation(targetId, relayRequest);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  const { value } = await relayClient.executeOperation(targetId, relayRequest);
  return toRelayHttpResponse(value);
}

async function handleWithErrorBoundary(
  request: NextRequest
): Promise<Response> {
  try {
    return await handleRelayRequest(request);
  } catch (error) {
    if (error instanceof RelayRequestError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    log.error("Engineer relay request failed", { error });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Relay request failed",
      },
      { status: 502 }
    );
  }
}

export function GET(request: NextRequest): Promise<Response> {
  return handleWithErrorBoundary(request);
}

export function POST(request: NextRequest): Promise<Response> {
  return handleWithErrorBoundary(request);
}

export function PUT(request: NextRequest): Promise<Response> {
  return handleWithErrorBoundary(request);
}

export function PATCH(request: NextRequest): Promise<Response> {
  return handleWithErrorBoundary(request);
}

export function DELETE(request: NextRequest): Promise<Response> {
  return handleWithErrorBoundary(request);
}
