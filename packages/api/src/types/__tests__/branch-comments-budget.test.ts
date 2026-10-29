import { describe, expect, it } from "vitest";
import { BranchCommentsBudget } from "../branch.ts";
import { trimBranchPrCommentBody } from "../branch-comments-budget.ts";

describe("trimBranchPrCommentBody", () => {
  const MAX = BranchCommentsBudget.MaxBodyBytes;

  // ── Under-cap inputs must pass through unchanged ──────────────────────

  it("returns the identical string with truncated:false when under the cap", () => {
    const body = "hello world";
    const result = trimBranchPrCommentBody(body);

    expect(result.body).toBe(body);
    expect(result.truncated).toBe(false);
  });

  it("returns the identical string when exactly at MaxBodyBytes (ASCII)", () => {
    const body = "a".repeat(MAX);
    const result = trimBranchPrCommentBody(body);

    expect(result.body).toBe(body);
    expect(result.truncated).toBe(false);
    expect(new TextEncoder().encode(result.body).byteLength).toBe(MAX);
  });

  it("returns the identical string when exactly at MaxBodyBytes (single-byte boundary)", () => {
    // Exactly MAX bytes — must not truncate
    const body = "x".repeat(MAX);
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(false);
    expect(result.body).toBe(body);
  });

  // ── Over-cap inputs must truncate correctly ───────────────────────────

  it("truncates a one-byte-over ASCII body to exactly MaxBodyBytes", () => {
    const body = "a".repeat(MAX + 1);
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.body).byteLength;
    expect(bytes).toBe(MAX);
    expect(result.body).toBe("a".repeat(MAX));
  });

  it("truncates 65,536 CJK characters and the result is valid UTF-8 ≤ MaxBodyBytes", () => {
    // ISS-8329 §1: this is the concrete triggering input — GitHub's own max
    // comment body length. Each CJK char is 3 bytes in UTF-8.
    const body = "中".repeat(65_536);
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.body).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX);
    // 16384 / 3 = 5461.33 → 5461 full characters = 16383 bytes
    expect(bytes).toBe(16_383);
    expect(result.body).toBe("中".repeat(5461));
    // Round-trip proves no replacement chars (no split multi-byte sequence)
    expect(result.body).not.toContain("�");
  });

  it("truncates 32,768 astral emoji and the result is valid UTF-8 ≤ MaxBodyBytes", () => {
    // Each 😀 is 4 bytes in UTF-8 (2 UTF-16 code units)
    const body = "😀".repeat(32_768);
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.body).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX);
    // 16384 / 4 = 4096 full emoji = 16384 bytes
    expect(bytes).toBe(MAX);
    expect(result.body).toBe("😀".repeat(4096));
    expect(result.body).not.toContain("�");
  });

  it("does not split a 3-byte CJK char straddling the cap", () => {
    // Fill to MAX - 2 bytes with ASCII, then one 3-byte CJK char
    const prefix = "a".repeat(MAX - 2);
    const body = `${prefix}中`; // MAX - 2 + 3 = MAX + 1 bytes
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.body).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX);
    // The CJK char cannot fit whole, so it is dropped entirely
    expect(result.body).toBe(prefix);
    expect(bytes).toBe(MAX - 2);
    expect(result.body).not.toContain("�");
  });

  it("does not split a 4-byte emoji straddling the cap", () => {
    // Fill to MAX - 1 bytes with ASCII, then one 4-byte emoji
    const prefix = "a".repeat(MAX - 1);
    const body = `${prefix}😀`; // MAX - 1 + 4 = MAX + 3 bytes
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.body).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX);
    // The emoji cannot fit whole, so it is dropped entirely
    expect(result.body).toBe(prefix);
    expect(bytes).toBe(MAX - 1);
    expect(result.body).not.toContain("�");
  });

  it("truncates a mixed ASCII/CJK/emoji body without producing replacement chars", () => {
    const unit = "a中😀";
    const body = unit.repeat(20_000);
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.body).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX);
    expect(result.body).not.toContain("�");
  });

  it("handles the empty string", () => {
    const result = trimBranchPrCommentBody("");
    expect(result.body).toBe("");
    expect(result.truncated).toBe(false);
  });

  // ── Retained code units must survive byte-for-byte (davetho review) ──
  //
  // These two pin the difference between cutting the SOURCE string and cutting
  // an encoded copy that is decoded back. Both fail against a `TextDecoder`
  // round-trip: it consumes a leading BOM (`ignoreBOM` defaults to false) and
  // rewrites a lone surrogate to U+FFFD. Both values reach this function through
  // JSON escapes, and the pre-ISS-8329 slice loop preserved them.

  it("keeps a leading BOM when the body is truncated", () => {
    const body = `\uFEFF${"a".repeat(MAX + 10)}`;
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    expect(result.body.codePointAt(0)).toBe("\uFEFF".codePointAt(0));
    expect(result.body).toBe(`\uFEFF${"a".repeat(MAX - 3)}`);
    expect(
      new TextEncoder().encode(result.body).byteLength
    ).toBeLessThanOrEqual(MAX);
  });

  it("keeps a retained lone surrogate rather than folding it to U+FFFD", () => {
    const body = `\uD800${"b".repeat(MAX + 10)}`;
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    expect(result.body.charCodeAt(0)).toBe("\uD800".charCodeAt(0));
    expect(result.body).not.toContain("\uFFFD");
    expect(result.body).toBe(`\uD800${"b".repeat(MAX - 3)}`);
    expect(
      new TextEncoder().encode(result.body).byteLength
    ).toBeLessThanOrEqual(MAX);
  });

  it("charges an unpaired surrogate 3 bytes, matching TextEncoder", () => {
    // A lone surrogate encodes as U+FFFD (3 bytes), so MAX/3 of them fit and the
    // budget is respected even though none is a whole character.
    const body = "\uD800".repeat(MAX);
    const result = trimBranchPrCommentBody(body);

    expect(result.truncated).toBe(true);
    expect(
      new TextEncoder().encode(result.body).byteLength
    ).toBeLessThanOrEqual(MAX);
    expect(result.body.length).toBe(Math.floor(MAX / 3));
  });
});
