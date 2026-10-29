import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OPENCODE_MATERIALIZED_SCHEMA_VERSION,
  OpencodeMaterializedRecordKind,
  opencodeSessionRecordSchema,
} from "./opencode-materialized-record";

/**
 * ISS-10178. `tokensByModel` is the session-level token aggregate the OpenCode
 * parser cannot re-derive from the child records, and its keys are model names
 * read out of a foreign transcript store — an untrusted key source. `z.record`
 * validates an own `__proto__` entry and then assigns it onto a plain `{}`,
 * where the inherited setter swallows the write: no own key, no issue,
 * `success: true`, and the session loses that model's whole spend.
 *
 * The defect is a SILENT DROP, so "did not throw" and "success" are both false
 * greens. Every case asserts on the KEY SET or a total derived from it.
 *
 * Fixture trap: a quoted `"__proto__"` in an object LITERAL is the
 * prototype-setter form and creates no own key, so a literal fixture would drop
 * the key before the schema saw it. These build it with `JSON.parse` — which
 * DEFINES it, and is exactly how the materialized JSONL line is read back.
 */
const TOKEN_COUNTS_VALUE = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});

function sessionLine(tokensByModelJson: string): unknown {
  return JSON.parse(
    `{"t":"${OpencodeMaterializedRecordKind.Session}","v":${OPENCODE_MATERIALIZED_SCHEMA_VERSION},"sessionId":"s1","name":"session","cwd":null,"model":null,"version":null,"slug":null,"startedAt":null,"endedAt":null,"userMessages":1,"assistantMessages":1,"thinkingBlockCount":0,"permissionMode":null,"entrypoint":"cli","fileModifiedAt":null,"tokensByModel":${tokensByModelJson},"messageTimestamps":[],"diffStats":null}`
  );
}

const HOSTILE =
  '{"__proto__":{"input":1000,"output":500,"cacheRead":0,"cacheWrite":0},"gpt-5":{"input":7,"output":3,"cacheRead":0,"cacheWrite":0}}';

describe("opencodeSessionRecordSchema.tokensByModel", () => {
  it("keeps a __proto__ model entry that z.record silently deletes", () => {
    // The control: the validator being replaced really does drop the entry and
    // report success while doing it.
    const stock = z
      .record(z.string(), TOKEN_COUNTS_VALUE)
      .parse(JSON.parse(HOSTILE));
    expect(Object.keys(stock)).toEqual(["gpt-5"]);

    const record = opencodeSessionRecordSchema.parse(sessionLine(HOSTILE));

    expect(Object.keys(record.tokensByModel).sort()).toEqual([
      "__proto__",
      "gpt-5",
    ]);
    // The 1500 tokens of spend the drop was destroying.
    expect(
      Object.values(record.tokensByModel).reduce(
        (total, counts) => total + counts.input + counts.output,
        0
      )
    ).toBe(1510);
  });

  it("folds a valid session byte-identically, key order included", () => {
    const tokens =
      '{"gpt-5":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4},"claude":{"input":5,"output":6,"cacheRead":7,"cacheWrite":8}}';

    const record = opencodeSessionRecordSchema.parse(sessionLine(tokens));

    // ISS-8565's constraint: a valid transcript folds untouched, key ORDER
    // included — asserting values alone would pass on a fold that reordered.
    expect(Object.keys(record.tokensByModel)).toEqual(["gpt-5", "claude"]);
    expect(record.tokensByModel).toEqual(JSON.parse(tokens));
    expect(Object.getPrototypeOf(record.tokensByModel)).toBe(Object.prototype);
  });

  it("still rejects a bad value under the hostile key, with its path", () => {
    // Preserving the key must not smuggle an unvalidated value through.
    const result = opencodeSessionRecordSchema.safeParse(
      sessionLine(
        '{"__proto__":{"input":"nope","output":500,"cacheRead":0,"cacheWrite":0}}'
      )
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([
      "tokensByModel",
      "__proto__",
      "input",
    ]);
  });
});
