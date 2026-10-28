import { describe, expect, it } from "vitest";
import { staleAllowlistEntries } from "./catalog-allowlist-staleness.mjs";

const SHELL = "@repo/app/shell/v2/components/prototype-shell";
const DEMO = "@repo/app/search/components/search-surface-v2-page-demo";

describe("staleAllowlistEntries (ISS-12426)", () => {
  it("names an entry no prototype imports", () => {
    expect(staleAllowlistEntries([SHELL, DEMO], [SHELL])).toEqual([DEMO]);
  });

  it("returns nothing when every entry is imported", () => {
    expect(staleAllowlistEntries([SHELL, DEMO], [DEMO, SHELL])).toEqual([]);
  });

  it("refuses an empty allowlist or an empty import scan", () => {
    expect(() => staleAllowlistEntries([], [SHELL])).toThrow(
      "allowlist is empty"
    );
    expect(() => staleAllowlistEntries([SHELL], [])).toThrow(
      "found no @repo imports"
    );
  });
});
