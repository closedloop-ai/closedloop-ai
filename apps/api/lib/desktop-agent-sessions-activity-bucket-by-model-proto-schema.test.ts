import { describe, expect, it } from "vitest";
import { z } from "zod";
import { activityBucketSchema } from "./desktop-agent-sessions-schema";

/**
 * ISS-10178. `byModel` sits on the cloud session-sync INGEST boundary, and its
 * keys are model names lifted from parsed agent transcripts — an untrusted key
 * source. `z.record` validates an own `__proto__` entry and then assigns it onto
 * a plain `{}`, where the inherited setter swallows the write: no own key, no
 * issue, `success: true`. That deletes the bucket's whole spend for that model.
 *
 * The defect is a SILENT DROP, so "did not throw" and "success" are both false
 * greens. Every case asserts on the KEY SET or a total derived from it.
 *
 * Fixture trap: a quoted `"__proto__"` in an object LITERAL is the
 * prototype-setter form and creates no own key, so a literal fixture would drop
 * the key before the schema saw it. These build it with `JSON.parse`, which
 * DEFINES it — exactly as the sync wire does.
 */
function parseWire(json: string): unknown {
  return JSON.parse(json);
}

const BY_MODEL_VALUE = z.object({
  cIn: z.number().finite().nonnegative(),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
});

function bucketWire(byModelJson: string): string {
  return `{"label":"bucket-1","cIn":1,"cOut":2,"cCache":3,"total":4,"toolStart":0,"tl0":null,"byModel":${byModelJson}}`;
}

const HOSTILE_BY_MODEL =
  '{"__proto__":{"cIn":1000,"cOut":500,"cCache":0},"gpt-5":{"cIn":7,"cOut":3,"cCache":1}}';

describe("activityBucketSchema.byModel", () => {
  it("keeps a __proto__ model entry that z.record silently deletes", () => {
    const raw = parseWire(bucketWire(HOSTILE_BY_MODEL));

    // The control: the validator being replaced really does drop the entry and
    // report success while doing it. Without this the case below could pass on
    // a schema that never had the bug.
    const stock = z
      .record(z.string().trim().min(1), BY_MODEL_VALUE)
      .parse(parseWire(HOSTILE_BY_MODEL));
    expect(Object.keys(stock)).toEqual(["gpt-5"]);

    const bucket = activityBucketSchema.parse(raw);

    expect(Object.keys(bucket.byModel).sort()).toEqual(["__proto__", "gpt-5"]);
    // The 1500 tokens of spend the drop was destroying.
    expect(
      Object.values(bucket.byModel).reduce(
        (total, entry) => total + entry.cIn + entry.cOut,
        0
      )
    ).toBe(1510);
  });

  it("folds a valid bucket byte-identically, key order included", () => {
    const byModel =
      '{"gpt-5":{"cIn":1,"cOut":2,"cCache":3},"claude":{"cIn":4,"cOut":5,"cCache":6}}';

    const bucket = activityBucketSchema.parse(parseWire(bucketWire(byModel)));

    // ISS-8565's constraint: only the corrupt key is redirected, so a valid
    // transcript must fold untouched. Key ORDER is part of that — asserting the
    // values alone would pass on a fold that reordered the map.
    expect(Object.keys(bucket.byModel)).toEqual(["gpt-5", "claude"]);
    expect(bucket.byModel).toEqual(parseWire(byModel));
    expect(Object.getPrototypeOf(bucket.byModel)).toBe(Object.prototype);
  });

  it("still enforces the non-blank key bound the swap had to preserve", () => {
    // `z.record(z.string().trim().min(1), …)` carried this bound. A swap that
    // dropped it would trade one silent defect for another, so it is pinned
    // here rather than assumed from the call site.
    const result = activityBucketSchema.safeParse(
      parseWire(bucketWire('{"   ":{"cIn":1,"cOut":2,"cCache":3}}'))
    );

    expect(result.success).toBe(false);
  });

  it("still enforces the value bounds under the hostile key", () => {
    // Preserving the key must not smuggle an unvalidated value through.
    const result = activityBucketSchema.safeParse(
      parseWire(bucketWire('{"__proto__":{"cIn":-1,"cOut":2,"cCache":3}}'))
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([
      "byModel",
      "__proto__",
      "cIn",
    ]);
  });
});
