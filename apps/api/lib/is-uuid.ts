/**
 * The UUID predicate, deliberately kept in a leaf module with no imports.
 *
 * It lives here rather than in `identifier-utils.ts` because that module is
 * marked `server-only` (it reaches Postgres through `withDb`), and the desktop
 * gateway runs under `tsx` outside Next.js, where importing `server-only`
 * throws at require time. `app/api-keys/service.ts` is in the gateway's import
 * graph via `lib/desktop-gateway-socket-server.ts`, so its id guard needs the
 * predicate without the `server-only` marker; `scripts/smoke-desktop-gateway-import.ts`
 * is the check that catches a regression here.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true if the string is a valid UUID (v4/v7 format).
 * Everything that is not a UUID is treated as a slug candidate.
 */
export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/** Canonical spelling Postgres returns for a UUID regardless of input case. */
export function normalizeUuid(value: string): string {
  return value.toLowerCase();
}
