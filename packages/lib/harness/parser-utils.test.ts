import { describe, expect, it } from "vitest";
import { baseName, truncateText } from "./parser-utils";

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
