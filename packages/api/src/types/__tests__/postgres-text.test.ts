import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  containsLoneSurrogate,
  containsNulCharacter,
  LONE_SURROGATE_RE,
  NUL_CHARACTER,
  PostgresTextRejection,
  postgresStorableTextSchema,
} from "../postgres-text.ts";
import { findIssue } from "../zod-issue.test-helpers.ts";

// Built via char codes so no literal NUL or surrogate byte lives in this source.
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd8_3d);
const LONE_LOW_SURROGATE = String.fromCharCode(0xde_00);
const REPLACEMENT = String.fromCharCode(0xff_fd);
const EMOJI = String.fromCodePoint(0x1_f6_00);

describe("containsNulCharacter", () => {
  it.each([
    ["leading", `${NUL_CHARACTER}code-reviewer`],
    ["embedded", `code-rev${NUL_CHARACTER}iewer`],
    ["trailing", `code-reviewer${NUL_CHARACTER}`],
    ["alone", NUL_CHARACTER],
  ])("is true with a NUL %s", (_label, value) => {
    expect(containsNulCharacter(value)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["plain text", "code-reviewer"],
    ["U+FFFD", `a${REPLACEMENT}b`],
    ["a valid surrogate pair", `a${EMOJI}b`],
    ["a lone surrogate, which is the other class", LONE_HIGH_SURROGATE],
  ])("is false for %s", (_label, value) => {
    expect(containsNulCharacter(value)).toBe(false);
  });
});

describe("containsLoneSurrogate", () => {
  it.each([
    ["a lone high surrogate at the end", `abc${LONE_HIGH_SURROGATE}`],
    ["a lone high surrogate before a BMP char", `a${LONE_HIGH_SURROGATE}b`],
    ["a lone low surrogate at the start", `${LONE_LOW_SURROGATE}abc`],
    ["a lone low surrogate after a BMP char", `a${LONE_LOW_SURROGATE}b`],
    ["a pair followed by a lone low", `${EMOJI}${LONE_LOW_SURROGATE}`],
  ])("is true for %s", (_label, value) => {
    expect(containsLoneSurrogate(value)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["plain text", "code-reviewer"],
    ["a valid surrogate pair", `a${EMOJI}b`],
    ["U+FFFD", `a${REPLACEMENT}b`],
    ["a NUL, which is the other class", `a${NUL_CHARACTER}b`],
  ])("is false for %s", (_label, value) => {
    expect(containsLoneSurrogate(value)).toBe(false);
  });

  it("answers the same on the same value twice", () => {
    // `RegExp.prototype.test` on a global regex advances `lastIndex`, so a `g`
    // flag on the shared literal would make the second call here return false.
    // The sanitizer rebuilds a `/g` copy from `.source`, which is exactly the
    // temptation to put the flag on the shared literal instead.
    const value = `a${LONE_HIGH_SURROGATE}b`;

    expect(containsLoneSurrogate(value)).toBe(true);
    expect(containsLoneSurrogate(value)).toBe(true);
  });

  it("is backed by a non-global regex", () => {
    expect(LONE_SURROGATE_RE.global).toBe(false);
  });
});

describe("postgresStorableTextSchema", () => {
  const schema = postgresStorableTextSchema(z.string());

  it.each([
    ["plain text", "code-reviewer"],
    ["padded text", "  code-reviewer  "],
    ["a valid surrogate pair", `a${EMOJI}b`],
    ["U+FFFD", `a${REPLACEMENT}b`],
    ["an empty string", ""],
  ])("passes %s through unchanged", (_label, value) => {
    const result = schema.safeParse(value);

    expect(result.success).toBe(true);
    expect(result.data).toBe(value);
  });

  it("rejects a NUL with contains_nul and nothing else", () => {
    const result = schema.safeParse(`code-rev${NUL_CHARACTER}iewer`);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        PostgresTextRejection.ContainsNul,
      ]);
      expect(findIssue(result.error.issues, [])?.message).toBe(
        PostgresTextRejection.ContainsNul
      );
    }
  });

  it("rejects a lone surrogate with contains_lone_surrogate and nothing else", () => {
    const result = schema.safeParse(`a${LONE_LOW_SURROGATE}b`);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        PostgresTextRejection.ContainsLoneSurrogate,
      ]);
    }
  });

  it("reports both classes when a value carries both", () => {
    const result = schema.safeParse(`a${NUL_CHARACTER}b${LONE_HIGH_SURROGATE}`);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        PostgresTextRejection.ContainsNul,
        PostgresTextRejection.ContainsLoneSurrogate,
      ]);
    }
  });

  it("runs after the base schema's own checks and keeps them", () => {
    // The base trims before the refine sees the value, so a clean padded value
    // comes back trimmed: that is the base's contract, not this wrapper's.
    const trimmed = postgresStorableTextSchema(z.string().trim().min(1));

    expect(trimmed.safeParse("  Read  ").data).toBe("Read");
    const blank = trimmed.safeParse("   ");
    expect(blank.success).toBe(false);
    if (!blank.success) {
      expect(blank.error.issues).toHaveLength(1);
      expect(blank.error.issues[0]?.code).toBe("too_small");
    }
  });
});
