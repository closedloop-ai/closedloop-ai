import { describe, expect, it } from "vitest";

import { normalizeModelName } from "../src/tokens";

describe("normalizeModelName", () => {
  it("strips date suffixes", () => {
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5"
    );
    expect(normalizeModelName("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5"
    );
  });

  it("maps opus-4-6 to opus-4", () => {
    expect(normalizeModelName("claude-opus-4-6")).toBe("claude-opus-4");
  });

  it("preserves already-canonical names", () => {
    expect(normalizeModelName("claude-opus-4")).toBe("claude-opus-4");
    expect(normalizeModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("passes through unknown models unchanged", () => {
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
    expect(normalizeModelName("custom-model")).toBe("custom-model");
  });
});
