import { log } from "@repo/observability/log";
import { isRealtimeOnlyOidcAudience } from "@repo/realtime-contract/internal";
import { getVercelOidcToken } from "@vercel/oidc";

/**
 * The transport `apps/api` shares across its internal-service clients
 * (realtime, doc-sync): the Vercel OIDC bearer, one deadline per call, the
 * config parse and the failure classification. A call never throws.
 */
export type InternalServiceConfig = {
  /** The service as `apps/api` reaches it. A path on it prefixes every call's path. */
  url: string;
  /**
   * The caller's Vercel OIDC token, minted for this audience, goes as the
   * bearer, the only credential the service accepts (ISS-11966).
   */
  oidcAudience: string;
};

/**
 * An unusable URL, or no audience, returns undefined, and a caller built on
 * that answers every call `not_configured` without a request. An audience
 * that is Vercel's default is dropped, never sent.
 */
export function parseInternalServiceConfig(env: {
  internalUrl: string | undefined;
  oidcAudience: string | undefined;
}): InternalServiceConfig | undefined {
  const url = env.internalUrl?.trim();
  const audience = env.oidcAudience?.trim();
  if (
    !(
      url &&
      URL.canParse(url) &&
      audience &&
      isRealtimeOnlyOidcAudience(audience)
    )
  ) {
    return undefined;
  }
  return { url, oidcAudience: audience };
}

export const InternalCallFailure = {
  NotConfigured: "not_configured",
  /** The call was refused before any request: a bad address, type, data or target. */
  Invalid: "invalid",
  /** The service answered, with a status the caller does not accept. */
  Rejected: "rejected",
  /** No answer: a network failure or the timeout. */
  Unreachable: "unreachable",
  /** No request: the Vercel OIDC token could not be fetched. */
  TokenUnavailable: "token_unavailable",
} as const;
export type InternalCallFailure =
  (typeof InternalCallFailure)[keyof typeof InternalCallFailure];

export type InternalCallFailed = {
  ok: false;
  failure: InternalCallFailure;
  status?: number;
  body?: unknown;
};

/** `body` is the parsed JSON when the response says it is JSON, else undefined. */
export type InternalCallResponse =
  | { ok: true; status: number; body: unknown }
  | InternalCallFailed;

export type InternalCallMethod = "GET" | "POST" | "DELETE";

export type InternalCallRequest = {
  method: InternalCallMethod;
  /** Absolute, appended to the config URL's own path. */
  path: string;
  query?: Record<string, string>;
  /** Sent as JSON; a call without one sends no body and no content-type. */
  body?: unknown;
  timeoutMs: number;
};

export type InternalCallLog = { event: string; message: string };

export type InternalServiceCallerOptions = {
  config: InternalServiceConfig | undefined;
  fetch?: typeof fetch;
  /** `failed` on every failure but `not_configured`; `notConfigured` once per caller. */
  events: { failed: InternalCallLog; notConfigured: InternalCallLog };
  /** The statuses that succeed; any 2xx when omitted. */
  accept?: (status: number) => boolean;
};

export type InternalServiceCaller = {
  call(request: InternalCallRequest): Promise<InternalCallResponse>;
  /** Logs `events.failed` for a failure the caller found itself, before or after a request. */
  fail(
    path: string,
    failure: InternalCallFailure,
    status?: number
  ): InternalCallFailed;
};

/**
 * One caller per client: the not-configured report is latched per caller, so
 * an unconfigured client logs it once rather than on every call.
 */
export function createInternalServiceCaller(
  options: InternalServiceCallerOptions
): InternalServiceCaller {
  const { config, events } = options;
  const fetchImpl = options.fetch ?? fetch;
  const accept = options.accept ?? isSuccessStatus;
  let reportedUnconfigured = false;

  const failed = (
    path: string,
    failure: InternalCallFailure,
    status?: number,
    error?: unknown,
    body?: unknown
  ): InternalCallFailed => {
    log.error(events.failed.message, {
      event: events.failed.event,
      path,
      failure,
      httpStatus: status,
      cause: error instanceof Error ? error.name : undefined,
    });
    const result: InternalCallFailed = { ok: false, failure };
    if (status !== undefined) {
      result.status = status;
    }
    if (body !== undefined) {
      result.body = body;
    }
    return result;
  };

  const call = async (
    request: InternalCallRequest
  ): Promise<InternalCallResponse> => {
    const { path } = request;
    if (config === undefined) {
      if (!reportedUnconfigured) {
        reportedUnconfigured = true;
        log.warn(events.notConfigured.message, {
          event: events.notConfigured.event,
        });
      }
      return { ok: false, failure: InternalCallFailure.NotConfigured };
    }
    const signal = AbortSignal.timeout(request.timeoutMs);
    let headers: Record<string, string>;
    try {
      headers = await requestHeaders(
        config,
        signal,
        request.body !== undefined
      );
    } catch (error) {
      return failed(
        path,
        InternalCallFailure.TokenUnavailable,
        undefined,
        error
      );
    }
    let status: number;
    let body: unknown;
    try {
      const response = await fetchImpl(
        internalUrl(config.url, path, request.query),
        {
          method: request.method,
          headers,
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
          signal,
        }
      );
      status = response.status;
      body = await readBody(response);
    } catch (error) {
      return failed(path, InternalCallFailure.Unreachable, undefined, error);
    }
    if (accept(status)) {
      return { ok: true, status, body };
    }
    return failed(path, InternalCallFailure.Rejected, status, undefined, body);
  };

  return {
    call,
    fail: (path, failure, status) => failed(path, failure, status),
  };
}

/**
 * A body that says it is JSON is parsed, and one that fails to parse reads as
 * undefined; any other body is discarded unread. Reading shares the call's
 * deadline, so a body that stalls is a timeout.
 */
async function readBody(response: Response): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    response.body?.cancel().catch(() => undefined);
    return;
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

/** `new URL(path, base)` would drop the base's own path, since `path` is absolute. */
function internalUrl(
  base: string,
  path: string,
  query: Record<string, string> | undefined
): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(TRAILING_SLASHES, "")}${path}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function isSuccessStatus(status: number): boolean {
  return status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
}

/**
 * Vercel exchanges the function's token for one with this audience and caches
 * it until it expires. The exchange shares the call's deadline, and a failed
 * one rejects: the call then goes unsent.
 */
async function requestHeaders(
  config: InternalServiceConfig,
  signal: AbortSignal,
  hasBody: boolean
): Promise<Record<string, string>> {
  const token = await untilAborted(
    getVercelOidcToken({ audience: config.oidcAudience }),
    signal
  );
  const authorization = `Bearer ${token}`;
  return hasBody
    ? { "content-type": "application/json", authorization }
    : { authorization };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

const TRAILING_SLASHES = /\/+$/;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
