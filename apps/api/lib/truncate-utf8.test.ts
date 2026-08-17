import { describe, expect, it } from "vitest";
import { truncateToUtf8Bytes } from "./truncate-utf8";

describe("truncateToUtf8Bytes", () => {
  it("returns text under the budget untouched", () => {
    const result = truncateToUtf8Bytes("hello", 1024);

    expect(result).toEqual({
      text: "hello",
      byteLength: 5,
      originalByteLength: 5,
      truncated: false,
    });
  });

  it("treats a budget equal to the byte length as fitting", () => {
    const result = truncateToUtf8Bytes("hello", 5);

    // Boundary: the cap is inclusive, so nothing is dropped at exactly the
    // budget and `truncated` must stay false.
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello");
  });

  it("measures multibyte text in bytes, not UTF-16 code units", () => {
    // 4 CJK characters: 4 code units, 12 UTF-8 bytes. A budget of 6 is under
    // the byte length but over the code-unit length, so a `.length`-based
    // implementation would report this as fitting.
    const result = truncateToUtf8Bytes("漢字漢字", 6);

    expect(result.originalByteLength).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("漢字");
    expect(result.byteLength).toBe(6);
  });

  it("drops a whole character rather than cutting one in half", () => {
    // A budget of 7 lands inside the third character (bytes 6-8), so the
    // result must fall BACK to 6 bytes rather than emit a partial sequence.
    const result = truncateToUtf8Bytes("漢字漢字", 7);

    expect(result.text).toBe("漢字");
    expect(result.byteLength).toBe(6);
  });

  it("never emits a lone surrogate when the cut lands inside an astral character", () => {
    // "😀" is one 4-byte UTF-8 sequence but a SURROGATE PAIR of two UTF-16
    // code units, so a code-unit slice here yields the high surrogate alone.
    const result = truncateToUtf8Bytes("ab😀", 4);

    expect(result.text).toBe("ab");
    // Round-trip equality is the contract: a lone surrogate decodes to U+FFFD.
    expect(Buffer.from(result.text, "utf8").toString("utf8")).toBe(result.text);
  });

  it("keeps an astral character that fits whole", () => {
    const result = truncateToUtf8Bytes("ab😀", 6);

    expect(result.text).toBe("ab😀");
    expect(result.truncated).toBe(false);
  });

  it("clamps a negative budget to empty rather than slicing backwards", () => {
    // Load-bearing since the truncation was delegated to the canonical
    // `truncateUtf8`, which validates nothing: passed a negative budget
    // directly it reaches `TypedArray#subarray`'s negative-index semantics and
    // counts from the END of the string, returning nearly all of it instead of
    // truncating. The clamp in this wrapper is what keeps that unreachable.
    //
    // The budget must be SMALLER in magnitude than the input, or the negative
    // index underflows to 0 and yields "" by coincidence — passing whether or
    // not the clamp exists, and proving nothing.
    const result = truncateToUtf8Bytes("漢字漢字", -1);

    expect(result.text).toBe("");
    expect(result.byteLength).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.originalByteLength).toBe(12);
  });

  it("floors a fractional budget instead of splitting a character", () => {
    // Also load-bearing for the delegation: a fractional budget makes the
    // canonical's continuation-byte lookup `undefined`, so it skips the
    // walk-back entirely and emits a split character (U+FFFD). Flooring first
    // means the walk-back always runs on a real byte index.
    const result = truncateToUtf8Bytes("漢字漢字", 7.5);

    expect(result.text).toBe("漢字");
    expect(result.byteLength).toBe(6);
    // Round-trip equality is the no-split-character contract.
    expect(Buffer.from(result.text, "utf8").toString("utf8")).toBe(result.text);
  });

  it("reports the pre-truncation byte length so callers can log the real size", () => {
    const result = truncateToUtf8Bytes("漢".repeat(100), 30);

    // The caller logs this; reporting the truncated size as the original would
    // tell an operator the document was always small.
    expect(result.originalByteLength).toBe(300);
    expect(result.byteLength).toBe(30);
  });
});
