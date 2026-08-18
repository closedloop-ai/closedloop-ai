/**
 * @file parse-claude-drift-bounds.test.ts
 * @description The drift collector's inputs are TRANSCRIPT-CONTROLLED, which
 * makes it the one diagnostic in this parser that a hostile or merely broken file
 * can turn into a resource problem. Both keys it retains — the record `type` and
 * every unconsumed object key — come straight from the file, so a transcript with
 * a unique type per line makes a streaming parse hold one map entry per line.
 *
 * Three contracts, each raised in review against this branch:
 *   - a parse with no reporter retains NOTHING, rather than collecting and
 *     discarding (the cloud renderer has no logger by design, so it would have
 *     paid the whole cost for no signal);
 *   - retention is capped, and the report says when a cap truncated it;
 *   - names are escaped and bounded before they reach a log line, because JSON
 *     permits a newline inside a key and an unescaped one forges a second entry.
 */
import { describe, expect, it } from "vitest";
import { createSessionAccumulator } from "./parse-claude-accumulator";
import { scanTranscriptLines } from "./parse-claude-core";
import { reportUnknownRecords } from "./parse-claude-drift";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

const unknownRecord = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, timestamp: "2026-07-09T12:00:01.000Z", ...extra });

async function reportFor(
  lines: string[],
  collectDiagnostics: boolean
): Promise<{ messages: string[]; typeCount: number; attributeCount: number }> {
  const messages: string[] = [];
  const accumulator = createSessionAccumulator({ collectDiagnostics });
  await scanTranscriptLines([USER_LINE, ...lines], accumulator);
  reportUnknownRecords(accumulator, (message) => messages.push(message));
  return {
    messages,
    typeCount: accumulator.unknownRecordTypes.size,
    attributeCount: [...accumulator.unknownAttributes.values()].reduce(
      (total, set) => total + set.size,
      0
    ),
  };
}

describe("the drift collector retains nothing without a reporter", () => {
  it("holds no state for a transcript full of distinct unknown record types", async () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      unknownRecord(`novel-type-${i}`)
    );

    const off = await reportFor(lines, false);
    expect(off.typeCount).toBe(0);
    expect(off.messages).toEqual([]);

    // The paired control: the same input WITH a sink does retain and report, so
    // the zero above is the opt-out working rather than the scan being broken.
    const on = await reportFor(lines, true);
    expect(on.typeCount).toBeGreaterThan(0);
    expect(on.messages.length).toBeGreaterThan(0);
  });

  it("holds no attribute state either", async () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      unknownRecord("ai-title", { aiTitle: "t", [`novelField${i}`]: 1 })
    );

    expect((await reportFor(lines, false)).attributeCount).toBe(0);
    expect((await reportFor(lines, true)).attributeCount).toBeGreaterThan(0);
  });
});

describe("retention is capped and the report admits it", () => {
  it("caps distinct record types and counts what it refused", async () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      unknownRecord(`novel-type-${i}`)
    );

    const { messages, typeCount } = await reportFor(lines, true);

    expect(typeCount).toBe(50);
    const line = messages.find((m) => m.startsWith("Unknown record types:"));
    // 200 records, 50 distinct retained — the rest are refused and counted, so
    // the operator can tell a truncated report from a complete one.
    expect(line).toContain("150 record(s) past the 50-type cap");
  });

  it("caps attributes per record type and counts what it refused", async () => {
    const lines = Array.from({ length: 120 }, (_, i) =>
      unknownRecord("ai-title", { aiTitle: "t", [`novelField${i}`]: 1 })
    );

    const { messages, attributeCount } = await reportFor(lines, true);

    expect(attributeCount).toBe(50);
    const line = messages.find((m) => m.includes("Unknown attributes"));
    expect(line).toContain("past the 50-attribute cap");
  });

  it("says nothing about a cap when nothing was refused", async () => {
    const { messages } = await reportFor([unknownRecord("just-one")], true);
    const line = messages.find((m) => m.startsWith("Unknown record types:"));
    expect(line).toBe("Unknown record types: just-one (1)");
  });

  it("does not count a repeat of an already-retained attribute as refused", async () => {
    // The overflow tally must increment only where its precondition held. Sixty
    // distinct fields means ten are genuinely refused; repeating one that was
    // already retained must not inflate that to thirty, or the operator reads a
    // truncation that never happened.
    const distinct = Array.from({ length: 60 }, (_, i) =>
      unknownRecord("ai-title", { aiTitle: "t", [`novelField${i}`]: 1 })
    );
    const repeats = Array.from({ length: 20 }, () =>
      unknownRecord("ai-title", { aiTitle: "t", novelField0: 1 })
    );

    const { messages } = await reportFor([...distinct, ...repeats], true);

    const line = messages.find((m) => m.includes("Unknown attributes"));
    expect(line).toContain("(+10 past the 50-attribute cap)");
  });

  it("bounds the whole report line, not only each name", async () => {
    // Fifty retained names, each under the per-name ceiling, still compose a
    // message far past the line ceiling — the two caps are independent.
    const lines = Array.from({ length: 50 }, (_, i) =>
      unknownRecord("ai-title", {
        aiTitle: "t",
        [`field${String(i).padStart(2, "0")}${"z".repeat(60)}`]: 1,
      })
    );

    const { messages } = await reportFor(lines, true);

    const line = messages.find((m) => m.includes("Unknown attributes"));
    expect(line).toContain("chars truncated)");
    expect(line?.length).toBeLessThan(2100);
  });
});

describe("transcript-controlled names cannot forge a log entry", () => {
  it("escapes a newline in a record type instead of emitting a second line", async () => {
    const forged = "evil\nUnknown record types: fabricated (99)";

    const { messages } = await reportFor([unknownRecord(forged)], true);

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("\n");
    expect(messages[0]).toContain("evil\\x0a");
  });

  it("escapes control characters in an attribute name", async () => {
    const { messages } = await reportFor(
      [unknownRecord("ai-title", { aiTitle: "t", "bad\r\tname": 1 })],
      true
    );

    const line = messages.find((m) => m.includes("Unknown attributes"));
    expect(line).toContain("bad\\x0d\\x09name");
    expect(line).not.toContain("\r");
  });

  it("truncates an oversized name and says exactly how much it dropped", async () => {
    const huge = `x${"y".repeat(500)}`;

    const { messages } = await reportFor([unknownRecord(huge)], true);

    const line = messages.find((m) => m.startsWith("Unknown record types:"));
    // 501 characters, 120 kept — the remainder is stated rather than approximated,
    // so a wrong ceiling or a sign error cannot pass as "some truncation happened".
    expect(line).toContain("(+381 chars)");
    expect(line).toContain(`x${"y".repeat(119)}…`);
  });

  it("still reports when the caller collected but passes no logger", async () => {
    // Collection and reporting are separate switches: a caller may retain
    // diagnostics and then hand `reportUnknownRecords` no sink. That must be a
    // silent no-op rather than a call through an undefined logger.
    const accumulator = createSessionAccumulator({ collectDiagnostics: true });
    await scanTranscriptLines([USER_LINE, unknownRecord("novel")], accumulator);

    expect(() => reportUnknownRecords(accumulator)).not.toThrow();
  });
});
