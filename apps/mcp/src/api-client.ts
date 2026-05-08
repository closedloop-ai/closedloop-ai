import type { JsonObject } from "@repo/api/src/types/common.js";
import { McpApiError } from "./api-error.js";
import type { VerifiedApiKeyContext } from "./api-key-contract.js";
import { asRecord } from "./tools/tool-utils.js";

const CLOSEDLOOP_API_URL =
  process.env.CLOSEDLOOP_API_URL ?? "http://localhost:3002";
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required but not set`);
  }
  return value;
}

const INTERNAL_API_SECRET = requireEnv("INTERNAL_API_SECRET");
const VERIFY_API_KEY_TIMEOUT_MS = (() => {
  const v = Number(process.env.MCP_VERIFY_API_KEY_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
})();

async function getResponseError(response: Response): Promise<McpApiError> {
  const body = await response.text().catch(() => "");
  const parsedBody = parseJson(body);
  const parsed = readApiErrorFields(parsedBody);
  const bodySuffix = body && !parsed.message ? ` — ${body}` : "";
  return new McpApiError(
    parsed.message ??
      `API request failed: ${response.status} ${response.statusText}${bodySuffix}`,
    {
      code: parsed.code,
      details: parsed.details,
      status: response.status,
      timestamp: parsed.timestamp,
    }
  );
}

/**
 * apps/api returns ApiResult<T> for route responses.
 * Unwrap success envelopes so tools receive the expected payload shape.
 */
function unwrapApiResult<T>(body: unknown): T {
  const record = asRecord(body);
  const success = record.success;
  if (typeof success !== "boolean") {
    return body as T;
  }
  if (success) {
    if (record.data === undefined) {
      throw new Error("API returned success without data");
    }
    return record.data as T;
  }
  const error = record.error;
  const parsed = readApiErrorFields(body);
  if (typeof error === "string") {
    throw new McpApiError(error, {
      code: parsed.code,
      details: parsed.details,
      timestamp: parsed.timestamp,
    });
  }
  const errorRecord = asRecord(error);
  const message = errorRecord.message;
  if (typeof message === "string" && message.length > 0) {
    throw new McpApiError(message, {
      code: parsed.code,
      details: parsed.details,
      timestamp: parsed.timestamp,
    });
  }
  let msg = "API request failed";
  if (typeof error !== "undefined") {
    try {
      msg = JSON.stringify(error);
    } catch {
      /* keep default */
    }
  }
  throw new McpApiError(msg, {
    code: parsed.code,
    details: parsed.details,
    timestamp: parsed.timestamp,
  });
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly plaintextKey: string;

  constructor(
    baseUrl: string,
    _context: VerifiedApiKeyContext,
    plaintextKey: string
  ) {
    this.baseUrl = baseUrl;
    this.plaintextKey = plaintextKey;
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.plaintextKey}`,
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    };
  }

  async get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw await getResponseError(response);
    }
    const body = (await response.json()) as unknown;
    return unwrapApiResult<T>(body);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await getResponseError(response);
    }
    const responseBody = (await response.json()) as unknown;
    return unwrapApiResult<T>(responseBody);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await getResponseError(response);
    }
    const responseBody = (await response.json()) as unknown;
    return unwrapApiResult<T>(responseBody);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await getResponseError(response);
    }
    const responseBody = (await response.json()) as unknown;
    return unwrapApiResult<T>(responseBody);
  }

  async delete<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw await getResponseError(response);
    }
    const body = (await response.json()) as unknown;
    return unwrapApiResult<T>(body);
  }
}

/**
 * Verify an API key by calling the internal verification endpoint on apps/api.
 * Returns a VerifiedApiKeyContext on success, or null if the key is invalid.
 */
export async function verifyApiKey(
  plaintextKey: string
): Promise<VerifiedApiKeyContext | null> {
  const verifyUrl = new URL("/internal/api-keys/verify", CLOSEDLOOP_API_URL);
  let response: Response;
  try {
    response = await fetch(verifyUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ key: plaintextKey }),
      signal: AbortSignal.timeout(VERIFY_API_KEY_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown verification error";
    throw new Error(`API key verification request failed: ${reason}`);
  }
  if (!response.ok) {
    // 401 means the key is invalid; 5xx means the server is broken
    if (response.status >= 500) {
      throw await getResponseError(response);
    }
    return null;
  }
  const body = (await response.json()) as {
    success: boolean;
    data: VerifiedApiKeyContext;
  };
  return body.data;
}

function readApiErrorFields(body: unknown): {
  code?: string;
  details?: JsonObject;
  message?: string;
  timestamp?: string;
} {
  const record = asRecord(body);
  const errorRecord = asRecord(record.error);
  const message =
    readString(record.error) ?? readString(errorRecord.message) ?? undefined;
  const code =
    readString(record.code) ?? readString(errorRecord.code) ?? undefined;
  const details =
    readJsonObject(record.details) ?? readJsonObject(errorRecord.details);
  const timestamp =
    readString(record.timestamp) ??
    readString(errorRecord.timestamp) ??
    undefined;
  return {
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
    ...(message ? { message } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function parseJson(value: string): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readJsonObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

/**
 * Create an ApiClient instance bound to the given context.
 */
export function createApiClient(
  context: VerifiedApiKeyContext,
  plaintextKey: string
): ApiClient {
  return new ApiClient(CLOSEDLOOP_API_URL, context, plaintextKey);
}

/**
 * Check whether the upstream API server is reachable.
 * Any HTTP response (even 404) means it's alive; only connection errors mean it's down.
 */
export async function checkApiReachable(): Promise<boolean> {
  try {
    const url = new URL("/", CLOSEDLOOP_API_URL);
    await fetch(url.toString(), {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch {
    return false;
  }
}
