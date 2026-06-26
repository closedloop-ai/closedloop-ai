import { describe, expect, it } from "vitest";
import { getStringRouteParam } from "../route-param";

describe("getStringRouteParam", () => {
  it("returns the value for a plain string param", () => {
    expect(getStringRouteParam({ teamId: "team-1" }, "teamId")).toBe("team-1");
  });

  it("returns empty string for a missing key", () => {
    expect(getStringRouteParam({}, "teamId")).toBe("");
  });

  it("returns empty string for an undefined value", () => {
    expect(getStringRouteParam({ teamId: undefined }, "teamId")).toBe("");
  });

  it("returns empty string for a catch-all array value", () => {
    expect(getStringRouteParam({ slug: ["a", "b"] }, "slug")).toBe("");
  });
});
