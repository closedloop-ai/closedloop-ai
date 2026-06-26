import path from "node:path";

/**
 * `@repo/shared-platform` subpath aliases shared by `vitest.config.mts` and
 * `vitest.config.compatibility.mts`.
 *
 * The package's `exports` resolve to `dist/`, but the catch-all `@repo` alias
 * maps to the `packages/` filesystem directory (bypassing package.json). Point
 * each subpath at source so vitest resolves without a build. Spread these
 * entries BEFORE the catch-all `@repo` alias so Vite matches the more-specific
 * keys first (object aliases are checked in insertion order). Keeping the list
 * here is the single edit point when a new subpath export is added.
 */
const sharedPlatformSrc = path.resolve(
  import.meta.dirname,
  "../../packages/shared-platform/src"
);

export const sharedPlatformAliases: Record<string, string> = {
  "@repo/shared-platform/detection-store": path.join(
    sharedPlatformSrc,
    "detection-store.ts"
  ),
  "@repo/shared-platform/routing-store": path.join(
    sharedPlatformSrc,
    "routing-store.ts"
  ),
  "@repo/shared-platform/gateway-probe": path.join(
    sharedPlatformSrc,
    "gateway-probe.ts"
  ),
  "@repo/shared-platform/storage": path.join(sharedPlatformSrc, "storage.ts"),
  "@repo/shared-platform/types": path.join(sharedPlatformSrc, "types.ts"),
  "@repo/shared-platform/relay-request-model": path.join(
    sharedPlatformSrc,
    "relay-request-model.ts"
  ),
  "@repo/shared-platform/gateway-dispatch": path.join(
    sharedPlatformSrc,
    "gateway-dispatch.ts"
  ),
  "@repo/shared-platform/gateway-fetch-shim": path.join(
    sharedPlatformSrc,
    "gateway-fetch-shim.ts"
  ),
  "@repo/shared-platform/gateway-constants": path.join(
    sharedPlatformSrc,
    "gateway-constants.ts"
  ),
};
