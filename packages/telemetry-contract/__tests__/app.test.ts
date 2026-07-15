import { describe, expect, it } from "vitest";
import { AppTelemetrySchema } from "../app";
import { AppExceptionOrigin } from "../app-exception-origin";
import { TelemetryAttribute } from "../src/attributes";
import { TelemetryTextMaxLength } from "../src/schema-primitives";
import { appPayload } from "../src/test-fixtures";

const NON_BMP_CHARACTER = String.fromCodePoint(0x1_f9_ea);

describe("AppTelemetrySchema", () => {
  it("accepts valid app identity, deployment, lifecycle, and exception attributes", () => {
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
        [TelemetryAttribute.DeploymentEnvironmentName]: "desktop-prod",
        [TelemetryAttribute.ExceptionType]: "Error",
        [TelemetryAttribute.ExceptionMessage]: "Unexpected shutdown",
        [TelemetryAttribute.ExceptionStacktrace]: "Error: Unexpected shutdown",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,
        [TelemetryAttribute.AppOperatingMode]: "multiplayer",
        [TelemetryAttribute.AppLifecycleEvent]: "shutdown",
      })
    ).toMatchObject({
      [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
      [TelemetryAttribute.AppLifecycleEvent]: "shutdown",
    });
  });

  it("accepts an empty payload because every app attribute is optional", () => {
    expect(AppTelemetrySchema.parse({})).toEqual({});
  });

  it("accepts the multiplayer organization id and bounds its length (FEA-1996)", () => {
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppOrganizationId]:
          "019c24db-a261-738f-8eff-ea275fb27470",
      })
    ).toEqual({
      [TelemetryAttribute.AppOrganizationId]:
        "019c24db-a261-738f-8eff-ea275fb27470",
    });

    // Absent in single-player: a payload without the org key parses unchanged.
    expect(
      AppTelemetrySchema.parse({
        [TelemetryAttribute.AppOperatingMode]: "single_player",
      })
    ).toEqual({
      [TelemetryAttribute.AppOperatingMode]: "single_player",
    });

    for (const invalid of [
      "", // empty
      "a".repeat(TelemetryTextMaxLength.AppOrganizationId + 1), // too long
      "org\nid", // control character
      123, // wrong primitive
    ]) {
      expect(
        AppTelemetrySchema.safeParse({
          [TelemetryAttribute.AppOrganizationId]: invalid,
        }).success
      ).toBe(false);
    }
  });

  it("accepts only the closed desktop exception origin values", () => {
    for (const origin of Object.values(AppExceptionOrigin)) {
      expect(
        AppTelemetrySchema.parse({
          [TelemetryAttribute.AppExceptionOrigin]: origin,
        })
      ).toEqual({
        [TelemetryAttribute.AppExceptionOrigin]: origin,
      });
    }
  });

  it("counts bounded app text length with Unicode code point semantics", () => {
    expect(
      AppTelemetrySchema.safeParse(
        appPayload({
          [TelemetryAttribute.ExceptionMessage]: NON_BMP_CHARACTER.repeat(
            TelemetryTextMaxLength.ExceptionMessage
          ),
        })
      ).success
    ).toBe(true);
    expect(
      AppTelemetrySchema.safeParse(
        appPayload({
          [TelemetryAttribute.ExceptionMessage]: NON_BMP_CHARACTER.repeat(
            TelemetryTextMaxLength.ExceptionMessage + 1
          ),
        })
      ).success
    ).toBe(false);
  });

  it("rejects invalid enums, wrong primitive types, control characters, excessive text, and unknown attributes", () => {
    for (const payload of [
      appPayload({ [TelemetryAttribute.AppOperatingMode]: "co_op" }),
      appPayload({ [TelemetryAttribute.AppLifecycleEvent]: "restart" }),
      appPayload({ [TelemetryAttribute.AppExceptionOrigin]: "worker" }),
      appPayload({ [TelemetryAttribute.AppExceptionOrigin]: null }),
      appPayload({ "app.exception_origin": "main" }),
      appPayload({ [TelemetryAttribute.AppInstallationId]: 123 }),
      appPayload({ [TelemetryAttribute.DeploymentEnvironmentName]: false }),
      appPayload({ [TelemetryAttribute.ExceptionType]: "Error\nType" }),
      appPayload({
        [TelemetryAttribute.ExceptionStacktrace]: "a".repeat(
          TelemetryTextMaxLength.ExceptionStacktrace + 1
        ),
      }),
      appPayload({ "app.unknown": "value" }),
    ]) {
      expect(AppTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});
