export const DESKTOP_SETUP_URL =
  "https://github.com/closedloop-ai/symphony-alpha/blob/main/docs/runbook-symphony-desktop-client-llm.md";

export const VALID_PROVIDERS = new Set(["claude", "codex"]);

export const CLOUD_RELAY_ENABLED: boolean = true;

export const COMPUTE_TARGETS_QUERY_OPTIONS = {
  staleTime: 30_000,
  refetchInterval: 30_000,
} as const;
