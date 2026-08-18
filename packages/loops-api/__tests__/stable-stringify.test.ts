import { describe, expect, it } from "vitest";

import { stableStringify } from "../src/stable-stringify";

/**
 * `stableStringify` is the canonical serializer behind desktop command
 * signatures (`apps/app/lib/desktop-command-signing/command-signer.ts` hashes
 * its output; `apps/desktop` verifies against the same bytes) and behind
 * token-event identity hashes. Byte-identical output across browser, Electron
 * main, and API is the contract — a divergence silently invalidates every
 * signature, so the ordering and value-coercion branches are pinned here
 * directly rather than only through their callers.
 */
describe("stableStringify", () => {
  it("serializes object keys in sorted order regardless of insertion order", () => {
    const insertedOneOrder = stableStringify({ b: 1, a: 2, c: 3 });
    const insertedOtherOrder = stableStringify({ c: 3, a: 2, b: 1 });

    expect(insertedOneOrder).toBe('{"a":2,"b":1,"c":3}');
    expect(insertedOtherOrder).toBe(insertedOneOrder);
  });

  it("sorts keys at every nesting depth", () => {
    expect(stableStringify({ outer: { z: { y: 1, x: 2 }, a: 3 } })).toBe(
      '{"outer":{"a":3,"z":{"x":2,"y":1}}}'
    );
  });

  it("preserves array order while sorting the keys of array members", () => {
    expect(
      stableStringify([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ])
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it("serializes null and undefined identically as null", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("null");
  });

  it("collapses an undefined property value to null instead of dropping the key", () => {
    // JSON.stringify would omit `b` entirely; the signer must keep the key so
    // an absent-vs-null payload difference cannot forge a matching digest.
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1,"b":null}');
  });

  it("serializes primitives through JSON.stringify semantics", () => {
    expect(stableStringify("hi")).toBe('"hi"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify(false)).toBe("false");
  });

  it("escapes quotes and control characters inside strings and keys", () => {
    expect(stableStringify({ 'a"b': "c\nd" })).toBe('{"a\\"b":"c\\nd"}');
  });

  it("serializes empty objects and empty arrays", () => {
    expect(stableStringify({})).toBe("{}");
    expect(stableStringify([])).toBe("[]");
  });

  it("coerces non-JSON values to their string form", () => {
    // `typeof value === "object"` is false for these, so they fall through to
    // the String() branch rather than throwing or emitting undefined.
    expect(stableStringify(Symbol.for("cmd"))).toBe('"Symbol(cmd)"');
    expect(stableStringify(10n)).toBe('"10"');
  });

  it("produces identical output for structurally equal payloads built differently", () => {
    const built: Record<string, unknown> = {};
    built.nested = { second: [1, 2], first: "x" };
    built.id = "cmd-1";

    expect(stableStringify(built)).toBe(
      stableStringify({
        id: "cmd-1",
        nested: { first: "x", second: [1, 2] },
      })
    );
  });
});
