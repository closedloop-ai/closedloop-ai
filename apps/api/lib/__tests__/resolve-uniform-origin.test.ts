import { describe, expect, it } from "vitest";
import { resolveUniformOrigin } from "../resolve-uniform-origin";

describe("resolveUniformOrigin", () => {
  it("returns the shared value", () => {
    expect(resolveUniformOrigin(["DRAFT", "DRAFT"])).toBe("DRAFT");
  });

  it("omits mixed and empty origins", () => {
    expect(resolveUniformOrigin(["DRAFT", "TODO"])).toBeUndefined();
    expect(resolveUniformOrigin([])).toBeUndefined();
  });
});
