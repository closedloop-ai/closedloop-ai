/**
 * Shared Engineer routing modes across apps/app and apps/api.
 *
 * Contract source:
 * docs/artifacts/relay-integration-contracts.md
 */
export const EngineerRoutingMode = {
  LocalDev: "local-dev",
  LocalElectron: "local-electron",
  CloudRelay: "cloud-relay",
} as const;

export type EngineerRoutingMode =
  (typeof EngineerRoutingMode)[keyof typeof EngineerRoutingMode];
