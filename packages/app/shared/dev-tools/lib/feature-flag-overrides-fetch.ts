import {
  FEATURE_FLAG_OVERRIDES_HEADER,
  FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
  FEATURE_FLAGS_CHECKED_HEADER,
  parseFeatureFlagOverrides,
} from "@repo/api/src/types/feature-flag-overrides";
import { recordServerCheckedFeatureFlags } from "./checked-feature-flags-store";

/**
 * ISS-12048: wraps the API client's fetch while Dev Mode is on. Each request
 * carries this browser's overrides in a header (restriction keys already
 * dropped), and the flags the API reports it checked are recorded for the
 * overlay. The API decides for itself whether the caller is in Dev Mode; the
 * header is never trusted as a claim.
 */
export function withFeatureFlagOverrides(doFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const page = readCurrentPagePath();
    const headers = new Headers(init?.headers);
    headers.set(FEATURE_FLAG_OVERRIDES_HEADER, readStoredOverridesJson());
    const response = await doFetch(input, { ...init, headers });
    const checked = response.headers.get(FEATURE_FLAGS_CHECKED_HEADER);
    if (checked) {
      recordServerCheckedFeatureFlags(page, checked.split(","));
    }
    return response;
  };
}

/** Web uses the pathname; Desktop's hash router owns the path after `#/`. */
function readCurrentPagePath(): string {
  const hash = globalThis.location?.hash;
  if (hash?.startsWith("#/")) {
    return hash.slice(1).split("?")[0] ?? "/";
  }
  return globalThis.location?.pathname ?? "/";
}

/** The stored overrides as the header's JSON; `{}` when there are none. */
function readStoredOverridesJson(): string {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
  } catch {
    raw = null;
  }
  let stored: unknown = null;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  return JSON.stringify(parseFeatureFlagOverrides(stored));
}
