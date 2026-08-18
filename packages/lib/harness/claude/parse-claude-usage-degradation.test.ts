/**
 * ISS-6733: the degradation contracts in `parse-claude.ts` — the paths that decide
 * whether a bad record is DROPPED or silently turned into a believable number.
 *
 * Mutation testing put this file at 62.20%, the lowest in the claude parser, and
 * named the gaps precisely rather than generally:
 *
 *   - `parseJsonValue` had NO covering test at all: deleting its body, its
 *     `try`, or its `catch` changed nothing any test could see.
 *   - `isoTs`'s string and unrepresentable-number branches survived `if (true)`,
 *     i.e. the guards added to make it total were themselves unguarded.
 *   - `extractDedupedUsage`'s skip condition survived `if (false)` AND `if (true)`
 *     — a filter that can be disabled entirely without a failing test. The
 *     end-to-end `parseClaudeTranscript` tests exercise the `<synthetic>` case but
 *     do not pin THIS decision, which is what a unit assertion is for.
 *
 * These are all "quiet wrong number" paths, not crash paths: the failure they
 * prevent is a plausible token total or a record sorting before every real one.
 */
import { describe, expect, it } from "vitest";
import { extractDedupedUsage, isoTs, parseJsonValue } from "./parse-claude";

function usageEntry(
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): { entry: Record<string, unknown>; iso: string | null } {
  return {
    entry: { uuid: "u-1", requestId: "req-1", message, ...extra },
    iso: "2026-07-09T12:00:00.000Z",
  };
}

const VALID_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("parseJsonValue", () => {
  it("parses valid JSON of every shape the transcript carries", () => {
    expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonValue("[1,2]")).toEqual([1, 2]);
    expect(parseJsonValue('"s"')).toBe("s");
    expect(parseJsonValue("null")).toBeNull();
  });

  it("returns undefined rather than throwing on malformed JSON", () => {
    // The contract that matters: a corrupt tool payload must not abort the parse
    // of everything around it. `undefined` is how this function says "unreadable".
    expect(parseJsonValue("{not json")).toBeUndefined();
    expect(parseJsonValue("")).toBeUndefined();
  });

  it("distinguishes a parsed null from an unreadable value", () => {
    // Both are falsy; only one means the input was broken. A caller branching on
    // `=== undefined` depends on these not collapsing.
    expect(parseJsonValue("null")).toBeNull();
    expect(parseJsonValue("nul")).toBeUndefined();
  });
});

describe("isoTs", () => {
  it("passes a non-empty string through verbatim", () => {
    expect(isoTs("2026-07-09T12:00:00.000Z")).toBe("2026-07-09T12:00:00.000Z");
    expect(isoTs("not-a-date")).toBe("not-a-date");
  });

  it("treats an empty string as absent, not as a timestamp", () => {
    // A record stamped "" sorted before every real one, and `??` kept it while
    // `||` replaced it — the same absent value behaving differently by operator.
    expect(isoTs("")).toBeNull();
  });

  it("returns null for a number no Date can represent", () => {
    // `toISOString` THROWS for these. One such record used to abort the whole
    // scan, which desktop retried every pass and the cloud showed as blank.
    expect(isoTs(Number.NaN)).toBeNull();
    expect(isoTs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(isoTs(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(isoTs(8.64e15 + 1)).toBeNull();
  });

  it("still converts a representable epoch, including the boundary", () => {
    expect(isoTs(8.64e15)).toBe("+275760-09-13T00:00:00.000Z");
    expect(isoTs(-1)).toBe("1969-12-31T23:59:59.999Z");
  });

  it("returns null for anything that is not a timestamp", () => {
    // A timestamp is an epoch number or a string. Everything else is an unknown
    // stamp, and null is how this function says that — the same answer whatever
    // the wrong shape happens to be, so no caller has to enumerate them.
    expect(isoTs(true)).toBeNull();
    expect(isoTs({ at: "2026-01-01" })).toBeNull();
    expect(isoTs([])).toBeNull();
    expect(isoTs(["2026-01-01"])).toBeNull();
  });
});

describe("extractDedupedUsage — which records are skipped", () => {
  it("records a usage line that carries a real model and a usage block", () => {
    // Control: without this, every assertion below passes for the wrong reason.
    const map = extractDedupedUsage([
      usageEntry({ model: "claude-opus-4", usage: VALID_USAGE }),
    ]);
    expect(map.size).toBe(1);
  });

  it("skips an entry whose model is absent or not a string", () => {
    expect(extractDedupedUsage([usageEntry({ usage: VALID_USAGE })]).size).toBe(
      0
    );
    expect(
      extractDedupedUsage([usageEntry({ model: 7, usage: VALID_USAGE })]).size
    ).toBe(0);
  });

  it("skips a <synthetic> model", () => {
    // Synthetic turns are vendor-generated and carry no billable usage; counting
    // them inflates every token total that reads this map.
    expect(
      extractDedupedUsage([
        usageEntry({ model: "<synthetic>", usage: VALID_USAGE }),
      ]).size
    ).toBe(0);
  });

  it("skips an entry with no usage block", () => {
    expect(
      extractDedupedUsage([usageEntry({ model: "claude-opus-4" })]).size
    ).toBe(0);
  });

  it("drops only the offending line when a counter fails the storage contract", () => {
    // Graceful degradation: a fractional/negative/unsafe counter drops THIS
    // line's usage and keeps parsing. Aborting would blank the whole transcript
    // over one bad snapshot.
    const map = extractDedupedUsage([
      usageEntry(
        {
          model: "claude-opus-4",
          usage: { ...VALID_USAGE, input_tokens: 1.5 },
        },
        { uuid: "u-bad", requestId: "req-bad" }
      ),
      usageEntry({ model: "claude-opus-4", usage: VALID_USAGE }),
    ]);
    expect(map.size).toBe(1);
  });

  it("keeps a negative counter out of the map rather than storing it", () => {
    const map = extractDedupedUsage([
      usageEntry({
        model: "claude-opus-4",
        usage: { ...VALID_USAGE, output_tokens: -1 },
      }),
    ]);
    expect(map.size).toBe(0);
  });
});
