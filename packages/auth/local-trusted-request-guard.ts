/**
 * ISS-12054: which requests the `AUTH_MODE=local_trusted` middleware path will
 * serve. That path makes EVERY request the synthetic org admin with no
 * credential at all, so it must only answer the machine it runs on:
 *
 *   - Host: only a loopback name, so another machine on the network, or a page
 *     that rebinds its own DNS name to 127.0.0.1, is refused.
 *   - Origin: a state-changing request a browser sends with a foreign Origin is
 *     refused, because a simple cross-origin POST (`text/plain`, a form) skips
 *     the CORS preflight and would otherwise act as the admin. A request that
 *     carries `Authorization` is exempt: a cross-origin page cannot set that
 *     header without passing a preflight first.
 *
 * `E2E_LOCAL_TRUSTED_ALLOWED_HOSTS` (comma-separated host names) adds names for
 * a harness whose services reach each other by name, such as `e2e/compose.yml`,
 * where `app-visual` renders against `http://api-local:3004`.
 */

export const E2E_LOCAL_TRUSTED_ALLOWED_HOSTS_ENV =
  "E2E_LOCAL_TRUSTED_ALLOWED_HOSTS";

export const LocalTrustedRefusal = {
  Host: "host",
  Origin: "origin",
} as const;

export type LocalTrustedRefusal =
  (typeof LocalTrustedRefusal)[keyof typeof LocalTrustedRefusal];

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Why the request is refused, or `null` when the local-trusted path may serve it. */
export function localTrustedRequestRefusal(
  request: { method: string; headers: Headers },
  env: NodeJS.ProcessEnv = process.env
): LocalTrustedRefusal | null {
  const allowed = allowedHostnames(env);
  const host = request.headers.get("host");
  if (!(host && isAllowedHostname(hostnameOf(`http://${host}`), allowed))) {
    return LocalTrustedRefusal.Host;
  }
  if (
    SAFE_METHODS.has(request.method.toUpperCase()) ||
    request.headers.has("authorization")
  ) {
    return null;
  }
  const origin = request.headers.get("origin");
  if (origin === null) {
    return null;
  }
  return isAllowedOrigin(origin, allowed) ? null : LocalTrustedRefusal.Origin;
}

function allowedHostnames(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const extra = (env[E2E_LOCAL_TRUSTED_ALLOWED_HOSTS_ENV] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  return new Set([...LOOPBACK_HOSTNAMES, ...extra]);
}

function isAllowedOrigin(
  origin: string,
  allowed: ReadonlySet<string>
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (
    WEB_PROTOCOLS.has(parsed.protocol) &&
    isAllowedHostname(parsed.hostname, allowed)
  );
}

function isAllowedHostname(
  hostname: string | null,
  allowed: ReadonlySet<string>
): boolean {
  return hostname !== null && allowed.has(hostname.toLowerCase());
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
