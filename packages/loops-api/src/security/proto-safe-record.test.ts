import { describe, expect, it } from "vitest";
import { z } from "zod";
import { protoSafeRecord } from "./proto-safe-record";

/**
 * ISS-8565. The defect these cases pin is a SILENT DROP, so "does not throw" and
 * "parse succeeded" are both false greens — `z.record` already does both today
 * while deleting the entry. Every case below asserts on the KEY SET.
 *
 * Fixture trap: a quoted `"__proto__"` in an object LITERAL is the
 * prototype-setter form and creates no own key, so a literal fixture would drop
 * the key before the schema ever saw it. These build the key with `JSON.parse`
 * (which DEFINES it, exactly as the real worker/wire boundary does) or with a
 * computed key on a null-prototype container.
 */

const countsSchema = z.object({ input: z.number(), output: z.number() });
const tokensByModelSchema = protoSafeRecord(z.string().max(200), countsSchema);

function parseHostileRecord(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

describe("protoSafeRecord", () => {
  it("keeps a __proto__ entry that z.record silently deletes", () => {
    const raw = parseHostileRecord(
      '{"__proto__":{"input":1000,"output":500},"gpt-5":{"input":7,"output":3}}'
    );

    // The control: the stock validator this replaces loses the entry outright,
    // and reports success while doing it. Without this the case below could
    // pass on a schema that never had the bug.
    const stock = z.record(z.string(), countsSchema).parse(raw);
    expect(Object.keys(stock)).toEqual(["gpt-5"]);

    const safe = tokensByModelSchema.parse(raw);

    expect(Object.keys(safe).sort()).toEqual(["__proto__", "gpt-5"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    expect(safe.__proto__).toEqual({ input: 1000, output: 500 });
    // The 1500 tokens the drop was destroying.
    expect(
      Object.values(safe).reduce((total, counts) => total + counts.input, 0)
    ).toBe(1007);
  });

  it("hands back a normally-prototyped object, not a null-prototype one", () => {
    const safe = tokensByModelSchema.parse(
      parseHostileRecord('{"__proto__":{"input":1,"output":2}}')
    );

    // Consumers spread, `JSON.stringify`, and call `Object.hasOwn` on this. A
    // null-prototype escape hatch would preserve the key and break all three.
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    expect(JSON.parse(JSON.stringify(safe)).__proto__).toEqual({
      input: 1,
      output: 2,
    });
  });

  it("folds a valid model byte-identically, including key order", () => {
    const raw = parseHostileRecord(
      '{"gpt-5":{"input":1,"output":2},"claude":{"input":3,"output":4}}'
    );

    const safe = tokensByModelSchema.parse(raw);

    // The ticket's constraint: only the corrupt key is redirected. A valid
    // transcript must be untouched, and key ORDER is part of that — asserting
    // the values alone would pass on a fold that reordered the map.
    expect(Object.keys(safe)).toEqual(["gpt-5", "claude"]);
    expect(safe).toEqual(raw);
  });

  it("keeps a __proto__-lookalike key distinct from the real one", () => {
    const raw = parseHostileRecord(
      '{"__proto__":{"input":1,"output":1},"__proto__~":{"input":2,"output":2}}'
    );

    const safe = tokensByModelSchema.parse(raw);

    // Guards the shape this codec deliberately does NOT have: an earlier draft
    // carried the hostile key past `z.record` by renaming it, which put it one
    // collision away from silently swapping these two entries.
    expect(Object.keys(safe).sort()).toEqual(["__proto__", "__proto__~"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    expect(safe.__proto__).toEqual({ input: 1, output: 1 });
    expect(safe["__proto__~"]).toEqual({ input: 2, output: 2 });
  });

  it("still rejects a bad value under the hostile key, with its path", () => {
    const result = tokensByModelSchema.safeParse(
      parseHostileRecord('{"__proto__":{"input":"nope","output":500}}')
    );

    // Preserving the key must not smuggle an unvalidated value through. The
    // path is asserted, not just the failure: it must name the key as the
    // producer spelled it, or a reader chasing the rejection lands on a key
    // that does not exist on the wire.
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["__proto__", "input"]);
  });

  it("rejects an over-length key with its path (ISS-8990)", () => {
    const schema = protoSafeRecord(z.string().max(4), countsSchema);
    const result = schema.safeParse(
      parseHostileRecord('{"gpt-5-turbo":{"input":9,"output":1}}')
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["gpt-5-turbo"]);
  });

  it("stays required on the object it is a property of", () => {
    // `z.unknown()` accepts ABSENCE, so a codec built on it would silently turn
    // every `tokensByModel` property optional across the boundary schemas.
    const envelope = z.object({ tokensByModel: tokensByModelSchema }).strict();

    expect(envelope.safeParse({}).success).toBe(false);
  });

  it("rejects a non-record where z.record would", () => {
    expect(tokensByModelSchema.safeParse(null).success).toBe(false);
    expect(tokensByModelSchema.safeParse([]).success).toBe(false);
    expect(tokensByModelSchema.safeParse("gpt-5").success).toBe(false);
  });

  it.each([
    ["Date", new Date()],
    ["Map", new Map([["gpt-5", { input: 1, output: 2 }]])],
    ["Set", new Set(["gpt-5"])],
  ])("rejects a %s instead of folding it to an empty map", (_label, input) => {
    // The failure this pins is NOT a throw. Each of these reports zero own
    // enumerable keys, so a `typeof === "object"` gate walks the entry loop
    // zero times and returns `{}` with `success: true` — a confident "this
    // session spent no tokens" replacing the rejection `z.record` gave. The
    // worker hop is `child.postMessage` structured clone, which carries all
    // three across intact, so this is reachable and not a JSON-wire
    // impossibility.
    const stock = z.record(z.string(), countsSchema).safeParse(input);
    expect(stock.success).toBe(false);

    const result = tokensByModelSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });

  it("names what it received, so a worker rejection stays triageable", () => {
    // `summarizeHistoricalWorkerResponseIssues` renders `path:code:message`, so
    // the received half has to live in the message or it is not rendered at
    // all. Asserting only `success === false` would pass on "Expected an
    // object", which tells a triager nothing about what actually arrived.
    const result = tokensByModelSchema.safeParse(new Date());

    expect(result.error?.issues[0]?.message).toBe(
      "Expected a plain object, received Date"
    );
  });

  it("still accepts the null-prototype container the builders produce", () => {
    // The gate rejects foreign prototypes, and a null prototype must not be
    // caught by that: it is the shape every ISS-8565 fold hands over.
    const raw: Record<string, unknown> = Object.create(null);
    // A computed key, not a literal: on a null-prototype container the literal
    // form would DEFINE too, but the variable is what the real producers use
    // and it keeps the fixture honest if this container ever changes shape.
    const hostileKey = "__proto__";
    raw[hostileKey] = { input: 4, output: 6 };

    const safe = tokensByModelSchema.parse(raw);

    expect(Object.keys(safe)).toEqual(["__proto__"]);
  });
});
