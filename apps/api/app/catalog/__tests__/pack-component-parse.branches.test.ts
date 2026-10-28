/**
 * Branch-coverage pins for app/catalog/pack-component-parse.ts (ISS-11280),
 * targeting arms not already exercised by the sibling
 * pack-component-parse.test.ts: the flat (non-directory) skill form in
 * classifyComponentPath (isComponentCandidatePath's own test covers the
 * candidate-path side but classifyComponentPath's return value never gets
 * asserted for it), the empty-path guard, a top-level `hooks.json` (parent
 * is not `hooks/`), and parseMcpJson's fallback when the parsed JSON lacks
 * `mcpServers`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyComponentPath,
  isComponentCandidatePath,
} from "../pack-component-parse";

describe("isComponentCandidatePath — empty-segment fallback", () => {
  it("rejects a path with no segments (base falls back to empty string)", () => {
    expect(isComponentCandidatePath("")).toBe(false);
    expect(isComponentCandidatePath("///")).toBe(false);
  });
});

describe("classifyComponentPath — flat skill form", () => {
  it("classifies skills/<name>.md (no SKILL.md wrapper) by stripping the extension", () => {
    const result = classifyComponentPath("skills/flat.md", () => "content");

    expect(result).toEqual([
      { kind: "skill", name: "flat", content: "content" },
    ]);
  });
});

describe("classifyComponentPath — empty path guard", () => {
  it("returns null for a path with no segments", () => {
    expect(classifyComponentPath("", () => "unreachable")).toBeNull();
    expect(classifyComponentPath("///", () => "unreachable")).toBeNull();
  });
});

describe("classifyComponentPath — top-level hooks.json", () => {
  it("classifies a root hooks.json (no hooks/ parent) as a hook named 'hooks'", () => {
    const result = classifyComponentPath("hooks.json", () => "{}");

    expect(result).toEqual([{ kind: "hook", name: "hooks", content: "{}" }]);
  });
});

describe("classifyComponentPath — hooks/<name>.json", () => {
  it("classifies a file under a hooks/ parent, stripping the extension", () => {
    // isComponentCandidatePath's sibling test already exercises this path
    // shape for the pre-filter; classifyComponentPath's own return value
    // for it was never asserted.
    const result = classifyComponentPath("hooks/foo.json", () => "content");

    expect(result).toEqual([{ kind: "hook", name: "foo", content: "content" }]);
  });
});

describe("classifyComponentPath — .mcp.json without mcpServers", () => {
  it("returns an empty component list when the JSON has no mcpServers key", () => {
    const result = classifyComponentPath(
      ".mcp.json",
      () => '{"unrelated": true}'
    );

    expect(result).toEqual([]);
  });
});
