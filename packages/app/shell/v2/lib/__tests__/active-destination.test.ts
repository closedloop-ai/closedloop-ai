import { describe, expect, it } from "vitest";
import { isActiveDestination } from "../active-destination";

describe("isActiveDestination", () => {
  it("is active on the destination itself and on a path beneath it", () => {
    expect(isActiveDestination("/acme/issues", "/acme/issues")).toBe(true);
    expect(isActiveDestination("/acme/issues/ISS-1", "/acme/issues")).toBe(
      true
    );
  });

  it("is not active on a sibling whose path the destination prefixes", () => {
    // The whole reason the rule is not a bare `startsWith`: a manifest holding
    // both lights two rows at once, and the component renders whatever manifest
    // it is handed.
    expect(isActiveDestination("/acme/issues-archive", "/acme/issues")).toBe(
      false
    );
  });

  it("is not active when either side is null", () => {
    expect(isActiveDestination(null, "/acme/issues")).toBe(false);
    expect(isActiveDestination("/acme/issues", null)).toBe(false);
  });
});
