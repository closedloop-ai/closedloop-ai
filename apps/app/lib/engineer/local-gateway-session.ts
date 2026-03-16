"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import { resolveApiOrigin } from "@/lib/api-origin";

type SessionState = {
  token: string;
  expiresAt: number;
  port: number;
};

type ExchangeOutcome = {
  session: SessionState | null;
  error: ExchangeError | null;
};

type InflightExchange = {
  port: number;
  cancelled: boolean;
  promise: Promise<ExchangeOutcome>;
};

let cachedSession: SessionState | null = null;
let inflightExchange: InflightExchange | null = null;
export type ExchangeError = { message: string; statusCode: number };
let lastExchangeError: ExchangeError | null = null;
let authTokenProvider: (() => Promise<string | null>) | null = null;

function isSessionValid(session: SessionState | null, port: number): boolean {
  if (!session) {
    return false;
  }
  if (session.port !== port) {
    return false;
  }
  // Expire 30 seconds early to avoid edge-case rejections
  return Date.now() < session.expiresAt - 30_000;
}

/** Clear cached session and exchange error (on 401 or port change). */
export function invalidateLocalGatewaySession(): void {
  cachedSession = null;
  if (inflightExchange) {
    inflightExchange.cancelled = true;
    inflightExchange = null;
  }
  lastExchangeError = null;
}

/**
 * Last error from a failed local gateway auth bootstrap attempt.
 * Non-null when challenge issuance or exchange returned an actionable error.
 * Cleared on successful exchange, session invalidation, or explicit reset.
 */
export function getLastExchangeError(): ExchangeError | null {
  return lastExchangeError;
}

export function setLocalGatewayAuthTokenProvider(
  provider: (() => Promise<string | null>) | null
): void {
  authTokenProvider = provider;
}

async function readResponseError(
  response: Response,
  fallbackMessage: string
): Promise<ExchangeError> {
  try {
    const data = (await response.json()) as { error?: string };
    if (typeof data.error === "string" && data.error) {
      return { message: data.error, statusCode: response.status };
    }
  } catch {
    // Ignore invalid or non-JSON bodies and use the fallback message instead.
  }

  return { message: fallbackMessage, statusCode: response.status };
}

/**
 * Fetch a challenge from the API server, exchange it with the local gateway,
 * and return the resulting session/error outcome.
 */
async function performExchange(port: number): Promise<ExchangeOutcome> {
  const origin = globalThis.location.origin;

  let apiOrigin: string;
  let authToken: string | null;
  try {
    apiOrigin = resolveApiOrigin();
    authToken = authTokenProvider ? await authTokenProvider() : null;
  } catch {
    return { session: null, error: null };
  }

  if (!authToken) {
    return {
      session: null,
      error: { message: "Unauthorized", statusCode: 401 },
    };
  }

  // Step 1: Obtain a challenge token from the API server
  let challengeToken: string;
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch(
      `${apiOrigin}/compute-targets/local-auth/challenge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ origin }),
        cache: "no-store",
      }
    );
  } catch {
    return { session: null, error: null };
  }

  if (!challengeResponse.ok) {
    return {
      session: null,
      error: await readResponseError(
        challengeResponse,
        `challenge failed (${challengeResponse.status})`
      ),
    };
  }

  try {
    const challengeData = (await challengeResponse.json()) as ApiResult<{
      challengeToken?: string;
      expiresAt?: string;
    }>;
    if (!challengeData.success) {
      return {
        session: null,
        error: {
          message: challengeData.error,
          statusCode: challengeResponse.status || 502,
        },
      };
    }

    challengeToken = challengeData.data.challengeToken ?? "";
    if (!challengeToken || typeof challengeData.data.expiresAt !== "string") {
      return {
        session: null,
        error: {
          message: "Failed to obtain challenge token",
          statusCode: 502,
        },
      };
    }
  } catch {
    return { session: null, error: null };
  }

  // Step 2: Exchange the challenge with the local gateway
  let exchangeResponse: Response;
  try {
    exchangeResponse = await fetch(
      `http://localhost:${port}/gateway-auth/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken }),
        mode: "cors",
        credentials: "omit",
      }
    );
  } catch {
    return { session: null, error: null };
  }

  if (!exchangeResponse.ok) {
    return {
      session: null,
      error: await readResponseError(
        exchangeResponse,
        `exchange failed (${exchangeResponse.status})`
      ),
    };
  }

  try {
    const exchangeData = (await exchangeResponse.json()) as {
      sessionToken?: string;
      expiresAt?: string;
    };
    if (!(exchangeData.sessionToken && exchangeData.expiresAt)) {
      return { session: null, error: null };
    }

    return {
      session: {
        token: exchangeData.sessionToken,
        expiresAt: new Date(exchangeData.expiresAt).getTime(),
        port,
      },
      error: null,
    };
  } catch {
    return { session: null, error: null };
  }
}

function applyExchangeOutcome(
  exchange: InflightExchange,
  outcome: ExchangeOutcome
): string | null {
  if (exchange.cancelled) {
    return null;
  }

  lastExchangeError = outcome.error;
  cachedSession = outcome.session;
  return outcome.session?.token ?? null;
}

/**
 * Ensure a valid local gateway session token is available.
 * Deduplicates concurrent exchange attempts.
 */
export async function ensureLocalGatewaySession(
  port: number
): Promise<string | null> {
  if (isSessionValid(cachedSession, port)) {
    return cachedSession!.token;
  }

  // Port changed — invalidate old session
  if (cachedSession && cachedSession.port !== port) {
    invalidateLocalGatewaySession();
  }

  if (inflightExchange) {
    if (inflightExchange.port !== port) {
      inflightExchange.cancelled = true;
      inflightExchange = null;
    } else {
      return applyExchangeOutcome(
        inflightExchange,
        await inflightExchange.promise
      );
    }
  }

  // Concurrent intercepted engineer requests can all need bootstrap at once,
  // so collapse them into a single challenge/exchange flow per gateway port.
  const exchange: InflightExchange = {
    port,
    cancelled: false,
    promise: performExchange(port),
  };
  exchange.promise = exchange.promise.finally(() => {
    if (inflightExchange === exchange) {
      inflightExchange = null;
    }
  });
  inflightExchange = exchange;

  return applyExchangeOutcome(exchange, await exchange.promise);
}

/** For tests only. */
export function resetLocalGatewaySessionForTests(): void {
  cachedSession = null;
  inflightExchange = null;
  lastExchangeError = null;
  authTokenProvider = null;
}
