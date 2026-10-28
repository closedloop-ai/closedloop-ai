/**
 * @file ISS-11283 branch coverage for the pure attribute-sanitizing helpers in
 * otel/codex-otel-writer.ts. Calls the exported `sanitizeCodexOtelAttributes`
 * directly (no DB) to reach the private `hasNonEmptySensitiveValue` and
 * `toStorableAttributeValue` branches that the existing suites never exercise
 * because every fixture attribute value there is a plain non-empty string.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_OTEL_MAX_ATTRIBUTE_COUNT,
  CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH,
  CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH,
  CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT,
} from "../src/main/otel/codex-otel-contract.js";
import {
  REDACTED_ATTRIBUTES_KEY,
  sanitizeCodexOtelAttributes,
} from "../src/main/otel/codex-otel-writer.js";

describe("sanitizeCodexOtelAttributes: attribute key length gate", () => {
  it("drops an attribute whose key exceeds the max key length, without redacting it", () => {
    const longKey = "x".repeat(CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH + 1);
    const result = sanitizeCodexOtelAttributes({
      [longKey]: "value",
      "gen_ai.system": "codex",
    });

    expect(result[longKey]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
    expect(result["gen_ai.system"]).toBe("codex");
  });

  it("passes a key exactly at the max length through to the sensitivity check (boundary: > not >=)", () => {
    // 120 filler chars + "." + "prompt" (6) + 1 leading char = 128 exactly.
    // The "." boundary before "prompt" is required by SENSITIVE_ATTRIBUTE_RE
    // (it only matches at a `._-`/start/end boundary), and being at the
    // string's end satisfies the trailing boundary too. At exactly the max
    // length the key must NOT be dropped by the length gate — only a key
    // that exceeds it.
    const boundaryKey = `p${"x".repeat(120)}.prompt`;
    expect(boundaryKey.length).toBe(CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH);
    const result = sanitizeCodexOtelAttributes({
      [boundaryKey]: "secret-value",
    });

    expect(result[REDACTED_ATTRIBUTES_KEY]).toEqual([boundaryKey]);
  });

  it("drops an over-length key before it ever reaches the sensitivity check", () => {
    // Exceeds the max length AND contains ".token." (with boundary dots on
    // both sides, so it would match SENSITIVE_ATTRIBUTE_RE), so if the length
    // gate's `continue` were skipped the key would fall through into the
    // sensitive branch and get redacted. It must not: the length gate runs
    // first.
    const overLengthSensitiveKey = `${"x".repeat(119)}.token.${"x".repeat(10)}`;
    expect(overLengthSensitiveKey.length).toBeGreaterThan(
      CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH
    );
    const result = sanitizeCodexOtelAttributes({
      [overLengthSensitiveKey]: "secret-value",
    });

    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
  });
});

describe("sanitizeCodexOtelAttributes: attribute count gate", () => {
  it("never inspects an entry past the max attribute count", () => {
    const filler = Object.fromEntries(
      Array.from({ length: CODEX_OTEL_MAX_ATTRIBUTE_COUNT }, (_, index) => [
        `custom.${index}`,
        "unused",
      ])
    );
    // Inserted AFTER exactly CODEX_OTEL_MAX_ATTRIBUTE_COUNT filler entries, so
    // it sits past the slice cap and must never be considered.
    const result = sanitizeCodexOtelAttributes({
      ...filler,
      "session.id": "should-be-capped-out",
    });

    expect(Object.hasOwn(result, "session.id")).toBe(false);
  });
});

describe("sanitizeCodexOtelAttributes: hasNonEmptySensitiveValue over non-string values", () => {
  it("treats a non-empty array sensitive value as non-empty (redacted)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.items": ["secret-a", "secret-b"],
    });

    expect(result["prompt.items"]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toEqual(["prompt.items"]);
  });

  it("treats an empty array sensitive value as empty (not redacted)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.items": [],
    });

    expect(result["prompt.items"]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
  });

  it("treats a sensitive object value with keys as non-empty (redacted)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.payload": { role: "user" },
    });

    expect(result["prompt.payload"]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toEqual(["prompt.payload"]);
  });

  it("treats a sensitive object value with no keys as empty (not redacted)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.payload": {},
    });

    expect(result["prompt.payload"]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
  });

  it("treats a sensitive null value as empty (not redacted, via the short-circuited && arm)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.payload": null,
      "gen_ai.system": "codex",
    });

    expect(result["prompt.payload"]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
    expect(result["gen_ai.system"]).toBe("codex");
  });

  it("treats a sensitive numeric value as non-empty (redacted) via the final != null fallback", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.length": 42,
    });

    expect(result["prompt.length"]).toBeUndefined();
    expect(result[REDACTED_ATTRIBUTES_KEY]).toEqual(["prompt.length"]);
  });

  it("caps redacted attribute markers at the max redacted count", () => {
    const sensitiveAttributes = Object.fromEntries(
      Array.from(
        { length: CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT + 3 },
        (_, index) => [`prompt.input.${index}`, `secret-${index}`]
      )
    );
    const result = sanitizeCodexOtelAttributes(sensitiveAttributes);

    expect((result[REDACTED_ATTRIBUTES_KEY] as string[]).length).toBe(
      CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT
    );
  });

  it("sorts the redacted attribute markers alphabetically, not by insertion order", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.zebra": "secret-1",
      "prompt.apple": "secret-2",
    });

    expect(result[REDACTED_ATTRIBUTES_KEY]).toEqual([
      "prompt.apple",
      "prompt.zebra",
    ]);
  });

  it("treats an empty string sensitive value as empty (not redacted)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.text": "",
    });

    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
  });

  it("treats a whitespace-only sensitive value as empty after trimming (not redacted)", () => {
    const result = sanitizeCodexOtelAttributes({
      "prompt.text": "   ",
    });

    expect(result[REDACTED_ATTRIBUTES_KEY]).toBeUndefined();
  });
});

describe("sanitizeCodexOtelAttributes: toStorableAttributeValue over allowlisted keys", () => {
  it("stores a null value for an allowlisted key as null (not dropped)", () => {
    const result = sanitizeCodexOtelAttributes({
      "session.id": null,
    });

    expect(result).toHaveProperty("session.id");
    expect(result["session.id"]).toBeNull();
  });

  it("stores a numeric value for an allowlisted key as-is", () => {
    const result = sanitizeCodexOtelAttributes({
      "otel.trace_id": 12_345,
    });

    expect(result["otel.trace_id"]).toBe(12_345);
  });

  it("stores a boolean value for an allowlisted key as-is", () => {
    const result = sanitizeCodexOtelAttributes({
      "otel.span_id": true,
    });

    expect(result["otel.span_id"]).toBe(true);
  });

  it("drops an object value for an allowlisted key (unsupported storable type)", () => {
    const result = sanitizeCodexOtelAttributes({
      "gen_ai.system": { nested: true },
    });

    // Not merely `undefined` when read — genuinely ABSENT. A mutant that
    // widens the `&&` guard to `||` would set `sanitized[key] = undefined`
    // explicitly, which also reads as `undefined` but is a different key
    // presence than never having been set at all.
    expect(Object.hasOwn(result, "gen_ai.system")).toBe(false);
  });

  it("drops a non-allowlisted key even when its value is otherwise storable", () => {
    const result = sanitizeCodexOtelAttributes({
      "custom.unlisted": "a perfectly storable string",
    });

    expect(Object.hasOwn(result, "custom.unlisted")).toBe(false);
  });

  it("truncates an allowlisted string value at the max attribute string length", () => {
    const longValue = "y".repeat(CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH + 6);
    const result = sanitizeCodexOtelAttributes({
      "gen_ai.system": longValue,
    });

    expect((result["gen_ai.system"] as string).length).toBe(
      CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH
    );
  });
});
