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

async function getResponseErrorMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const bodySuffix = body ? ` — ${body}` : "";
  return `API request failed: ${response.status} ${response.statusText}${bodySuffix}`;
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
    return record.data as T;
  }
  const error = record.error;
  throw new Error(typeof error === "string" ? error : "API request failed");
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
      throw new Error(await getResponseErrorMessage(response));
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
      throw new Error(await getResponseErrorMessage(response));
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
      throw new Error(await getResponseErrorMessage(response));
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
      throw new Error(await getResponseErrorMessage(response));
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
  const response = await fetch(verifyUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
    body: JSON.stringify({ key: plaintextKey }),
  });
  if (!response.ok) {
    // 401 means the key is invalid; 5xx means the server is broken
    if (response.status >= 500) {
      throw new Error(await getResponseErrorMessage(response));
    }
    return null;
  }
  const body = (await response.json()) as {
    success: boolean;
    data: VerifiedApiKeyContext;
  };
  return body.data;
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
