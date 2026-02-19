import type { VerifiedApiKeyContext } from "@repo/api/src/types/api-key";

const SYMPHONY_API_URL =
  process.env.SYMPHONY_API_URL ?? "http://localhost:3002";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET ?? "";

export class ApiClient {
  private readonly baseUrl: string;
  private readonly context: VerifiedApiKeyContext;
  private readonly plaintextKey: string;

  constructor(
    baseUrl: string,
    context: VerifiedApiKeyContext,
    plaintextKey: string
  ) {
    this.baseUrl = baseUrl;
    this.context = context;
    this.plaintextKey = plaintextKey;
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.plaintextKey}`,
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
      "X-User-Id": this.context.userId,
      "X-Organization-Id": this.context.organizationId,
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
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}`
      );
    }
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}`
      );
    }
    return response.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}`
      );
    }
    return response.json() as Promise<T>;
  }
}

/**
 * Verify an API key by calling the internal verification endpoint on apps/api.
 * Returns a VerifiedApiKeyContext on success, or null if the key is invalid.
 */
export async function verifyApiKey(
  plaintextKey: string
): Promise<VerifiedApiKeyContext | null> {
  const verifyUrl = new URL("/internal/api-keys/verify", SYMPHONY_API_URL);
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
      throw new Error(
        `API key verification failed: ${response.status} ${response.statusText}`
      );
    }
    return null;
  }
  return response.json() as Promise<VerifiedApiKeyContext>;
}

/**
 * Create an ApiClient instance bound to the given context.
 */
export function createApiClient(
  context: VerifiedApiKeyContext,
  plaintextKey: string
): ApiClient {
  return new ApiClient(SYMPHONY_API_URL, context, plaintextKey);
}
