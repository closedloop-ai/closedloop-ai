import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type BranchRow,
  BranchTagAvailability,
  type BranchTagPermissions,
} from "../branch";
import { TagColor } from "../tag";

describe("Branch generic-tag contract", () => {
  it("pins availability values and granular association permissions", () => {
    expect(BranchTagAvailability.Available).toBe("available");
    expect(BranchTagAvailability.Unavailable).toBe("unavailable");

    const permissions: BranchTagPermissions = {
      canApply: true,
      canRemove: false,
    };
    expect(permissions).toEqual({ canApply: true, canRemove: false });
  });

  it("keeps every new field optional for legacy producers", () => {
    const legacyFields: Pick<
      BranchRow,
      "artifactId" | "tags" | "tagAvailability" | "tagPermissions"
    > = {};

    expect(legacyFields.artifactId).toBeUndefined();
    expect(legacyFields.tags).toBeUndefined();
    expect(legacyFields.tagAvailability).toBeUndefined();
    expect(legacyFields.tagPermissions).toBeUndefined();
    expectTypeOf<BranchRow["artifactId"]>().toEqualTypeOf<string | undefined>();
  });

  it("represents loaded-empty and unavailable tag data without fabrication", () => {
    const loadedEmpty: Pick<BranchRow, "tags" | "tagAvailability"> = {
      tags: [],
      tagAvailability: BranchTagAvailability.Available,
    };
    const unavailable: Pick<BranchRow, "tags" | "tagAvailability"> = {
      tagAvailability: BranchTagAvailability.Unavailable,
    };

    expect(loadedEmpty.tags).toEqual([]);
    expect(unavailable.tags).toBeUndefined();
  });

  it("remains structurally compatible with future unknown fields", () => {
    const futureShape = {
      artifactId: "11111111-1111-4111-8111-111111111111",
      futureTagCapability: "newer-producer-only",
      tags: [{ id: "tag-1", name: "backend", color: TagColor.Blue }],
    };
    const currentFields: Pick<BranchRow, "artifactId" | "tags"> = futureShape;

    expect(currentFields).toEqual({
      artifactId: "11111111-1111-4111-8111-111111111111",
      futureTagCapability: "newer-producer-only",
      tags: [{ id: "tag-1", name: "backend", color: TagColor.Blue }],
    });
  });
});
