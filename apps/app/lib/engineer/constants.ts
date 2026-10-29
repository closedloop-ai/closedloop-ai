export const DESKTOP_SETUP_URL =
  "https://github.com/closedloop-ai/closedloop-ai/blob/main/docs/runbook-symphony-desktop-client-llm.md";

export const VALID_PROVIDERS = new Set(["claude", "codex"]);

// SSOT: the compute-target list's freshness contract moved to `@repo/app`
// (ISS-8366) so the Settings v2 Connected Devices panel, which lives there and
// renders the same liveness badge off the same query key, reads the same
// definition these `apps/app` call sites do.
export {
  COMPUTE_TARGETS_POLL_INTERVAL_MS,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@repo/app/compute/hooks/compute-target-query-options";
