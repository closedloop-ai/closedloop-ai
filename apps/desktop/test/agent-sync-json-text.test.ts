import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  parseJsonObjectText,
  parseJsonValueText,
} from "../src/main/agent-sync/agent-sync-json-text.js";

describe("agent sync JSON text parsing", () => {
  test("treats missing and blank storage values as absent", () => {
    assert.equal(parseJsonValueText(null), null);
    assert.equal(parseJsonValueText(""), null);
    assert.equal(parseJsonValueText("   \n"), null);
  });

  test("parses every JSON scalar without throwing", () => {
    assert.equal(parseJsonValueText('"value"'), "value");
    assert.equal(parseJsonValueText("true"), true);
    assert.equal(parseJsonValueText("42"), 42);
    assert.equal(parseJsonValueText("null"), null);
  });

  test("normalizes nested objects and arrays to the sync contract", () => {
    assert.deepEqual(
      parseJsonValueText(
        '{"keep":1,"drop":null,"nested":[true,null,{"value":"ok"}]}'
      ),
      { keep: 1, nested: [true, null, { value: "ok" }] }
    );
  });

  test("preserves malformed JSON as its raw storage string", () => {
    assert.equal(parseJsonValueText("{not-json"), "{not-json");
  });

  test("accepts only non-array objects on the object surface", () => {
    assert.deepEqual(parseJsonObjectText('{"value":1}'), { value: 1 });
    assert.equal(parseJsonObjectText("[1,2]"), null);
    assert.equal(parseJsonObjectText('"value"'), null);
    assert.equal(parseJsonObjectText("null"), null);
  });
});

/**
 * ISS-8565: the sync payload's JSON normalizer rebuilt every object on a plain
 * `{}`, so a `__proto__` key that `JSON.parse` had delivered as a real own key
 * was silently dropped on its way to the cloud.
 */
describe("agent sync JSON text keeps a __proto__ key (ISS-8565)", () => {
  test("keeps it as an own key through normalization", () => {
    const parsed = parseJsonObjectText('{"__proto__":{"a":1},"normal":"v"}');

    assert.ok(parsed);
    assert.deepEqual(Object.keys(parsed).sort(), ["__proto__", "normal"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.deepEqual(parsed.__proto__, { a: 1 });
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  });

  test("an ordinary object still normalizes byte-identically", () => {
    assert.equal(
      JSON.stringify(parseJsonObjectText('{"b":2,"a":"x"}')),
      '{"b":2,"a":"x"}'
    );
  });
});
