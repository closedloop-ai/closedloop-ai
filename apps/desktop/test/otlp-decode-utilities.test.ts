/**
 * @file otlp-decode-utilities.test.ts
 * @description Owner suite for `otlp/decode-utilities.ts`, which had none
 * (ISS-8565). `decodeOtlpAttributes` keys off the OTLP `KeyValue.key` straight
 * off the wire, and built its record on a plain `{}` — so an attribute named
 * `__proto__` hit the inherited setter, created no own key, and was silently
 * dropped. Split into its own file rather than bolted onto a telemetry suite
 * that only imports this module incidentally.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { decodeOtlpAttributes } from "../src/main/otlp/decode-utilities.js";

/** One OTLP `KeyValue` carrying a string, as the wire delivers it. */
function stringAttribute(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

describe("decodeOtlpAttributes", () => {
  test("keeps a __proto__ attribute as a real own key (ISS-8565)", () => {
    const decoded = decodeOtlpAttributes([
      stringAttribute("__proto__", "sentinel"),
      stringAttribute("service.name", "claude-code"),
    ]);

    assert.deepEqual(Object.keys(decoded).sort(), [
      "__proto__",
      "service.name",
    ]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.equal(decoded.__proto__, "sentinel");
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  });

  test("decodes ordinary attributes byte-identically", () => {
    const decoded = decodeOtlpAttributes([
      stringAttribute("b", "2"),
      stringAttribute("a", "1"),
    ]);

    assert.equal(JSON.stringify(decoded), '{"b":"2","a":"1"}');
  });

  test("decodes an ArrayValue with no members as an empty list, not as nothing", () => {
    // proto3 omits an empty repeated field, so `finish_reasons: []` arrives as
    // `arrayValue: {}`. Decoded to `undefined` it is indistinguishable from an
    // AnyValue that held no member at all, and a reader then refuses the
    // whole record over a request that merely reported no reasons.
    const decoded = decodeOtlpAttributes([
      { key: "empty", value: { arrayValue: {} } },
      {
        key: "members",
        value: { arrayValue: { values: [{ stringValue: "a" }] } },
      },
      { key: "nothing", value: {} },
    ]);

    assert.deepEqual(decoded.empty, []);
    assert.deepEqual(decoded.members, ["a"]);
    assert.equal(decoded.nothing, undefined);
    assert.equal("nothing" in decoded, true);
  });

  test("skips an attribute with no key", () => {
    const decoded = decodeOtlpAttributes([
      { value: { stringValue: "orphan" } },
      stringAttribute("kept", "yes"),
    ]);

    assert.deepEqual(Object.keys(decoded), ["kept"]);
  });
});
