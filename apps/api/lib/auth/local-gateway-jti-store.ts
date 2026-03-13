import "server-only";

import { LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS } from "./local-gateway-jwt";

const JTI_TTL_MS = (LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS + 10) * 1000;

// This is only safe while apps/api runs as a single long-lived instance.
// If challenge + verify requests can hit different instances, replace this
// process-local store with a shared one before scaling out.
const jtiExpirations = new Map<string, number>();

function cleanupExpiredJtis(now = Date.now()): void {
  for (const [jti, expiresAt] of jtiExpirations) {
    if (expiresAt <= now) {
      jtiExpirations.delete(jti);
    }
  }
}

export function registerJti(jti: string): void {
  const now = Date.now();
  cleanupExpiredJtis(now);
  jtiExpirations.set(jti, now + JTI_TTL_MS);
}

export function consumeJti(jti: string): boolean {
  const now = Date.now();
  cleanupExpiredJtis(now);

  const expiresAt = jtiExpirations.get(jti);
  if (typeof expiresAt !== "number") {
    return false;
  }

  jtiExpirations.delete(jti);
  return expiresAt > now;
}

/** For tests only. */
export function resetLocalGatewayJtiStoreForTests(): void {
  jtiExpirations.clear();
}
