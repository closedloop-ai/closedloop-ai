/**
 * Surface-neutral relay HTTP request model + pure transforms.
 *
 * Shared so the web `gateway-relay` route, the server-side `RelayClient`, and
 * the desktop adapter all construct identical relay payloads and parse relay
 * envelopes the same way. Framework-agnostic by contract: no Next.js, no
 * browser globals, and -- critically -- no `@repo/api`. This package is
 * published cross-repo (desktop consumes it) and therefore must not depend on
 * the workspace-only `@repo/api`. The handful of types that mirror `@repo/api`
 * shapes (`JsonValue`, `RelayHttpMethod`) are defined locally and kept
 * structurally compatible.
 */

/**
 * Structural JSON value. Mirrors `@repo/api`'s `JsonValue` (and Prisma's),
 * redefined here because shared-platform must not import the workspace-only
 * `@repo/api`. Structurally identical, so values flow between the two freely.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * HTTP methods the gateway relay accepts. Mirrors
 * `CreateDesktopCommandInput["method"]` in `@repo/api`; kept structurally in
 * sync so `toDesktopCommandInput` (web/server-side) can consume the normalized
 * value without a cast.
 */
export type RelayHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RelayEncodedBody =
  | { kind: "none" }
  | { kind: "json"; value: JsonValue }
  | { kind: "text"; value: string; contentType: string | null }
  | { kind: "base64"; value: string; contentType: string | null };

export type RelayHttpRequestPayload = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: RelayEncodedBody;
};

export type RelayResponseEnvelope = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRelayResponseEnvelope(
  value: unknown
): RelayResponseEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  // Electron gateway uses { statusCode, data }, relay envelope uses { status, body }.
  let status: number | undefined;
  if (typeof value.status === "number") {
    status = value.status;
  } else if (typeof value.statusCode === "number") {
    status = value.statusCode;
  }

  let body: unknown;
  if ("body" in value) {
    body = value.body;
  } else if ("data" in value) {
    body = value.data;
  }

  if (status === undefined || body === undefined) {
    return null;
  }

  return {
    status,
    body,
    headers:
      isRecord(value.headers) &&
      Object.values(value.headers).every((entry) => typeof entry === "string")
        ? (value.headers as Record<string, string>)
        : undefined,
  };
}

export function normalizeMethod(method: string): RelayHttpMethod {
  const normalized = method.toUpperCase();
  if (
    normalized === "GET" ||
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported relay method: ${method}`);
}

export function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  const url = new URL(pathWithQuery, "http://relay.local");
  const query = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const values = query.get(key) ?? [];
    values.push(value);
    query.set(key, values);
  }

  if (query.size === 0) {
    return { path: url.pathname };
  }

  return {
    path: url.pathname,
    query: Object.fromEntries(
      Array.from(query.entries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ])
    ),
  };
}

export function unwrapRelayBody(body: RelayEncodedBody): JsonValue | undefined {
  switch (body.kind) {
    case "none":
      return undefined;
    case "json":
      return body.value;
    case "text":
      return body.value;
    case "base64":
      return body.value;
    default:
      throw new Error("Unsupported relay body kind");
  }
}
