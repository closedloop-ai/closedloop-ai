/**
 * @file parse-claude-metadata.test.ts
 * @description The `system` record decode, which is a GATE rather than a
 * transform: the runtime writes many subtypes here and exactly one of them
 * carries a fact this parser keeps.
 *
 * `durationMs` is a documented attribute of the record TYPE, not of the
 * `turn_duration` subtype — so a system record of any other subtype may legally
 * carry one. Reading it without checking the subtype would mint turn durations
 * out of whatever else the runtime happens to time, and every downstream
 * average would move. The non-finite arm lives with the other nonsensical
 * numbers in the rewrite-regressions suite.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

const systemLine = (payload: Record<string, unknown>) =>
  JSON.stringify({
    type: "system",
    timestamp: "2026-07-09T12:00:01.000Z",
    ...payload,
  });

describe("only a turn_duration system record becomes a turn duration", () => {
  it("records the measured duration of a turn_duration record", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, systemLine({ subtype: "turn_duration", durationMs: 1234 })],
      { sessionId: "system-record" }
    );
    expect(session?.turnDurations).toEqual([
      { durationMs: 1234, timestamp: "2026-07-09T12:00:01.000Z" },
    ]);
  });

  it("ignores a timed system record of another subtype", async () => {
    // The control for the case above: same record type, same numeric field,
    // different subtype. Without the subtype gate this is indistinguishable
    // from a measured turn.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        systemLine({ subtype: "compact_boundary", durationMs: 5678 }),
      ],
      { sessionId: "system-record" }
    );
    expect(session?.turnDurations).toEqual([]);
  });

  it("ignores a turn_duration record whose duration is not a number", async () => {
    // The harness has written this field as a string before. Admitting it puts
    // a string into a field typed `number`, and the arithmetic downstream
    // silently concatenates instead of adding.
    const session = await parseClaudeTranscript(
      [USER_LINE, systemLine({ subtype: "turn_duration", durationMs: "1234" })],
      { sessionId: "system-record" }
    );
    expect(session?.turnDurations).toEqual([]);
  });

  it("ignores a turn_duration record carrying no duration at all", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, systemLine({ subtype: "turn_duration" })],
      { sessionId: "system-record" }
    );
    expect(session?.turnDurations).toEqual([]);
  });
});
