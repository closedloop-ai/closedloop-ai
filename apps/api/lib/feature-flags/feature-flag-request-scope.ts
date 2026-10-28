import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ISS-12048: what one request carries for server flag reads while its caller
 * is in Dev Mode: the caller's distinct id, the overrides it sent (applied only
 * once the API has verified Dev Mode for that caller itself), and the keys this
 * request checked, returned to the overlay in a response header.
 *
 * Exists only for a request that sent the overrides header, so every other
 * request reads flags exactly as before and records nothing.
 *
 * The AsyncLocalStorage lives on a `Symbol.for` slot, not a module binding, for
 * the reason `request-span-attribution.ts` documents: a bundler can give a route
 * and this module separate copies, and a module-local store would then be
 * written in one and read in the other.
 */
export type FeatureFlagRequestScope = {
  /** The caller's PostHog distinct id; overrides apply to reads for it only. */
  readonly distinctId: string;
  /**
   * The verified overrides, or `null` when the caller is not in Dev Mode by the
   * API's own check. Lazy and memoized: the first read that needs it pays the
   * verification, every later one shares it.
   */
  readonly overrides: () => Promise<Readonly<Record<string, boolean>> | null>;
  /** Keys checked during this request, in first-checked order. */
  readonly checkedKeys: Set<string>;
};

export function runWithFeatureFlagRequestScope<T>(
  scope: FeatureFlagRequestScope,
  handler: () => Promise<T>
): Promise<T> {
  return storage().run(scope, handler);
}

export function currentFeatureFlagRequestScope():
  | FeatureFlagRequestScope
  | undefined {
  return storage().getStore();
}

/** Bounded so a pathological request cannot grow the set without limit. */
const MAX_CHECKED_KEYS = 500;

export function recordCheckedServerFeatureFlag(key: string): void {
  const checked = currentFeatureFlagRequestScope()?.checkedKeys;
  if (checked && checked.size < MAX_CHECKED_KEYS) {
    checked.add(key);
  }
}

const FEATURE_FLAG_REQUEST_SCOPE_STORAGE = Symbol.for(
  "closedloop.api.featureFlagRequestScopeStorage"
);

type ScopeGlobal = typeof globalThis & {
  [FEATURE_FLAG_REQUEST_SCOPE_STORAGE]?: AsyncLocalStorage<FeatureFlagRequestScope>;
};

function storage(): AsyncLocalStorage<FeatureFlagRequestScope> {
  const slot = globalThis as ScopeGlobal;
  slot[FEATURE_FLAG_REQUEST_SCOPE_STORAGE] ??= new AsyncLocalStorage();
  return slot[FEATURE_FLAG_REQUEST_SCOPE_STORAGE];
}
