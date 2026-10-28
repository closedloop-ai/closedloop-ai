/**
 * @file parse-claude-unreadable-timestamps.test.ts
 * @description ISS-6738 (whitlockk review): a record whose `timestamp` carries a
 * NON-EMPTY value no `Date` can read must be reported, not dropped in silence.
 *
 * The silence is what costs something. A transcript with no usable timestamp
 * anywhere is not importable as a session — `parseClaudeTranscript` returns null
 * — so the pass reports zero sessions, the catchup cache marks the file seen,
 * and the orphan self-heal readmits it because no session row exists. That is an
 * unbounded rework loop whose only outward sign is a file that never imports, and
 * it looks exactly like an empty transcript.
 *
 * Before ISS-6738 the Claude path had its own normalizer that echoed unparseable
 * text back, so `startedAt` was truthy and such a session still imported (with a
 * garbage timestamp). Collapsing to one `toIso` routes that input into the drop
 * for the first time, which is why the signal belongs in the same change.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript, scanTranscriptLines } from "./parse-claude";
import { createSessionAccumulator } from "./parse-claude-accumulator";
import { reportUnknownRecords } from "./parse-claude-drift";

const READABLE_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

const unreadableLine = (timestamp: unknown) =>
  JSON.stringify({
    type: "user",
    timestamp,
    cwd: "/workspace/project",
    message: { role: "user", content: "go" },
  });

async function report(lines: string[]): Promise<string[]> {
  const messages: string[] = [];
  const accumulator = createSessionAccumulator({ collectDiagnostics: true });
  await scanTranscriptLines(lines, accumulator);
  reportUnknownRecords(accumulator, (message) => messages.push(message));
  return messages;
}

describe("unreadable Claude timestamps are reported (ISS-6738)", () => {
  it("counts a non-empty unreadable stamp among readable ones", async () => {
    const messages = await report([
      READABLE_LINE,
      unreadableLine("not-a-date"),
      unreadableLine("also-not-a-date"),
    ]);

    const line = messages.find((message) =>
      message.startsWith("Unreadable timestamps:")
    );
    expect(line).toBe("Unreadable timestamps: 2 record(s)");
  });

  it("says so when NO timestamp survived, because the whole import is lost", async () => {
    // The case the loop turns on: the session cannot be built at all, so the
    // report is the only trace the transcript was ever seen.
    const messages = await report([unreadableLine("not-a-date")]);

    const line = messages.find((message) =>
      message.startsWith("Unreadable timestamps:")
    );
    expect(line).toContain("1 record(s)");
    expect(line).toContain("NO timestamp survived");
  });

  it("stays silent when every timestamp reads", async () => {
    // The report is a drift signal, so a healthy transcript must not emit one —
    // otherwise the line is noise and stops being read.
    const messages = await report([READABLE_LINE]);
    expect(
      messages.some((message) => message.startsWith("Unreadable timestamps:"))
    ).toBe(false);
  });

  it("does not count a record that simply carries NO timestamp", async () => {
    // Absent is not malformed. Counting it would fire the signal on ordinary
    // records that never carried one, which is how a diagnostic becomes ignored.
    const noTimestamp = JSON.stringify({
      type: "user",
      cwd: "/workspace/project",
      message: { role: "user", content: "go" },
    });
    const messages = await report([READABLE_LINE, noTimestamp]);
    expect(
      messages.some((message) => message.startsWith("Unreadable timestamps:"))
    ).toBe(false);
  });

  it("the all-unreadable transcript really does yield no session", async () => {
    // Pins the consequence the report describes, not just the wording: if this
    // ever starts returning a session, the "whole import is lost" half of the
    // message above is wrong and the loop it warns about no longer exists.
    const session = await parseClaudeTranscript(
      [unreadableLine("not-a-date")],
      { sessionId: "s-unreadable" }
    );
    expect(session).toBeNull();
  });
});
