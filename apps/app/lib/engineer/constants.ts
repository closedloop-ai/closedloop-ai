export const DESKTOP_SETUP_URL =
  "https://github.com/closedloop-ai/closedloop-ai/blob/main/docs/runbook-symphony-desktop-client-llm.md";

export const VALID_PROVIDERS = new Set(["claude", "codex"]);

export const GATEWAY_PATH_PREFIX = "/api/gateway/";
export const GATEWAY_RELAY_PATH_PREFIX = "/api/gateway-relay/";
export const GATEWAY_HEALTH_CHECK_PATH = `${GATEWAY_PATH_PREFIX}health-check`;
export const GATEWAY_RELAY_HEALTH_CHECK_PATH = `${GATEWAY_RELAY_PATH_PREFIX}health-check`;
export const COMPUTE_TARGET_HEADER = "x-compute-target";

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
