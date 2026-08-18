import { describe, expect, it } from "vitest";
import {
  asRecord,
  baseName,
  classifyToolKind,
  HARNESS_TOOL_NAMES,
  isMeaningfulCwd,
  truncateText,
} from "./parser-utils";

describe("isMeaningfulCwd (FEA-3668)", () => {
  it.each([
    ["/Users/me/project", true],
    ["/private/tmp/nrev-fix-fea-3590-47751", true],
    ["C:\\Users\\me\\project", true],
    ["/", false],
    ["//", false],
    ["  /  ", false],
    ["", false],
    ["   ", false],
    ["C:\\", false],
    ["C:/", false],
    ["c:", false],
  ])("treats %j as meaningful=%s", (cwd, expected) => {
    expect(isMeaningfulCwd(cwd)).toBe(expected);
  });

  it.each([null, undefined])("rejects %j", (cwd) => {
    expect(isMeaningfulCwd(cwd)).toBe(false);
  });
});

describe("classifyToolKind (FEA-2642 / TC-038)", () => {
  it("classifies first-party IO/workspace tools as builtin", () => {
    for (const name of ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]) {
      expect(classifyToolKind(name)).toBe("builtin");
    }
  });

  it("classifies agent-runtime orchestration/meta tools as harness", () => {
    for (const name of [
      "Agent",
      "Task",
      "TaskCreate",
      "ToolSearch",
      "Monitor",
      "Workflow",
      "Skill",
    ]) {
      expect(classifyToolKind(name)).toBe("harness");
    }
  });

  it("classifies mcp__* tools as mcp (prefix wins over the harness list)", () => {
    expect(classifyToolKind("mcp__figma__authenticate")).toBe("mcp");
    expect(classifyToolKind("mcp__x__Agent")).toBe("mcp");
  });

  it("defaults unknown non-mcp tools to builtin", () => {
    expect(classifyToolKind("SomeBrandNewTool")).toBe("builtin");
    expect(HARNESS_TOOL_NAMES.has("Bash")).toBe(false);
    expect(HARNESS_TOOL_NAMES.has("Agent")).toBe(true);
  });
});

// The desktop `test/parser-utils.test.ts` covers the ported pure helpers. These
// tests pin the two functions this extraction changed/added: the browser-safe
// `truncateText` (Buffer → TextEncoder/TextDecoder) and `baseName`.

describe("truncateText", () => {
  it("returns null for null/empty and passes short text through unchanged", () => {
    expect(truncateText(null)).toBeNull();
    expect(truncateText(undefined)).toBeNull();
    expect(truncateText("")).toBeNull();
    expect(truncateText("short")).toBe("short");
  });

  it("keeps text whose UTF-8 byte length is exactly the limit", () => {
    // "€" is 3 UTF-8 bytes; "a€" is 4 bytes.
    expect(truncateText("a€", 4)).toBe("a€");
  });

  it("byte-cuts and replaces a split multi-byte char with U+FFFD (Buffer parity)", () => {
    // "aaa€" is 6 UTF-8 bytes; cut at 4 leaves "aaa" + the lead byte of € →
    // the WHATWG decoder yields one replacement char, matching the prior
    // Buffer.subarray(...).toString("utf8") behavior.
    expect(truncateText("aaa€", 4)).toBe("aaa�");
  });

  it("truncates plain ASCII on the byte boundary", () => {
    expect(truncateText("abcdefgh", 4)).toBe("abcd");
  });

  it("preserves a leading BOM on the truncation path (Buffer parity)", () => {
    // U+FEFF is 3 UTF-8 bytes; the decoder must keep it (ignoreBOM: true) rather
    // than strip it, matching Buffer.toString and the untruncated branch. Cutting
    // BOM + "abcdefgh" (11 bytes) at 5 leaves the BOM + "ab".
    const bom = String.fromCodePoint(0xfe_ff);
    expect(truncateText(`${bom}abcdefgh`, 5)).toBe(`${bom}ab`);
    // Untruncated branch returns text verbatim → both keep the BOM.
    expect(truncateText(`${bom}ab`)).toBe(`${bom}ab`);
  });
});

describe("baseName", () => {
  it("returns the last POSIX path segment, trimming trailing slashes", () => {
    expect(baseName("/home/me/project")).toBe("project");
    expect(baseName("/home/me/project/")).toBe("project");
    expect(baseName("project")).toBe("project");
  });

  it("handles Windows-style separators so cross-OS cwds match", () => {
    expect(baseName("C:\\Users\\me\\project")).toBe("project");
    expect(baseName("C:\\Users\\me\\project\\")).toBe("project");
  });
});

describe("asRecord (ISS-5292)", () => {
  it("returns {} for non-object values so field reads no-op instead of throwing", () => {
    // The tolerant `{}` fallback is the contract that distinguishes this helper
    // from the null-returning `asRecord` in ./type-guards.
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
    expect(asRecord("string")).toEqual({});
    expect(asRecord(42)).toEqual({});
  });

  it("returns the same object reference for object values", () => {
    const source = { x: 1 };
    expect(asRecord(source)).toBe(source);
  });

  it("treats an array as an object rather than coercing it away", () => {
    // `typeof [] === "object"`, so arrays take the pass-through arm. Pinned
    // because a caller reading named fields off an array gets undefined, not a
    // throw — the degradation this helper exists to provide.
    const source = [1, 2];
    expect(asRecord(source)).toBe(source);
  });
});
