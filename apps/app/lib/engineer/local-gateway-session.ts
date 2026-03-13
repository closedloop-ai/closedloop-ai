"use client";

import type { ApiResult } from "@repo/api/src/types/common";
import { resolveApiOrigin } from "@/lib/api-origin";

type SessionState = {
  token: string;
  expiresAt: number;
  port: number;
};

type InflightExchange = {
  port: number;
  attemptId: number;
  promise: Promise<SessionState | null>;
};

let cachedSession: SessionState | null = null;
let inflightExchange: InflightExchange | null = null;
export type ExchangeError = { message: string; statusCode: number };
let lastExchangeError: ExchangeError | null = null;
let latestExchangeAttemptId = 0;
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
  inflightExchange = null;
  latestExchangeAttemptId += 1;
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

function setLastExchangeError(
  exchangeError: ExchangeError | null,
  attemptId: number
): void {
  if (attemptId === latestExchangeAttemptId) {
    lastExchangeError = exchangeError;
  }
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
 * and return a session token. Returns null if the flow fails.
 */
async function performExchange(
  port: number,
  attemptId: number
): Promise<SessionState | null> {
  const origin = globalThis.location.origin;
  const authToken = authTokenProvider ? await authTokenProvider() : null;

  if (!authToken) {
    setLastExchangeError(
      { message: "Unauthorized", statusCode: 401 },
      attemptId
    );
    return null;
  }

  // Step 1: Obtain a challenge token from the API server
  let challengeToken: string;
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch(
      `${resolveApiOrigin()}/compute-targets/local-auth/challenge`,
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
    setLastExchangeError(null, attemptId);
    return null;
  }

  if (!challengeResponse.ok) {
    setLastExchangeError(
      await readResponseError(
        challengeResponse,
        `challenge failed (${challengeResponse.status})`
      ),
      attemptId
    );
    return null;
  }

  try {
    const challengeData = (await challengeResponse.json()) as ApiResult<{
      challengeToken?: string;
      expiresAt?: string;
    }>;
    if (!challengeData.success) {
      setLastExchangeError(
        {
          message: challengeData.error,
          statusCode: challengeResponse.status || 502,
        },
        attemptId
      );
      return null;
    }

    challengeToken = challengeData.data.challengeToken ?? "";
    if (!challengeToken || typeof challengeData.data.expiresAt !== "string") {
      setLastExchangeError(
        {
          message: "Failed to obtain challenge token",
          statusCode: 502,
        },
        attemptId
      );
      return null;
    }
  } catch {
    setLastExchangeError(null, attemptId);
    return null;
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
    setLastExchangeError(null, attemptId);
    return null;
  }

  if (!exchangeResponse.ok) {
    setLastExchangeError(
      await readResponseError(
        exchangeResponse,
        `exchange failed (${exchangeResponse.status})`
      ),
      attemptId
    );
    return null;
  }

  try {
    const exchangeData = (await exchangeResponse.json()) as {
      sessionToken?: string;
      expiresAt?: string;
    };
    if (!(exchangeData.sessionToken && exchangeData.expiresAt)) {
      setLastExchangeError(null, attemptId);
      return null;
    }

    const session: SessionState = {
      token: exchangeData.sessionToken,
      expiresAt: new Date(exchangeData.expiresAt).getTime(),
      port,
    };

    setLastExchangeError(null, attemptId);
    return session;
  } catch {
    setLastExchangeError(null, attemptId);
    return null;
  }
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
      inflightExchange = null;
    } else {
      const { attemptId: inflightAttemptId, promise: existingPromise } =
        inflightExchange;
      const result = await existingPromise;
      if (
        result &&
        result.port === port &&
        inflightAttemptId === latestExchangeAttemptId
      ) {
        cachedSession = result;
        return result.token;
      }
      return null;
    }
  }

  const attemptId = latestExchangeAttemptId + 1;
  latestExchangeAttemptId = attemptId;
  const promise = performExchange(port, attemptId);
  const inflightPromise = promise.finally(() => {
    if (inflightExchange?.attemptId === attemptId) {
      inflightExchange = null;
    }
  });
  inflightExchange = {
    port,
    attemptId,
    promise: inflightPromise,
  };

  const result = await inflightExchange.promise;
  if (result && result.port === port && attemptId === latestExchangeAttemptId) {
    cachedSession = result;
    return result?.token ?? null;
  }
  return null;
}

/** For tests only. */
export function resetLocalGatewaySessionForTests(): void {
  cachedSession = null;
  inflightExchange = null;
  lastExchangeError = null;
  latestExchangeAttemptId = 0;
  authTokenProvider = null;
}
