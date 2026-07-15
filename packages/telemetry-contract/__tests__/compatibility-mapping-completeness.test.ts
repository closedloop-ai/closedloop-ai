import { describe, expect, it } from "vitest";
import { RequiredCompatibilityMappingFields } from "../scripts/telemetry-contract-constants";
import { CompatibilityAttributeProducerMapping } from "../src/attributes";

/**
 * Re-homed from the deleted `check-schema-update-gates` AST parser: every
 * ClosedLoop compatibility attribute must declare a complete producer mapping
 * (producer / sourceField / reason). Enforced here against the runtime object
 * — no source parsing, no PR-diff gate.
 */
describe("CompatibilityAttributeProducerMapping", () => {
  it("declares every required field for each compatibility attribute", () => {
    for (const [attribute, mapping] of Object.entries(
      CompatibilityAttributeProducerMapping
    )) {
      const fields = mapping as Record<string, unknown>;
      for (const field of RequiredCompatibilityMappingFields) {
        const value = fields[field];
        const present = typeof value === "string" && value.trim().length > 0;
        expect(
          present,
          `compatibility attribute "${attribute}" is missing a non-empty "${field}"`
        ).toBe(true);
      }
    }
  });
});
