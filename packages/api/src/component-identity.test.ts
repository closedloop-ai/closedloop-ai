import { describe, expect, it } from "vitest";
import {
  computeComponentUuid,
  normalizeComponentContent,
} from "./component-identity";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("normalizeComponentContent", () => {
  it("lowercases, trims, and strips all whitespace", () => {
    expect(normalizeComponentContent("  Hello\n  World \t")).toBe("helloworld");
  });
});

describe("computeComponentUuid", () => {
  const base = {
    source: "closedloop-ai/claude-plugins",
    owner: "org-123",
    content: "# Reviewer\n\nReview the code.",
  };

  it("returns a deterministic v5 UUID", () => {
    const a = computeComponentUuid(base);
    const b = computeComponentUuid(base);
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it("ignores whitespace + case differences in content", () => {
    expect(computeComponentUuid(base)).toBe(
      computeComponentUuid({
        ...base,
        content: "  # REVIEWER\n\n   Review   the code. ",
      })
    );
  });

  it("differs by source, owner, or content", () => {
    const id = computeComponentUuid(base);
    expect(computeComponentUuid({ ...base, source: "other/repo" })).not.toBe(
      id
    );
    expect(computeComponentUuid({ ...base, owner: "org-999" })).not.toBe(id);
    expect(computeComponentUuid({ ...base, content: "different" })).not.toBe(
      id
    );
  });
});
