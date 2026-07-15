import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CompatibilityMappingField } from "../scripts/telemetry-contract-constants";
import {
  AppTelemetryAttributes,
  ClosedLoopCompatibilityAttribute,
  CodeSpanTelemetryAttributes,
  CompatibilityAttributeProducerMapping,
  CompatibilitySpanTelemetryAttributes,
  DeprecatedCodeTelemetryAttributes,
  ErrorSpanTelemetryAttributes,
  GenAiTelemetryAttributes,
  HttpSpanTelemetryAttributes,
  IpcTelemetryAttributes,
  OtelTelemetryAttributes,
  PermissionTelemetryAttributes,
  ResourceTelemetryAttributes,
  SyncTelemetryAttributes,
  TelemetryAttribute,
  TelemetryAttributeOwnership,
  TelemetryAttributeOwnershipByName,
} from "../src/attributes";

const require = createRequire(import.meta.url);
const PINNED_OTEL_ATTRIBUTE_VALUES: ReadonlySet<string> = new Set([
  ...collectStringValues(require("@opentelemetry/semantic-conventions")),
  ...collectStringValues(
    require("@opentelemetry/semantic-conventions/incubating")
  ),
]);
const EXPECTED_COMPATIBILITY_ATTRIBUTES = [
  TelemetryAttribute.AppOrganizationId,
  TelemetryAttribute.AppExceptionOrigin,
  TelemetryAttribute.AppOperatingMode,
  TelemetryAttribute.AppLifecycleEvent,
  TelemetryAttribute.DurationMs,
  TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
  TelemetryAttribute.GenAiUsageCacheReadInputTokens,
  TelemetryAttribute.SyncEvent,
  TelemetryAttribute.SyncOutcome,
  TelemetryAttribute.SyncPayloadBytes,
  TelemetryAttribute.SyncLatencyMs,
  TelemetryAttribute.GenAiCostUsage,
  TelemetryAttribute.GenAiPermissionDecision,
  TelemetryAttribute.GenAiPermissionSource,
  TelemetryAttribute.HarnessName,
  TelemetryAttribute.IpcOperation,
  TelemetryAttribute.IpcPayloadBytes,
  TelemetryAttribute.IpcResultCount,
  TelemetryAttribute.IpcSessionCount,
] as const;
const NON_EMPTY_TEXT_PATTERN = /\S/;

function isStringValue(value: unknown): value is string {
  return typeof value === "string";
}

function collectStringValues(source: object) {
  return Object.values(source).filter(isStringValue);
}

describe("OTel semantic convention compatibility", () => {
  it("maps OTel-owned attributes to pinned semconv exports", () => {
    for (const attribute of OtelTelemetryAttributes) {
      expect(PINNED_OTEL_ATTRIBUTE_VALUES.has(attribute), attribute).toBe(true);
      expect(TelemetryAttributeOwnershipByName[attribute]).toBe(
        TelemetryAttributeOwnership.Otel
      );
    }
  });

  it("keeps HTTP span attributes limited to OTel-owned attributes", () => {
    for (const attribute of HttpSpanTelemetryAttributes) {
      expect(OtelTelemetryAttributes).toContain(attribute);
      expect(TelemetryAttributeOwnershipByName[attribute]).toBe(
        TelemetryAttributeOwnership.Otel
      );
    }

    for (const attribute of CompatibilitySpanTelemetryAttributes) {
      expect(OtelTelemetryAttributes).not.toContain(attribute);
      expect(TelemetryAttributeOwnershipByName[attribute]).toBe(
        TelemetryAttributeOwnership.ClosedLoopCompatibility
      );
    }
  });

  it("keeps non-OTel handoff attributes in the explicit compatibility allowlist", () => {
    expect(new Set(Object.values(ClosedLoopCompatibilityAttribute))).toEqual(
      new Set(EXPECTED_COMPATIBILITY_ATTRIBUTES)
    );

    for (const attribute of EXPECTED_COMPATIBILITY_ATTRIBUTES) {
      expect(PINNED_OTEL_ATTRIBUTE_VALUES.has(attribute), attribute).toBe(
        false
      );
      expect(TelemetryAttributeOwnershipByName[attribute]).toBe(
        TelemetryAttributeOwnership.ClosedLoopCompatibility
      );
      expect(CompatibilityAttributeProducerMapping[attribute]).toMatchObject({
        [CompatibilityMappingField.Producer]: expect.stringMatching(
          NON_EMPTY_TEXT_PATTERN
        ),
        [CompatibilityMappingField.SourceField]: expect.stringMatching(
          NON_EMPTY_TEXT_PATTERN
        ),
        [CompatibilityMappingField.Reason]: expect.stringMatching(
          NON_EMPTY_TEXT_PATTERN
        ),
      });
    }
  });

  it("uses stable code attributes and omits deprecated aliases", () => {
    for (const attribute of Object.values(DeprecatedCodeTelemetryAttributes)) {
      expect(CodeSpanTelemetryAttributes).not.toContain(attribute);
    }
  });

  it("excludes deprecated aliases from the OTel-owned attribute set", () => {
    for (const attribute of Object.values(DeprecatedCodeTelemetryAttributes)) {
      expect(OtelTelemetryAttributes, attribute).not.toContain(attribute);
    }
  });

  it("places every OTel-owned attribute in at least one schema group", () => {
    const groupedAttributes = new Set<string>([
      ...ResourceTelemetryAttributes,
      ...AppTelemetryAttributes,
      ...HttpSpanTelemetryAttributes,
      ...CodeSpanTelemetryAttributes,
      ...ErrorSpanTelemetryAttributes,
      ...GenAiTelemetryAttributes,
      ...SyncTelemetryAttributes,
    ]);

    for (const attribute of OtelTelemetryAttributes) {
      expect(groupedAttributes.has(attribute), attribute).toBe(true);
    }
  });

  it("places every ClosedLoop-compatibility attribute in at least one schema group", () => {
    const groupedAttributes = new Set<string>([
      ...CompatibilitySpanTelemetryAttributes,
      ...AppTelemetryAttributes,
      ...GenAiTelemetryAttributes,
      ...SyncTelemetryAttributes,
      ...PermissionTelemetryAttributes,
      ...ResourceTelemetryAttributes,
      ...IpcTelemetryAttributes,
    ]);

    for (const attribute of Object.values(ClosedLoopCompatibilityAttribute)) {
      expect(groupedAttributes.has(attribute), attribute).toBe(true);
    }
  });
});
