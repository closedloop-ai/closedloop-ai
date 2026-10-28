import { env } from "@/env";

const LOCAL_API_FALLBACK = "http://localhost:3002";
const APP_PREFIX_REGEX = /^app-/;

function rewritePreviewHostname(hostname: string): string | null {
  if (hostname.includes(".preview.") && hostname.startsWith("app-")) {
    return hostname.replace(APP_PREFIX_REGEX, "api-");
  }

  if (hostname.includes(".vercel.app") && hostname.startsWith("app-")) {
    return hostname.replace(APP_PREFIX_REGEX, "api-");
  }

  return null;
}

type ApiOriginRequest = {
  nextUrl?: Pick<URL, "hostname" | "protocol">;
  url?: string;
};

export function resolveApiOrigin(request?: ApiOriginRequest): string {
  if (request) {
    const nextUrl = request.nextUrl ?? getRequestUrl(request);
    const rewrittenHostname = nextUrl
      ? rewritePreviewHostname(nextUrl.hostname)
      : null;
    if (nextUrl && rewrittenHostname) {
      return `${nextUrl.protocol}//${rewrittenHostname}`;
    }
  }

  if (globalThis.window !== undefined) {
    const rewrittenHostname = rewritePreviewHostname(
      globalThis.window.location.hostname
    );
    if (rewrittenHostname) {
      return `${globalThis.window.location.protocol}//${rewrittenHostname}`;
    }
  }

  if (globalThis.window === undefined && env.SERVER_API_URL) {
    return env.SERVER_API_URL;
  }

  return resolveBrowserApiOrigin() ?? LOCAL_API_FALLBACK;
}

function getRequestUrl(request: ApiOriginRequest): URL | null {
  if (!request.url) {
    return null;
  }

  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

/**
 * The stable, per-branch preview alias Vercel mints alongside the
 * per-deployment one (`app-stage-git-main.preview.…`). Its API twin exists,
 * because both projects alias the same branch; a deployment hash has no twin.
 */
const STABLE_BRANCH_ALIAS_MARKER = "-git-";

/**
 * True when {@link resolveApiOrigin} would derive an API host that nothing
 * serves, so every client-side read from this page is CORS-blocked (ISS-9797).
 *
 * The rewrite above swaps `app-` for `api-` on the host the browser is already
 * on. That only resolves for the `-git-` branch alias: app and api deployment
 * hashes differ, so `app-stage-<hash>` derives an `api-stage-<hash>` no api
 * deployment owns, and Vercel's wildcard hands it back to the app project,
 * which answers HTML with no `Access-Control-Allow-Origin`.
 * `e2e/helpers/api-url.ts` states the same rule for the test harness and
 * refuses to derive from a deployment-hash URL for exactly this reason.
 *
 * Read from the host rather than from a failed fetch, so the shell states what
 * the address is instead of guessing why the data is missing.
 */
export function isUnreachableApiPreviewHost(host: string): boolean {
  const hostname = hostnameOf(host);
  return (
    rewritePreviewHostname(hostname) !== null &&
    !hostname.includes(STABLE_BRANCH_ALIAS_MARKER)
  );
}

/**
 * The hostname of a `Host` header value or of a URL's `host` — the port
 * dropped, so the two spellings of one address compare equal.
 *
 * They do not on their own: a request can carry `…:443` while `new URL(…).host`
 * omits a default port, and comparing those raw let the notice offer an "Open"
 * link back to the address the reader was already on (davetho PR review).
 * Any caller comparing two hosts normalizes BOTH through this.
 */
export function hostnameOf(host: string): string {
  return host.split(":")[0];
}

/**
 * The configured public API origin — the one a BROWSER can open a socket to —
 * or null when only the local dev fallback is set.
 *
 * Deliberately env-only, unlike {@link resolveApiOrigin}: that one derives a
 * preview host from the address the caller is on, which is right for a request
 * it is already serving but wrong for a hint rendered into a document, where
 * the derived `api-` twin may not exist ({@link isUnreachableApiPreviewHost})
 * and the `Host` header is attacker-controlled. Whether a document hints this
 * origin at all is {@link resolvePreconnectApiOrigin}'s call.
 */
export function resolveBrowserApiOrigin(): string | null {
  const configured = env.NEXT_PUBLIC_API_URL;
  if (configured && configured !== LOCAL_API_FALLBACK) {
    return configured;
  }
  return null;
}

/**
 * The origin a document served on `host` preconnects to, or null for no hint.
 *
 * Null on a preview host, even one built with a configured public origin: its
 * browser reads go to the `api-` twin {@link resolveApiOrigin} derives from the
 * browser's own address, so a hint naming the configured origin warms a socket
 * no read uses (whitlockk PR review). `host` only decides WHETHER to hint and never
 * reaches the hint, because the `Host` header is caller-controlled.
 */
export function resolvePreconnectApiOrigin(host: string | null): string | null {
  if (host !== null && rewritePreviewHostname(hostnameOf(host)) !== null) {
    return null;
  }
  return resolveBrowserApiOrigin();
}
