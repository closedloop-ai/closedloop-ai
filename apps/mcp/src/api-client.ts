import type { JsonObject } from "@repo/api/src/types/common.js";
import { API_KEY_SCOPES_UNRESOLVABLE_CODE } from "@repo/api/src/utils/api-key-scope-resolution.js";
import { McpApiError } from "./api-error.js";
import type {
  ApiKeyVerification,
  VerifiedApiKeyContext,
} from "./api-key-contract.js";
import { ApiKeyVerificationStatus } from "./api-key-contract.js";
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
// AbortSignal.timeout only accepts an integer delay within the timer range:
// Node throws a RangeError on fractional, negative, or out-of-range values and
// silently clamps anything above 2^31-1 to 1ms. A misconfigured env value must
// therefore fall back to the default rather than make every bounded fetch throw
// before it starts.
const MAX_TIMEOUT_MS = 2_147_483_647;
function timeoutMsEnv(name: string, defaultValue: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_TIMEOUT_MS
    ? raw
    : defaultValue;
}
const VERIFY_API_KEY_TIMEOUT_MS = timeoutMsEnv(
  "MCP_VERIFY_API_KEY_TIMEOUT_MS",
  10_000
);
const API_REQUEST_TIMEOUT_MS = timeoutMsEnv(
  "MCP_API_REQUEST_TIMEOUT_MS",
  30_000
);

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

  async get<T>(
    path: string,
    query?: Record<string, string | readonly string[]>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === "string") {
          url.searchParams.set(key, value);
        } else {
          for (const item of value) {
            url.searchParams.append(key, item);
          }
        }
      }
    }
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw await getResponseError(response);
    }
    const body = (await response.json()) as unknown;
    return unwrapApiResult<T>(body);
  }
}

/**
 * Verify an API key by calling the internal verification endpoint on apps/api,
 * preserving the machine-readable refusal reason it returns.
 *
 * Version skew is one-directional and safe: an API that predates the
 * `api_key_scopes_unresolvable` code simply omits it, and the refusal reads as
 * `Invalid` - exactly the behavior before this change.
 */
export async function verifyApiKeyDetailed(
  plaintextKey: string
): Promise<ApiKeyVerification> {
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
    // 401 means the key is refused; 5xx means the server is broken
    if (response.status >= 500) {
      throw await getResponseError(response);
    }
    return { status: await readVerificationRefusal(response) };
  }
  const body = (await response.json()) as {
    success: boolean;
    data: VerifiedApiKeyContext;
  };
  return { status: ApiKeyVerificationStatus.Ok, context: body.data };
}

/**
 * Verify an API key, collapsing every refusal to `null`.
 *
 * Kept for the call sites whose answer is the same either way; anything that
 * reports a remedy to the caller uses `verifyApiKeyDetailed`.
 */
export async function verifyApiKey(
  plaintextKey: string
): Promise<VerifiedApiKeyContext | null> {
  const verification = await verifyApiKeyDetailed(plaintextKey);
  return verification.status === ApiKeyVerificationStatus.Ok
    ? verification.context
    : null;
}

/** Read the refusal reason off an error body, defaulting to a plain refusal. */
async function readVerificationRefusal(
  response: Response
): Promise<
  | typeof ApiKeyVerificationStatus.Invalid
  | typeof ApiKeyVerificationStatus.UnresolvableScopes
> {
  try {
    const body = (await response.json()) as unknown;
    const { code } = readApiErrorFields(body);
    if (code === API_KEY_SCOPES_UNRESOLVABLE_CODE) {
      return ApiKeyVerificationStatus.UnresolvableScopes;
    }
  } catch {
    // A refusal with no readable body is still a refusal.
  }
  return ApiKeyVerificationStatus.Invalid;
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
