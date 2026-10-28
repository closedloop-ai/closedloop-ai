/**
 * Shared origin fixtures for suites that exercise a route's trusted-origin
 * guard against the real `canonicalizeTrustedOrigin`.
 *
 * Those suites must not stub `@/lib/auth/canonical-trusted-origin`. A stub that
 * accepts any `https://` input makes the "origin is not on the allowlist" half
 * of every origin guard unreachable, so the guard can be deleted outright with
 * the suites still green (ISS-6742).
 *
 * `trusted-origins.ts` resolves the allowlist from `process.env` on every call,
 * so stubbing the environment per test is enough to pin which origins are
 * trusted. `trusted-origin.test-helpers.test.ts` asserts that premise.
 */
import { vi } from "vitest";

/** Allowlisted through `NEXT_PUBLIC_APP_URL` once `stubTrustedOriginEnv` runs. */
export const TRUSTED_APP_ORIGIN = "https://app.closedloop.ai";

/**
 * A second allowlisted origin, so a fixture can mismatch two origins while both
 * remain trusted — isolating the mismatch branch from the allowlist branch.
 */
export const TRUSTED_WEB_ORIGIN = "https://www.closedloop.ai";

/**
 * Well-formed, bare, `https://`, and matched by no allowlist branch: not a
 * configured origin, not loopback, not under the preview suffix. This is the
 * attacker-supplied origin every allowlist guard must reject.
 */
export const UNTRUSTED_ORIGIN = "https://evil.example.com";

/**
 * Preview suffix pinned so a stray deployment variable cannot widen the
 * allowlist under a test. Not exported: no fixture needs a preview origin, and
 * `lib/__tests__/trusted-origins.test.ts` already owns that branch's coverage.
 */
const PREVIEW_ORIGIN_SUFFIX = "preview.stage.example";

/**
 * Pins the allowlist so `TRUSTED_*_ORIGIN` are trusted and `UNTRUSTED_ORIGIN`
 * is not, regardless of the `.env.local` the suite happens to load. Callers
 * restore with `vi.unstubAllEnvs()`.
 */
export function stubTrustedOriginEnv() {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", TRUSTED_APP_ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_WEB_URL", TRUSTED_WEB_ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_PREVIEW_DOMAIN", PREVIEW_ORIGIN_SUFFIX);
}
