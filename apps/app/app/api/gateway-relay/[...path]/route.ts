import { Buffer } from "node:buffer";
import {
  CURRENT_DESKTOP_API_NAMESPACE,
  getDesktopApiNamespaceFromCapabilities,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import type { ApiResult } from "@repo/api/src/types/common";
import type {
  BrowserSignedCommandId,
  HealthCheckResponse,
  UpsertComputeTargetHealthCheckSnapshotInput,
} from "@repo/api/src/types/compute-target";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { resolveApiOrigin } from "@/lib/api-origin";
import {
  COMMAND_ID_HEADER,
  COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
  COMMAND_SIGNATURE_HEADER,
  COMMAND_SIGNATURE_PAYLOAD_HEADER,
  COMPUTE_TARGET_HEADER,
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_PATH_PREFIX,
  GATEWAY_RELAY_PATH_PREFIX,
} from "@/lib/engineer/constants";
import {
  isStreamingGatewayRequest,
  RelayClient,
  type RelayEncodedBody,
  type RelayHttpRequestPayload,
  RelayRequestError,
} from "@/lib/engineer/relay-client";

export const maxDuration = 300; // 5 minutes — relay proxies long-running streams (reviews, chat)

function toGatewayPath(request: NextRequest): string {
  const pathname = request.nextUrl.pathname.startsWith(
    GATEWAY_RELAY_PATH_PREFIX
  )
    ? request.nextUrl.pathname.replace(
        GATEWAY_RELAY_PATH_PREFIX,
        GATEWAY_PATH_PREFIX
      )
    : request.nextUrl.pathname;
  return `${pathname}${request.nextUrl.search}`;
}

function collectRelayHeaders(request: NextRequest): Record<string, string> {
  const blocked = new Set([
    "authorization",
    "cookie",
    COMPUTE_TARGET_HEADER,
    COMMAND_ID_HEADER,
    COMMAND_SIGNATURE_HEADER,
    COMMAND_SIGNATURE_PAYLOAD_HEADER,
    COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER,
    "x-relay-command-id",
    "x-relay-after-sequence",
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

function collectCommandSigningHeaders(request: NextRequest):
  | {
      commandId: BrowserSignedCommandId;
      signature: string;
      signaturePayload: string;
      publicKeyFingerprint: string;
    }
  | undefined {
  const commandId = request.headers.get(COMMAND_ID_HEADER)?.trim();
  const signature = request.headers.get(COMMAND_SIGNATURE_HEADER)?.trim();
  const signaturePayload = request.headers
    .get(COMMAND_SIGNATURE_PAYLOAD_HEADER)
    ?.trim();
  const publicKeyFingerprint = request.headers
    .get(COMMAND_PUBLIC_KEY_FINGERPRINT_HEADER)
    ?.trim();

  if (!(commandId || signature || signaturePayload || publicKeyFingerprint)) {
    return undefined;
  }
  if (!(commandId && signature && signaturePayload && publicKeyFingerprint)) {
    throw new RelayRequestError("Incomplete command signing headers", 400);
  }
  return {
    commandId: commandId as BrowserSignedCommandId,
    signature,
    signaturePayload,
    publicKeyFingerprint,
  };
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

type ParsedRelayHttpResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

function parseRelayHttpResponse(
  value: unknown
): ParsedRelayHttpResponse | null {
  if (typeof value !== "object" || value === null) {
    return {
      status: 200,
      headers: new Headers(),
      body: value,
    };
  }

  const record = value as Record<string, unknown>;

  // Electron gateway wraps results as { statusCode, success, data }
  // while the relay envelope uses { status, body }. Handle both.
  let status: number | undefined;
  if (typeof record.status === "number") {
    status = record.status;
  } else if (typeof record.statusCode === "number") {
    status = record.statusCode;
  }

  let body: unknown;
  if ("body" in record) {
    body = record.body;
  } else if ("data" in record) {
    body = record.data;
  }

  if (status !== undefined && body !== undefined) {
    return {
      status,
      headers: new Headers(
        typeof record.headers === "object" && record.headers !== null
          ? (record.headers as Record<string, string>)
          : undefined
      ),
      body,
    };
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

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    // Fallthrough: relay value lacks a proper response envelope (e.g. a bare
    // "done" event whose result event was lost in transit). Return 502 so the
    // client treats this as a transient error instead of empty success data.
    log.warn("Relay response missing envelope", {
      keys: Object.keys(record).join(","),
    });
  }
  return NextResponse.json(
    { error: "Relay response missing expected envelope" },
    { status: 502 }
  );
}

function isHealthCheckPath(path: string): boolean {
  return new URL(path, "http://local").pathname === GATEWAY_HEALTH_CHECK_PATH;
}

const healthCheckResponseSchema = z
  .object({
    checks: z.array(z.unknown()),
    allRequiredPassed: z.boolean(),
  })
  .passthrough();

async function persistHealthCheckSnapshot({
  apiOrigin,
  authToken,
  targetId,
  request,
  result,
}: {
  apiOrigin: string;
  authToken: string;
  targetId: string;
  request: NextRequest;
  result: HealthCheckResponse;
}): Promise<void> {
  const payload: UpsertComputeTargetHealthCheckSnapshotInput = {
    expectedMcpUrl: request.nextUrl.searchParams.get("expectedMcpUrl"),
    latestVersion: request.nextUrl.searchParams.get("latestVersion"),
    result,
  };
  const response = await fetch(
    `${apiOrigin}/compute-targets/${targetId}/health-check`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const errorPayload = (await response
      .json()
      .catch(() => null)) as ApiResult<unknown> | null;
    log.warn("Failed to persist relay health check snapshot", {
      computeTargetId: targetId,
      status: response.status,
      error:
        errorPayload && !errorPayload.success ? errorPayload.error : undefined,
    });
  }
}

function scheduleHealthCheckPersistence({
  apiOrigin,
  authToken,
  targetId,
  request,
  path,
  value,
}: {
  apiOrigin: string;
  authToken: string;
  targetId: string;
  request: NextRequest;
  path: string;
  value: unknown;
}): void {
  if (!isHealthCheckPath(path)) {
    return;
  }

  const parsed = parseRelayHttpResponse(value);
  if (
    !parsed ||
    parsed.status < 200 ||
    parsed.status >= 300 ||
    !healthCheckResponseSchema.safeParse(parsed.body).success
  ) {
    return;
  }
  const result = parsed.body as HealthCheckResponse;

  after(() =>
    persistHealthCheckSnapshot({
      apiOrigin,
      authToken,
      targetId,
      request,
      result,
    }).catch((error) => {
      log.warn("Failed to persist relay health check snapshot", {
        computeTargetId: targetId,
        error,
      });
    })
  );
}

type TargetOwnershipCheck = {
  id: string;
  isOnline: boolean;
  capabilities: Record<string, unknown>;
};

async function ensureTargetOwnedAndOnline(
  apiOrigin: string,
  authToken: string,
  targetId: string
): Promise<TargetOwnershipCheck> {
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
  return target;
}

async function handleRelayRequest(request: NextRequest): Promise<Response> {
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

  const apiOrigin = resolveApiOrigin(request);
  const target = await ensureTargetOwnedAndOnline(apiOrigin, token, targetId);

  const gatewayPath = toGatewayPath(request);
  const path = rewriteDesktopApiPath(
    gatewayPath,
    getDesktopApiNamespaceFromCapabilities(target.capabilities) ??
      CURRENT_DESKTOP_API_NAMESPACE
  );
  const relayRequest: RelayHttpRequestPayload = {
    method: request.method,
    path,
    headers: collectRelayHeaders(request),
    body: await encodeBody(request),
  };
  const commandSigning = collectCommandSigningHeaders(request);

  const relayClient = new RelayClient(
    apiOrigin,
    token,
    env.INTERNAL_API_SECRET
  );
  relayClient.setRefreshToken(getToken);
  const isStreaming = isStreamingGatewayRequest(
    request.method,
    path,
    request.headers.get("accept")
  );

  if (isStreaming) {
    // Reconnect support: if the client provides a commandId, resume instead
    // of creating a new command. The afterSequence tells us where to pick up.
    const reconnectCommandId = request.headers.get("x-relay-command-id");
    const afterSeqRaw = Number(request.headers.get("x-relay-after-sequence"));
    const afterSequence =
      Number.isInteger(afterSeqRaw) && afterSeqRaw >= 0 ? afterSeqRaw : 0;

    const { stream, commandId } = reconnectCommandId
      ? relayClient.resumeStream(targetId, reconnectCommandId, afterSequence)
      : await relayClient.streamOperation(
          targetId,
          relayRequest,
          commandSigning
        );

    // Body is NDJSON but we use text/event-stream so Vercel's CDN layer
    // treats this as an SSE response and skips Brotli/gzip compression
    // that would otherwise buffer the entire stream before delivery.
    // The client reads the body generically via ReadableStream.getReader()
    // and splits on newlines, so the Content-Type is irrelevant to parsing.
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Content-Encoding": "identity",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        Connection: "keep-alive",
        "X-Relay-Command-Id": commandId,
      },
    });
  }

  const { value } = await relayClient.executeOperation(
    targetId,
    relayRequest,
    commandSigning
  );
  scheduleHealthCheckPersistence({
    apiOrigin,
    authToken: token,
    targetId,
    request,
    path: gatewayPath,
    value,
  });
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

    // Generic message to avoid leaking internal details (file paths,
    // connection strings) from unexpected exceptions. Real error is logged.
    log.error("Engineer relay request failed", {
      computeTargetId: request.headers.get(COMPUTE_TARGET_HEADER),
      error,
    });
    return NextResponse.json(
      { error: "Relay request failed" },
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
