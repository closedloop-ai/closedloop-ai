/**
 * Node HTTP response helpers for the MCP server's JSON and OAuth 2.1 surfaces.
 *
 * Extracted from `index.ts` (ISS-4905) alongside the scope resolver: every
 * fail-closed refusal this change added answers through `sendOAuthJson` or
 * `redirectWithParams`, so the writers those refusals depend on belong in a
 * small module that can be read and tested on its own.
 *
 * The OAuth writers exist separately from `sendJson` for one reason: RFC 6749
 * §5.1 requires token responses to carry no-store caching headers, and putting
 * that in one helper means an OAuth endpoint cannot forget them.
 */

import type { ServerResponse } from "node:http";

/**
 * RFC 6749 §5.1 — token endpoint responses must not be cached. Applied to every
 * OAuth response, not just successful ones, so an error body carrying a reason
 * is never served from a cache.
 */
export const OAUTH_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

/** Write a JSON body with the given status and optional extra headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** `sendJson` with the OAuth no-store caching headers always applied. */
export function sendOAuthJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  sendJson(res, status, body, {
    ...OAUTH_NO_STORE_HEADERS,
    ...extraHeaders,
  });
}

/**
 * 302 back to an OAuth client's redirect URI with the given query params.
 * `undefined` values are omitted rather than serialized as the string
 * "undefined", so an absent `state` never becomes a bogus one.
 */
export function redirectWithParams(
  res: ServerResponse,
  redirectUri: string,
  params: Record<string, string | undefined>
): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

/**
 * The flat string map an OAuth token request carries, whichever encoding it
 * arrived in. Everything on the wire is a string; non-string members of a JSON
 * body are dropped rather than coerced.
 */
export type OAuthTokenBody = Record<string, string>;

export function parseFormUrlEncoded(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

export function normalizeOAuthTokenBody(input: unknown): OAuthTokenBody | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const result: OAuthTokenBody = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
