import { describe, expect, it } from "vitest";
import { PermissionTelemetrySchema } from "../permission";
import { TelemetryAttribute } from "../src/attributes";
import { permissionPayload } from "../src/test-fixtures";

describe("PermissionTelemetrySchema", () => {
  it("accepts valid permission decision and source attributes", () => {
    expect(
      PermissionTelemetrySchema.parse({
        [TelemetryAttribute.GenAiPermissionDecision]: "deny",
        [TelemetryAttribute.GenAiPermissionSource]: "user_reject",
      })
    ).toMatchObject({
      [TelemetryAttribute.GenAiPermissionDecision]: "deny",
      [TelemetryAttribute.GenAiPermissionSource]: "user_reject",
    });
  });

  it("accepts every published permission source value", () => {
    for (const source of ["config", "hook", "user_permanent", "user_reject"]) {
      expect(
        PermissionTelemetrySchema.safeParse(
          permissionPayload({
            [TelemetryAttribute.GenAiPermissionSource]: source,
          })
        ).success
      ).toBe(true);
    }
  });

  it("accepts an empty payload because every permission attribute is optional", () => {
    expect(PermissionTelemetrySchema.parse({})).toEqual({});
  });

  it("rejects invalid enums, wrong primitive types, and unknown attributes", () => {
    for (const payload of [
      permissionPayload({
        [TelemetryAttribute.GenAiPermissionDecision]: "ask",
      }),
      permissionPayload({ [TelemetryAttribute.GenAiPermissionSource]: "user" }),
      permissionPayload({ [TelemetryAttribute.GenAiPermissionDecision]: 1 }),
      permissionPayload({ [TelemetryAttribute.GenAiPermissionSource]: true }),
      permissionPayload({ "gen_ai.permission.tool": "Bash" }),
    ]) {
      expect(PermissionTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});
