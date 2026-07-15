import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest used to store bearer-style secrets at rest — API keys,
 * desktop refresh tokens, and device-session secrets. Strings are hashed as
 * UTF-8 (Node's default for string input), so this matches the historical
 * api-keys and device-onboarding hashing byte-for-byte.
 *
 * Intentionally NOT `import "server-only"`: this pure (secret-free) hash is
 * reached from `apiKeysService`, which the desktop gateway socket server loads
 * under `tsx` outside Next. `server-only` would throw there (see
 * scripts/smoke-desktop-gateway-import.ts).
 */
export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
