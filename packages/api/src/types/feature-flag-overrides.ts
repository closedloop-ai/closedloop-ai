import { z } from "zod";
import { COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY } from "./compute-target";
import { DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY } from "./document-unified-comments-flag";

/**
 * ISS-12048: where the Dev Tools overlay keeps this browser's feature-flag
 * overrides, as a JSON `Record<string, boolean>` keyed by flag key. A key that
 * is absent uses the flag's real value.
 *
 * Shared here because several packages meet on it and none may import the
 * others: `@repo/app` writes it (the overlay's feature-flags section),
 * `@repo/analytics` reads it (the browser precedence), and `apps/api` and the
 * Desktop main process receive it (the request header and the IPC channel).
 */
export const FEATURE_FLAG_OVERRIDES_STORAGE_KEY =
  "closedloop:feature-flag-overrides" as const;

/**
 * ISS-12048: request header carrying the browser's overrides to `apps/api`, as
 * the same JSON record. Sent ONLY while Dev Mode is on, and a header rather
 * than a cookie so nothing sends it automatically. The API never trusts it: it
 * re-verifies Dev Mode for the signed-in user itself and ignores the header for
 * anyone else (`apps/api/lib/feature-flags/feature-flag-request-context.ts`).
 */
export const FEATURE_FLAG_OVERRIDES_HEADER =
  "X-Closedloop-Feature-Flag-Overrides" as const;

/**
 * ISS-12048: response header naming the flag keys `apps/api` checked while
 * answering, comma-separated. Returned only to a caller the API verified as in
 * Dev Mode.
 */
export const FEATURE_FLAGS_CHECKED_HEADER =
  "X-Closedloop-Feature-Flags-Checked" as const;

/**
 * ISS-12048: flags whose ENABLED state imposes a constraint (declared with
 * `defineRestrictionFlag` in `apps/api/lib/feature-flags/server-feature-flags.ts`:
 * proof-of-possession enforcement, command signing, required onboarding
 * phases, the document comment store switch). Overriding one could only weaken the system, so
 * every override path refuses them: the browser, the API and the Desktop main
 * process.
 *
 * Kept equal to the API registry's restriction entries by
 * `apps/api/lib/feature-flags/__tests__/feature-flag-request-scope.test.ts`,
 * which fails when a restriction is added there and not here.
 */
export const RESTRICTION_FEATURE_FLAG_KEYS: ReadonlySet<string> = new Set([
  "desktop-managed-pop-enforcement",
  COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY,
  DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY,
  "web-guided-onboarding-required-phases",
]);

/** Whether a flag may be overridden at all. */
export function isOverridableFeatureFlagKey(key: string): boolean {
  return !RESTRICTION_FEATURE_FLAG_KEYS.has(key);
}

/** Bounds on an override record read from storage, a header or IPC. */
export const FEATURE_FLAG_OVERRIDES_MAX_ENTRIES = 500;
const FEATURE_FLAG_OVERRIDE_KEY_MAX_LENGTH = 200;

const featureFlagOverridesSchema = z.record(
  z.string().min(1).max(FEATURE_FLAG_OVERRIDE_KEY_MAX_LENGTH),
  z.boolean()
);

/**
 * Parses an override record from an untrusted source and drops every key that
 * may not be overridden. Anything malformed, or larger than
 * {@link FEATURE_FLAG_OVERRIDES_MAX_ENTRIES}, yields no overrides at all rather
 * than a partial set. The result has no prototype, so a key such as
 * `constructor` cannot resolve through one.
 */
export function parseFeatureFlagOverrides(
  value: unknown
): Readonly<Record<string, boolean>> {
  const parsed = featureFlagOverridesSchema.safeParse(value);
  const overrides: Record<string, boolean> = Object.create(null);
  if (!parsed.success) {
    return overrides;
  }
  const entries = Object.entries(parsed.data);
  if (entries.length > FEATURE_FLAG_OVERRIDES_MAX_ENTRIES) {
    return overrides;
  }
  for (const [key, enabled] of entries) {
    if (isOverridableFeatureFlagKey(key)) {
      overrides[key] = enabled;
    }
  }
  return overrides;
}
