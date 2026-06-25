import { describe, expect, it } from "vitest";
import { TelemetryAttribute } from "../src/attributes";
import { ResourceTelemetrySchema } from "../src/resource";
import { TelemetryTextMaxLength } from "../src/schema-primitives";

const NON_BMP_CHARACTER = String.fromCodePoint(0x1_f9_ea);

describe("ResourceTelemetrySchema", () => {
  it("accepts service name with optional service version and harness name", () => {
    expect(
      ResourceTelemetrySchema.parse({
        [TelemetryAttribute.ServiceName]: "cl-api",
        [TelemetryAttribute.ServiceVersion]: "1.2.3",
        [TelemetryAttribute.HarnessName]: "claude",
      })
    ).toEqual({
      [TelemetryAttribute.ServiceName]: "cl-api",
      [TelemetryAttribute.ServiceVersion]: "1.2.3",
      [TelemetryAttribute.HarnessName]: "claude",
    });
  });

  it("accepts every published harness name and rejects unknown harnesses", () => {
    for (const harness of [
      "claude",
      "codex",
      "cursor",
      "copilot",
      "opencode",
    ]) {
      expect(
        ResourceTelemetrySchema.safeParse({
          [TelemetryAttribute.ServiceName]: "cl-api",
          [TelemetryAttribute.HarnessName]: harness,
        }).success
      ).toBe(true);
    }
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: "cl-api",
        [TelemetryAttribute.HarnessName]: "gemini",
      }).success
    ).toBe(false);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: "cl-api",
        [TelemetryAttribute.HarnessName]: 7,
      }).success
    ).toBe(false);
  });

  it("counts bounded text length with Unicode code point semantics", () => {
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: NON_BMP_CHARACTER.repeat(
          TelemetryTextMaxLength.ServiceName
        ),
      }).success
    ).toBe(true);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: NON_BMP_CHARACTER.repeat(
          TelemetryTextMaxLength.ServiceName + 1
        ),
      }).success
    ).toBe(false);
  });

  it("rejects missing, invalid, excessive, and unknown resource attributes", () => {
    expect(ResourceTelemetrySchema.safeParse({}).success).toBe(false);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: 123,
      }).success
    ).toBe(false);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: "cl-api",
        [TelemetryAttribute.ServiceVersion]: false,
      }).success
    ).toBe(false);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: "cl\napi",
      }).success
    ).toBe(false);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: "a".repeat(129),
      }).success
    ).toBe(false);
    expect(
      ResourceTelemetrySchema.safeParse({
        [TelemetryAttribute.ServiceName]: "cl-api",
        "service.instance.id": "local",
      }).success
    ).toBe(false);
  });
});
