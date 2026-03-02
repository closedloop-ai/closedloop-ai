/**
 * Shared Engineer routing modes across apps/app and apps/api.
 *
 * Contract source:
 * docs/artifacts/relay-integration-contracts.md
 */
export const ENGINEER_ROUTING_MODES = [
  "local-dev",
  "local-electron",
  "cloud-relay",
] as const;

export type EngineerRoutingMode = (typeof ENGINEER_ROUTING_MODES)[number];
