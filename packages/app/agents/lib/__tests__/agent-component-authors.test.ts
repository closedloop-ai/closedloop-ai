/**
 * FEA-4247: `resolveComponentAuthors` derives the render-time authors people-set
 * with skew-safe precedence — `collaborators` (current server) over the
 * DEPRECATED single `owner` alias (older/version-skewed producer).
 */
import { describe, expect, it } from "vitest";
import { resolveComponentAuthors } from "../agent-component-authors";

describe("resolveComponentAuthors", () => {
  it("returns collaborators when present (current server)", () => {
    expect(
      resolveComponentAuthors({
        collaborators: ["Dana Discoverer", "Edith Editor"],
        owner: "Dana Discoverer",
      })
    ).toEqual(["Dana Discoverer", "Edith Editor"]);
  });

  it("falls back to a single-element owner list when collaborators is empty", () => {
    expect(
      resolveComponentAuthors({ collaborators: [], owner: "Ada Lovelace" })
    ).toEqual(["Ada Lovelace"]);
  });

  // Skew guard: an older producer predating the `collaborators` axis omits the
  // field entirely and sends only `owner`. Reading `.length` on a missing field
  // must not throw before `owner` is read.
  it("does not throw on an owner-only payload that omits collaborators (version skew)", () => {
    expect(resolveComponentAuthors({ owner: "Ada Lovelace" })).toEqual([
      "Ada Lovelace",
    ]);
  });

  it("returns an empty set when neither axis has data (honest empty, never fabricated)", () => {
    expect(resolveComponentAuthors({ collaborators: [] })).toEqual([]);
    expect(resolveComponentAuthors({})).toEqual([]);
  });
});
