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
export const GATEWAY_HEALTH_CHECK_REPAIR_PATH = `${GATEWAY_HEALTH_CHECK_PATH}/repair`;
export const GATEWAY_RELAY_HEALTH_CHECK_REPAIR_PATH = `${GATEWAY_RELAY_HEALTH_CHECK_PATH}/repair`;

/**
 * Gates the /engineer fetch routing UI (ComputeTargetSelector dropdown in
 * apps/app/components/engineer/compute-target-selector.tsx).
 * NOT related to loop dispatch — loop target resolution is handled server-side
 * by resolveComputeTarget in apps/api/lib/loops/compute-target-resolver.ts.
 */
export const CLOUD_RELAY_ENABLED: boolean = true;

const COMPUTE_TARGETS_POLL_INTERVAL_MS = 30_000;

/**
 * Stop the 30s compute-targets poll once the query is in an error state
 * (FEA-3940). A bricked/unauthenticated API (a 401/403 from this poll) must not
 * be hammered every 30 seconds while the app shows its degraded/re-auth surface;
 * an explicit `invalidateQueries` (e.g. the auth guard's Retry, or a successful
 * re-auth) resumes it. Mirrors the polling-hooks rule in apps/app/AGENTS.md.
 */
function computeTargetsRefetchInterval(query: {
  state: { status: string };
}): number | false {
  return query.state.status === "error"
    ? false
    : COMPUTE_TARGETS_POLL_INTERVAL_MS;
}

export const COMPUTE_TARGETS_QUERY_OPTIONS = {
  staleTime: COMPUTE_TARGETS_POLL_INTERVAL_MS,
  refetchInterval: computeTargetsRefetchInterval,
} as const;
