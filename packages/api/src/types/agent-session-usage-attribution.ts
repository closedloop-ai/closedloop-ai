/** Optional usage-response enrichment; omitted requests retain the full response. */
export const AgentSessionUsageAttribution = {
  Include: "include",
  Omit: "omit",
} as const;

export type AgentSessionUsageAttribution =
  (typeof AgentSessionUsageAttribution)[keyof typeof AgentSessionUsageAttribution];

export const AGENT_SESSION_USAGE_ATTRIBUTION_OPTIONS = Object.values(
  AgentSessionUsageAttribution
);
