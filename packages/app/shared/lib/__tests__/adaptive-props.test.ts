import { describe, expect, it } from "vitest";
import { AdaptiveDensity, resolveAlwaysShowActions } from "../adaptive-props";

// FEA-3872: the RN-parity component contract. `resolveAlwaysShowActions` is the
// one behavioral helper the action-cell components share, so it carries the
// coverage; the rest of the module is types (compile-time only).

describe("resolveAlwaysShowActions (FEA-3872)", () => {
  it("returns false when the flag is undefined so the surface keeps its pointer-aware hover-reveal default", () => {
    expect(resolveAlwaysShowActions(undefined)).toBe(false);
  });

  it("honors an explicit true (the RN adapter passes true — no hover to reveal actions)", () => {
    expect(resolveAlwaysShowActions(true)).toBe(true);
  });

  it("honors an explicit false (a web caller can pin the hover-reveal on)", () => {
    expect(resolveAlwaysShowActions(false)).toBe(false);
  });
});

describe("AdaptiveDensity (FEA-3872)", () => {
  it("exposes the compact→comfortable tiers that mirror the --density-* tokens", () => {
    expect(AdaptiveDensity.Compact).toBe("compact");
    expect(AdaptiveDensity.Cozy).toBe("cozy");
    expect(AdaptiveDensity.Comfortable).toBe("comfortable");
  });
});
