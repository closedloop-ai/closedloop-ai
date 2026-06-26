// SSOT: the gateway path prefix lives in the lightweight (zero-import)
// `@repo/shared-platform/gateway-constants` so the shim and this file (which is
// imported by both the gateway-relay server route and "use client" components)
// share one definition without dragging the dispatch router into those bundles.
import { GATEWAY_PATH_PREFIX } from "@repo/shared-platform/gateway-constants";

export const DESKTOP_SETUP_URL =
  "https://github.com/closedloop-ai/symphony-alpha/blob/main/docs/runbook-symphony-desktop-client-llm.md";

export const VALID_PROVIDERS = new Set(["claude", "codex"]);

export { GATEWAY_PATH_PREFIX } from "@repo/shared-platform/gateway-constants";
export const GATEWAY_RELAY_PATH_PREFIX = "/api/gateway-relay/";
export const GATEWAY_HEALTH_CHECK_PATH = `${GATEWAY_PATH_PREFIX}health-check`;
export const GATEWAY_RELAY_HEALTH_CHECK_PATH = `${GATEWAY_RELAY_PATH_PREFIX}health-check`;

/**
 * Gates the /engineer fetch routing UI (ComputeTargetSelector dropdown in
 * apps/app/components/engineer/compute-target-selector.tsx).
 * NOT related to loop dispatch — loop target resolution is handled server-side
 * by resolveComputeTarget in apps/api/lib/loops/compute-target-resolver.ts.
 */
export const CLOUD_RELAY_ENABLED: boolean = true;

export const COMPUTE_TARGETS_QUERY_OPTIONS = {
  staleTime: 30_000,
  refetchInterval: 30_000,
} as const;
