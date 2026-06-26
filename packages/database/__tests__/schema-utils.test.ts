import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatSearchPath, normalizePreviewSchemaName } from "../schema-utils";

function sha1Hex(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

describe("formatSearchPath", () => {
  it("leaves a plain lowercase identifier unquoted", () => {
    expect(formatSearchPath("preview_abc_123")).toBe("preview_abc_123");
  });

  it("quotes a name containing a non-identifier character", () => {
    expect(formatSearchPath("my-schema")).toBe('"my-schema"');
  });

  it("quotes a name with a leading digit", () => {
    expect(formatSearchPath("1schema")).toBe('"1schema"');
  });

  it("quotes an uppercase name, preserving case", () => {
    expect(formatSearchPath("Preview_Abc")).toBe('"Preview_Abc"');
  });

  it("escapes embedded double quotes and quotes the result", () => {
    expect(formatSearchPath('a"b')).toBe('"a""b"');
  });
});

describe("normalizePreviewSchemaName", () => {
  it("simple branch name", () => {
    const input = "main";
    const result = normalizePreviewSchemaName(input);
    expect(result).toBe(`preview_main_${sha1Hex(input)}`);
  });

  it("ref with slash is normalized to underscore", () => {
    const input = "feature/my-branch";
    const result = normalizePreviewSchemaName(input);
    expect(result).toBe(`preview_feature_my_branch_${sha1Hex(input)}`);
  });

  it("non-ASCII characters are replaced with underscores", () => {
    const input = "café-branch";
    const result = normalizePreviewSchemaName(input);
    // 'é' is non-ASCII, gets replaced; leading/trailing underscores stripped from base
    expect(result).toBe(`preview_caf_branch_${sha1Hex(input)}`);
  });

  it("capital letters are lowercased", () => {
    const input = "MyFeatureBranch";
    const result = normalizePreviewSchemaName(input);
    expect(result).toBe(`preview_myfeaturebranch_${sha1Hex(input)}`);
  });

  it("empty string produces a valid schema name within 63 chars", () => {
    const input = "";
    const result = normalizePreviewSchemaName(input);
    // Empty base → double underscore separator, but result still valid
    expect(result).toBe(`preview__${sha1Hex(input)}`);
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it("200-char branch ref is truncated to at most 63 chars", () => {
    const input = `refs/heads/${"a".repeat(189)}`;
    expect(input.length).toBe(200);
    const result = normalizePreviewSchemaName(input);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.startsWith("preview_")).toBe(true);
    expect(result.endsWith(`_${sha1Hex(input)}`)).toBe(true);
  });

  it("always starts with preview_ prefix", () => {
    for (const input of ["main", "feature/x", "", "UPPER", "café"]) {
      expect(normalizePreviewSchemaName(input).startsWith("preview_")).toBe(
        true
      );
    }
  });

  it("always ends with the 8-char SHA1 hash of the raw input", () => {
    const inputs = ["main", "feature/my-branch", "café-branch", ""];
    for (const input of inputs) {
      const result = normalizePreviewSchemaName(input);
      expect(result.endsWith(`_${sha1Hex(input)}`)).toBe(true);
    }
  });

  it("hash is computed from the original raw input, not the normalized base", () => {
    // Two inputs that normalize to the same base must produce different hashes
    const a = normalizePreviewSchemaName("feat/foo");
    const b = normalizePreviewSchemaName("feat_foo");
    // Both normalize base to "feat_foo", but raw inputs differ so hashes differ
    expect(a).not.toBe(b);
  });
});
