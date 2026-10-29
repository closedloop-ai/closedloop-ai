import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  CompatibilityMappingField,
  RequiredCompatibilityMappingFields,
} from "../scripts/telemetry-contract-constants";
import { CompatibilityAttributeProducerMapping } from "../src/attribute-producer-mapping";
import {
  ApiSpanTelemetryAttributes,
  AppTelemetryAttributes,
  ClosedLoopCompatibilityAttribute,
  CodeSpanTelemetryAttributes,
  CompatibilitySpanTelemetryAttributes,
  DeprecatedCodeTelemetryAttributes,
  ErrorSpanTelemetryAttributes,
  GenAiTelemetryAttributes,
  HttpSpanTelemetryAttributes,
  IpcTelemetryAttributes,
  OtelTelemetryAttributes,
  PermissionTelemetryAttributes,
  ResourceTelemetryAttributes,
  RoutineAuditTelemetryAttributes,
  SyncTelemetryAttributes,
  TelemetryAttribute,
  TelemetryAttributeOwnership,
  TelemetryAttributeOwnershipByName,
} from "../src/attributes";
import { SyncPayloadShaping } from "../sync";

const require = createRequire(import.meta.url);
const PINNED_OTEL_ATTRIBUTE_VALUES: ReadonlySet<string> = new Set([
  ...collectStringValues(require("@opentelemetry/semantic-conventions")),
  ...collectStringValues(
    require("@opentelemetry/semantic-conventions/incubating")
  ),
]);
const NON_EMPTY_TEXT_PATTERN = /\S/;
const ROUTINE_AUDIT_GROUP_OWNER_TICKET = "ISS-6313";

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

  // ISS-7277: the compatibility set is DERIVED from the ownership records, not
  // restated beside them. The hand-maintained `EXPECTED_COMPATIBILITY_ATTRIBUTES`
  // pin that used to live here carried the same justifications the producer
  // inventory already states, and its failure named a Set-size delta rather than
  // the attribute — so an author who had written a complete justification still
  // had to diff two sets by hand (#5444, #5448). Every assertion below names the
  // offending attribute.
  it("justifies every compatibility attribute from its ownership record", () => {
    for (const attribute of Object.values(ClosedLoopCompatibilityAttribute)) {
      expect(
        PINNED_OTEL_ATTRIBUTE_VALUES.has(attribute),
        `${attribute} is pinned by the OTel semantic conventions, so it is not ClosedLoop-owned`
      ).toBe(false);
      expect(
        TelemetryAttributeOwnershipByName[attribute],
        `${attribute} is in the compatibility set but its ownership is not ClosedLoopCompatibility`
      ).toBe(TelemetryAttributeOwnership.ClosedLoopCompatibility);

      const mapping: Record<string, unknown> | undefined =
        CompatibilityAttributeProducerMapping[attribute];
      expect(
        mapping,
        `${attribute} has no producer/ownership record in CompatibilityAttributeProducerMapping`
      ).toBeDefined();
      for (const field of RequiredCompatibilityMappingFields) {
        const value = mapping?.[field];
        expect(
          typeof value === "string" && NON_EMPTY_TEXT_PATTERN.test(value),
          `${attribute} has no non-empty "${field}" recorded in CompatibilityAttributeProducerMapping`
        ).toBe(true);
      }
    }
  });

  // The converse direction, which the dropped pin's set equality used to supply:
  // an attribute declared ClosedLoop-owned must actually be a member of the
  // derived set, so it cannot be marked non-OTel and then skip every check above.
  it("keeps every ClosedLoop-owned attribute in the derived compatibility set", () => {
    const compatibilityAttributes = new Set<string>(
      Object.values(ClosedLoopCompatibilityAttribute)
    );

    for (const [attribute, ownership] of Object.entries(
      TelemetryAttributeOwnershipByName
    )) {
      if (ownership !== TelemetryAttributeOwnership.ClosedLoopCompatibility) {
        continue;
      }
      expect(
        compatibilityAttributes.has(attribute),
        `${attribute} is declared ClosedLoopCompatibility but is missing from ClosedLoopCompatibilityAttribute`
      ).toBe(true);
    }
  });

  // ISS-7265: the producer inventory spells `sync.payload_shaping` out as a
  // closed enum, and that enumeration is what an operator reads to learn which
  // values the attribute can carry. It drifted silently when the fifth member
  // landed, because every other assertion here only checks the reason is
  // non-empty. Walk the exported enum instead of pinning the prose, so a sixth
  // member fails here rather than in a reader's head.
  it("enumerates every SyncPayloadShaping value in the producer attestation", () => {
    const attestedReason =
      CompatibilityAttributeProducerMapping[
        TelemetryAttribute.SyncPayloadShaping
      ][CompatibilityMappingField.Reason];

    for (const value of Object.values(SyncPayloadShaping)) {
      expect(attestedReason, value).toContain(value);
    }
  });

  // ISS-6313: `duration_ms` joined the routine/audit group while its producer
  // inventory still named a single lane, so the one place a future producer
  // looks for ownership said the key belonged to someone else. That is the same
  // silent prose drift as the SyncPayloadShaping case above, and the same
  // remedy: walk the exported group rather than pin the sentence, so an
  // attribute spread into this group without an inventory update fails here
  // instead of in a reader's head.
  it("names the routine/audit group in every one of its producer attestations", () => {
    for (const attribute of RoutineAuditTelemetryAttributes) {
      const attestedProducer =
        CompatibilityAttributeProducerMapping[attribute][
          CompatibilityMappingField.Producer
        ];

      expect(attestedProducer, attribute).toContain(
        ROUTINE_AUDIT_GROUP_OWNER_TICKET
      );
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
      // ISS-8748: the api-span group was absent here only because every member
      // was compatibility-owned until `user.id` joined it. It is a schema group
      // like any other — the sibling case below has always counted it.
      ...ApiSpanTelemetryAttributes,
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
      ...ApiSpanTelemetryAttributes,
      ...CompatibilitySpanTelemetryAttributes,
      ...AppTelemetryAttributes,
      ...GenAiTelemetryAttributes,
      ...SyncTelemetryAttributes,
      ...PermissionTelemetryAttributes,
      ...ResourceTelemetryAttributes,
      ...IpcTelemetryAttributes,
      ...RoutineAuditTelemetryAttributes,
    ]);

    for (const attribute of Object.values(ClosedLoopCompatibilityAttribute)) {
      expect(groupedAttributes.has(attribute), attribute).toBe(true);
    }
  });
});
