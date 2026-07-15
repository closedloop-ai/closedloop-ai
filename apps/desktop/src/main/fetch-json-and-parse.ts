import type { z } from "zod";

/**
 * Options for {@link fetchJsonAndParse}.
 *
 * `token` is sent as `Authorization: Bearer <token>`; `headers` supplies any
 * additional request headers (e.g. `Accept: application/json`). `unwrap` is
 * applied to the decoded JSON body before schema validation — pass
 * `unwrapApiEnvelope` / `unwrapApiResultData` from {@link ./api-response-utils}
 * to peel the `{ success, data }` API envelope. `sentinel` is returned
 * unchanged for every failure mode, letting the caller pick its own
 * null-vs-undefined miss value.
 */
export type FetchJsonAndParseOptions<Sentinel> = {
  apiOrigin: string;
  token: string;
  unwrap: (body: unknown) => unknown;
  sentinel: Sentinel;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Shared fetch-JSON-and-validate scaffold for the desktop main API clients.
 *
 * This is deliberately GET-only and always sends `Authorization: Bearer
 * <token>` — it is for authenticated read endpoints that return a JSON envelope.
 * It is not a general request helper; callers needing a POST body or an
 * unauthenticated request should not use it.
 *
 * Builds `new URL(path, apiOrigin)`, issues a Bearer-authenticated GET, and
 * validates the JSON body against `schema` after `unwrap`. Every failure mode —
 * a malformed URL, a transport/timeout error, a non-2xx status, unparseable
 * JSON, or a schema mismatch — returns the caller's `sentinel` instead of
 * throwing, so callers can fall back to the values they already hold rather than
 * trusting malformed data.
 *
 * Callers that need richer failure discrimination than a single sentinel (e.g.
 * onboarding status, which surfaces a per-mode reason and the server error
 * message) keep their own implementation.
 */
export async function fetchJsonAndParse<Schema extends z.ZodTypeAny, Sentinel>(
  path: string,
  schema: Schema,
  options: FetchJsonAndParseOptions<Sentinel>
): Promise<z.infer<Schema> | Sentinel> {
  const { sentinel } = options;

  let url: URL;
  try {
    url = new URL(path, options.apiOrigin);
  } catch {
    return sentinel;
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        ...options.headers,
        Authorization: `Bearer ${options.token}`,
      },
      // `signal: undefined` is treated identically to an absent signal.
      signal:
        options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return sentinel;
  }

  if (!response.ok) {
    return sentinel;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return sentinel;
  }

  const parsed = schema.safeParse(options.unwrap(body));
  return parsed.success ? parsed.data : sentinel;
}
