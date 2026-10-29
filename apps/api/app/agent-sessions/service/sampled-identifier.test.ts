/**
 * ISS-8781: the SIZE cap `boundSampledIdentifier` promises is the cap the caller
 * gets — marker included.
 *
 * The behaviour was inherited verbatim from ISS-8881, where the marker was
 * appended AFTER truncating to the full budget: `…[truncated]` is 14 UTF-8
 * bytes, so every truncated identifier was 270 bytes against a constant whose
 * docstring promises 256. Asserted in BYTES (`Buffer.byteLength`) and never in
 * `.length`, because `.length` counts UTF-16 code units and is the exact
 * measurement this bound exists to avoid.
 */
import { describe, expect, it } from "vitest";
import {
  boundSampledIdentifier,
  MAX_SAMPLED_IDENTIFIER_BYTES,
  SAMPLED_IDENTIFIER_TRUNCATION_MARKER,
} from "./sampled-identifier";

/** A lone surrogate at the end — what a byte-blind slice of an astral pair leaves. */
const TRAILING_LONE_SURROGATE = /[\uD800-\uDFFF]$/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("boundSampledIdentifier", () => {
  it("keeps a truncated ASCII identifier inside the byte cap", () => {
    const bounded = boundSampledIdentifier(
      "s".repeat(MAX_SAMPLED_IDENTIFIER_BYTES * 4)
    );

    expect(byteLength(bounded)).toBeLessThanOrEqual(
      MAX_SAMPLED_IDENTIFIER_BYTES
    );
    expect(bounded.endsWith(SAMPLED_IDENTIFIER_TRUNCATION_MARKER)).toBe(true);
  });

  it("keeps a truncated multi-byte identifier inside the byte cap", () => {
    // 4 bytes per astral character, so a `.length` reading of the same string is
    // a quarter of its real size — and a naive slice could split a surrogate
    // pair. Both are what the byte-accurate helper is for.
    const bounded = boundSampledIdentifier("\u{1F600}".repeat(200));

    expect(byteLength(bounded)).toBeLessThanOrEqual(
      MAX_SAMPLED_IDENTIFIER_BYTES
    );
    expect(bounded.endsWith(SAMPLED_IDENTIFIER_TRUNCATION_MARKER)).toBe(true);
    expect(bounded).not.toMatch(TRAILING_LONE_SURROGATE);
  });

  it("returns an identifier that fits the cap untouched, marker and all", () => {
    // EXACTLY at the cap. The marker's bytes are reserved from the budget, so a
    // value this size still fits whole and must not be marked as truncated — a
    // reservation applied unconditionally would mark and shorten it.
    const exact = "s".repeat(MAX_SAMPLED_IDENTIFIER_BYTES);

    expect(boundSampledIdentifier(exact)).toBe(exact);
  });
});
