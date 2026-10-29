import { afterEach, describe, expect, it, vi } from "vitest";
import { gridTierQuery, matchesGridTier } from "../summary-card-grid-tier";

describe("gridTierQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when window is undefined", () => {
    vi.stubGlobal("window", undefined);

    expect(gridTierQuery()).toBeNull();
  });

  it("returns null when matchMedia is unavailable on window", () => {
    vi.stubGlobal("window", {});

    expect(gridTierQuery()).toBeNull();
  });

  it("returns the MediaQueryList from window.matchMedia when available", () => {
    const mediaQueryList = { matches: true } as MediaQueryList;
    const matchMedia = vi.fn().mockReturnValue(mediaQueryList);
    vi.stubGlobal("window", { matchMedia });

    const result = gridTierQuery();

    expect(result).toBe(mediaQueryList);
    expect(matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  });
});

describe("matchesGridTier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when the query itself is null (no matchMedia support)", () => {
    vi.stubGlobal("window", undefined);

    expect(matchesGridTier()).toBe(true);
  });

  it("returns the query's own matches value (true) when a query exists", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });

    expect(matchesGridTier()).toBe(true);
  });

  it("returns the query's own matches value (false) when a query exists", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });

    expect(matchesGridTier()).toBe(false);
  });
});
