"use client";

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
 * Last error from a failed exchange attempt.
 * Non-null when the exchange route returned an error (e.g. missing API key).
 * Cleared on successful exchange, session invalidation, or explicit reset.
 */
export function getLastExchangeError(): ExchangeError | null {
  return lastExchangeError;
}

function setLastExchangeError(
  exchangeError: ExchangeError | null,
  attemptId: number
): void {
  if (attemptId === latestExchangeAttemptId) {
    lastExchangeError = exchangeError;
  }
}

/**
 * Fetch a challenge from the app server, exchange it with the local gateway,
 * and return a session token. Returns null if the flow fails.
 */
async function performExchange(
  port: number,
  attemptId: number
): Promise<SessionState | null> {
  const origin = globalThis.location.origin;

  // Step 1: Obtain a challenge token from the app server
  let challengeToken: string;
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch("/api/engineer/local-gateway/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin }),
      credentials: "include",
    });
  } catch {
    setLastExchangeError(null, attemptId);
    return null;
  }

  if (!challengeResponse.ok) {
    setLastExchangeError(null, attemptId);
    return null;
  }

  try {
    const challengeData = (await challengeResponse.json()) as {
      challengeToken?: string;
      data?: { challengeToken?: string };
    };
    challengeToken =
      challengeData.challengeToken ?? challengeData.data?.challengeToken ?? "";
    if (!challengeToken) {
      setLastExchangeError(null, attemptId);
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
    let message: string;
    try {
      const errData = (await exchangeResponse.json()) as { error?: string };
      message = errData.error ?? `exchange failed (${exchangeResponse.status})`;
    } catch {
      message = `exchange failed (${exchangeResponse.status})`;
    }
    setLastExchangeError(
      { message, statusCode: exchangeResponse.status },
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
  inflightExchange = {
    port,
    attemptId,
    promise: promise.finally(() => {
      if (inflightExchange?.promise === promise) {
        inflightExchange = null;
      }
    }),
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
}
