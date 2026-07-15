/**
 * Shared, dependency-free constants for the telemetry-contract codegen and
 * verification scripts (collector allow-list, PostHog routing, tail-sampling)
 * and their tests. Extracted from the former `check-schema-update-gates.ts`
 * so the collector drift checks and package tests no longer depend on the
 * deleted PR schema-gate / trusted-preflight apparatus.
 *
 * Package-internal: these are consumed only by this package's own `scripts/`
 * and `__tests__/`. Not part of the package's published surface (`exports`) —
 * external consumers should not import from here.
 */

export const TelemetryContractPath = {
  PackageRoot: "packages/telemetry-contract",
  PackageManifest: "packages/telemetry-contract/package.json",
  AttributesSource: "packages/telemetry-contract/src/attributes.ts",
  JsonSchemaParity: "packages/telemetry-contract/scripts/check-json-schemas.ts",
  CollectorAllowlistManifest:
    "packages/telemetry-contract/collector/allowed-attributes.json",
  CollectorRedactionFragment:
    "packages/telemetry-contract/collector/keyless-telemetry-redaction.yaml",
  CollectorPosthogRoutingManifest:
    "packages/telemetry-contract/collector/posthog-product-signals.json",
  CollectorPosthogRoutingFragment:
    "packages/telemetry-contract/collector/keyless-telemetry-posthog-routing.yaml",
  CollectorPosthogIdentityManifest:
    "packages/telemetry-contract/collector/posthog-identity-transform.json",
  CollectorPosthogIdentityFragment:
    "packages/telemetry-contract/collector/keyless-telemetry-posthog-identity.yaml",
  CollectorPosthogRoutingGenerator:
    "packages/telemetry-contract/scripts/generate-collector-posthog-routing.ts",
} as const;
export type TelemetryContractPath =
  (typeof TelemetryContractPath)[keyof typeof TelemetryContractPath];

export const CompatibilityMappingField = {
  Producer: "producer",
  SourceField: "sourceField",
  Reason: "reason",
} as const;
export type CompatibilityMappingField =
  (typeof CompatibilityMappingField)[keyof typeof CompatibilityMappingField];

export const RequiredCompatibilityMappingFields = [
  CompatibilityMappingField.Producer,
  CompatibilityMappingField.SourceField,
  CompatibilityMappingField.Reason,
] as const satisfies readonly CompatibilityMappingField[];
