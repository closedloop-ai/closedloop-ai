"use client";

type SessionState = {
  token: string;
  expiresAt: number;
  port: number;
};

let cachedSession: SessionState | null = null;
let inflightExchange: Promise<SessionState | null> | null = null;
export type ExchangeError = { message: string; statusCode: number };
let lastExchangeError: ExchangeError | null = null;

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

/**
 * Fetch a challenge from the app server, exchange it with the local gateway,
 * and return a session token. Returns null if the flow fails.
 */
async function performExchange(port: number): Promise<SessionState | null> {
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
    lastExchangeError = null;
    return null;
  }

  if (!challengeResponse.ok) {
    lastExchangeError = null;
    return null;
  }

  try {
    const challengeData = (await challengeResponse.json()) as {
      challengeToken?: string;
    };
    if (!challengeData.challengeToken) {
      lastExchangeError = null;
      return null;
    }
    challengeToken = challengeData.challengeToken;
  } catch {
    lastExchangeError = null;
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
    lastExchangeError = null;
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
    lastExchangeError = { message, statusCode: exchangeResponse.status };
    return null;
  }

  try {
    const exchangeData = (await exchangeResponse.json()) as {
      sessionToken?: string;
      expiresAt?: string;
    };
    if (!(exchangeData.sessionToken && exchangeData.expiresAt)) {
      lastExchangeError = null;
      return null;
    }

    const session: SessionState = {
      token: exchangeData.sessionToken,
      expiresAt: new Date(exchangeData.expiresAt).getTime(),
      port,
    };

    cachedSession = session;
    lastExchangeError = null;
    return session;
  } catch {
    lastExchangeError = null;
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
    const result = await inflightExchange;
    return result?.token ?? null;
  }

  inflightExchange = performExchange(port).finally(() => {
    inflightExchange = null;
  });

  const result = await inflightExchange;
  return result?.token ?? null;
}

/** For tests only. */
export function resetLocalGatewaySessionForTests(): void {
  cachedSession = null;
  inflightExchange = null;
  lastExchangeError = null;
}
