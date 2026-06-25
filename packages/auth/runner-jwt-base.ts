/**
 * Shared plumbing for runner JWT helpers (loop runner + chat runner).
 * Both runner flavors sign HS256 tokens with the same secret env var but
 * differ in audience, subject semantics, and custom claims — so only the
 * secret validation is factored out here.
 */

export const MIN_SECRET_LENGTH = 32;
export const MIN_UNIQUE_SECRET_CHARS = 8;
export const RUNNER_JWT_SECRET_ENV = "CLOSEDLOOP_RUNNER_JWT_SECRET";

/**
 * Load and validate a runner JWT secret from the environment. Throws when
 * the env var is unset, too short, or has insufficient character diversity.
 */
export function getRunnerSecret(envVar: string): Uint8Array {
  const secret = process.env[envVar];
  if (!secret) {
    throw new Error(`${envVar} is not configured`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${envVar} must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  if (new Set(secret).size < MIN_UNIQUE_SECRET_CHARS) {
    throw new Error(`${envVar} is too weak (not enough character diversity)`);
  }
  return new TextEncoder().encode(secret);
}

/**
 * Startup precondition: assert that a runner JWT secret is configured and
 * meets validation rules. Intended to be called once from a Next.js
 * `instrumentation.ts` `register()` hook so misconfiguration fails the
 * server boot rather than the first token issue at request time.
 */
export function assertRunnerSecretConfigured(envVar: string): void {
  getRunnerSecret(envVar);
}
