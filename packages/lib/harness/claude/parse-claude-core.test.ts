/**
 * @file parse-claude-core.test.ts
 * @description The core's own responsibilities: the session span, the fields
 * every record can carry, the name a session gets when the harness supplied no
 * title, and the shape of the finished session.
 *
 * Written against mutation-testing survivors. The span comparisons were the
 * single largest cluster in the module — `endedAt` alone carried eight surviving
 * mutants — because every existing fixture happens to feed records in ascending
 * order, so a comparison that took the FIRST value rather than the LATEST looked
 * identical. Out-of-order records are the case that tells them apart, and no
 * suite had one.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

const USAGE = { input_tokens: 10, output_tokens: 5 };

function userLine(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "/workspace/project",
    message: { role: "user", content: "go" },
    ...fields,
  });
}

describe("the session span covers every timestamped record", () => {
  it("widens to the earliest and latest, whatever order they arrive in", async () => {
    // Records deliberately OUT OF ORDER. A span that took first-and-last, or
    // that compared the wrong way round, agrees with an ascending fixture and
    // disagrees here.
    const session = await parseClaudeTranscript(
      [
        userLine({ timestamp: "2026-07-09T12:00:05.000Z" }),
        userLine({ timestamp: "2026-07-09T12:00:01.000Z" }),
        userLine({ timestamp: "2026-07-09T12:00:09.000Z" }),
        userLine({ timestamp: "2026-07-09T12:00:03.000Z" }),
      ],
      { sessionId: "span-unordered" }
    );

    expect(session?.startedAt).toBe("2026-07-09T12:00:01.000Z");
    expect(session?.endedAt).toBe("2026-07-09T12:00:09.000Z");
  });

  it("is a single instant when one record carries a timestamp", async () => {
    const session = await parseClaudeTranscript(
      [userLine({ timestamp: "2026-07-09T12:00:04.000Z" })],
      { sessionId: "span-single" }
    );

    expect(session?.startedAt).toBe("2026-07-09T12:00:04.000Z");
    expect(session?.endedAt).toBe("2026-07-09T12:00:04.000Z");
  });

  it("ignores records with no timestamp rather than widening to null", async () => {
    const session = await parseClaudeTranscript(
      [
        JSON.stringify({
          type: "user",
          cwd: "/workspace/project",
          message: { role: "user", content: "no stamp" },
        }),
        userLine({ timestamp: "2026-07-09T12:00:02.000Z" }),
      ],
      { sessionId: "span-untimed" }
    );

    expect(session?.startedAt).toBe("2026-07-09T12:00:02.000Z");
    expect(session?.endedAt).toBe("2026-07-09T12:00:02.000Z");
  });

  it("returns null for a transcript with no usable timestamp anywhere", async () => {
    const session = await parseClaudeTranscript(
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "nothing placeable" },
        }),
      ],
      { sessionId: "span-none" }
    );

    expect(session).toBeNull();
  });
});

describe("the session name falls back through what the transcript revealed", () => {
  // `deriveSessionName` is reached only when the harness supplied no `ai-title`.
  // Each arm below is a different answer to "where did this run?", and all of
  // them survived untested.

  it("uses the working directory's basename and the short id", async () => {
    const session = await parseClaudeTranscript(
      [userLine({ cwd: "/workspace/my-project" })],
      { sessionId: "abcdef1234567890" }
    );

    expect(session?.name).toBe("my-project - abcdef12");
  });

  it("prefers the slug as the distinguishing suffix when present", async () => {
    const session = await parseClaudeTranscript(
      [userLine({ cwd: "/workspace/my-project", slug: "feature-x" })],
      { sessionId: "abcdef1234567890" }
    );

    expect(session?.name).toBe("my-project (feature-x)");
  });

  it("falls back to the slug as the project when there is no cwd", async () => {
    const session = await parseClaudeTranscript(
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-09T12:00:00.000Z",
          slug: "only-slug",
          message: { role: "user", content: "go" },
        }),
      ],
      { sessionId: "abcdef1234567890" }
    );

    expect(session?.name).toBe("only-slug (only-slug)");
  });

  it("falls back to the short id when neither cwd nor slug is known", async () => {
    const session = await parseClaudeTranscript(
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-09T12:00:00.000Z",
          message: { role: "user", content: "go" },
        }),
      ],
      { sessionId: "abcdef1234567890" }
    );

    expect(session?.name).toBe("Session abcdef12 - abcdef12");
  });

  it("is overridden entirely by the harness's own title", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine(),
        JSON.stringify({
          type: "ai-title",
          timestamp: "2026-07-09T12:00:01.000Z",
          aiTitle: "What the user actually saw",
        }),
      ],
      { sessionId: "abcdef1234567890" }
    );

    expect(session?.name).toBe("What the user actually saw");
  });
});

describe("session-level attributes", () => {
  it("defaults the entrypoint to `claude` for a transcript predating the field", async () => {
    const session = await parseClaudeTranscript([userLine()], {
      sessionId: "entrypoint-absent",
    });

    expect(session?.entrypoint).toBe("claude");
  });

  it("keeps an explicit entrypoint", async () => {
    const session = await parseClaudeTranscript(
      [userLine({ entrypoint: "vscode" })],
      { sessionId: "entrypoint-present" }
    );

    expect(session?.entrypoint).toBe("vscode");
  });

  it("takes the FIRST meaningful cwd and refuses a daemon root", async () => {
    // A harness launched from a daemon context records `/` before the agent
    // moves into the real worktree; recording it resolves the repo to "/".
    const session = await parseClaudeTranscript(
      [
        userLine({ cwd: "/", timestamp: "2026-07-09T12:00:00.000Z" }),
        userLine({
          cwd: "/workspace/real-project",
          timestamp: "2026-07-09T12:00:01.000Z",
        }),
        userLine({
          cwd: "/workspace/later-project",
          timestamp: "2026-07-09T12:00:02.000Z",
        }),
      ],
      { sessionId: "cwd-first-meaningful" }
    );

    expect(session?.cwd).toBe("/workspace/real-project");
  });

  it("records every team the transcript was stamped with, once each", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine({ teamName: "platform" }),
        userLine({ teamName: "platform", timestamp: "2026-07-09T12:00:01Z" }),
        userLine({ teamName: "infra", timestamp: "2026-07-09T12:00:02Z" }),
      ],
      { sessionId: "teams" }
    );

    expect([...(session?.teams ?? [])].sort()).toEqual(["infra", "platform"]);
  });
});

describe("faults any record can report about itself", () => {
  it("captures a raw error object at the message level", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine(),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:01.000Z",
          message: {
            type: "error",
            error: { type: "overloaded", message: "slow down" },
          },
        }),
      ],
      { sessionId: "raw-error" }
    );

    expect(session?.apiErrors).toHaveLength(1);
    expect(session?.apiErrors[0]).toMatchObject({
      type: "overloaded",
      message: "slow down",
    });
  });

  it("defaults a raw error with no type or message to the unknown labels", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine(),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:01.000Z",
          message: { type: "error", error: { detail: "no standard fields" } },
        }),
      ],
      { sessionId: "raw-error-unknown" }
    );

    expect(session?.apiErrors[0]).toMatchObject({
      type: "unknown_error",
      message: "Unknown API error",
    });
  });

  it("records no error for an ordinary message", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine(),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "fine" }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "no-error" }
    );

    expect(session?.apiErrors).toEqual([]);
  });
});

describe("the scan's line accounting", () => {
  it("skips blank lines without counting them against parse quality", async () => {
    const session = await parseClaudeTranscript(
      [userLine(), "", "   ", userLine({ timestamp: "2026-07-09T12:00:01Z" })],
      { sessionId: "blank-lines" }
    );

    expect(session?.parseQuality).toMatchObject({
      totalLines: 2,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });

  it("counts a malformed line and flags a malformed FINAL line", async () => {
    const session = await parseClaudeTranscript([userLine(), "{not json"], {
      sessionId: "malformed-final",
    });

    expect(session?.parseQuality).toMatchObject({
      totalLines: 2,
      malformedLines: 1,
      truncatedFinalLine: true,
    });
  });

  it("does not flag a truncated final line when a good line follows", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine(),
        "{not json",
        userLine({ timestamp: "2026-07-09T12:00:02Z" }),
      ],
      { sessionId: "malformed-middle" }
    );

    expect(session?.parseQuality).toMatchObject({
      malformedLines: 1,
      truncatedFinalLine: false,
    });
  });
});

describe("the built session's derived collections", () => {
  it("reports no diff stats when the session changed no file", async () => {
    const session = await parseClaudeTranscript([userLine()], {
      sessionId: "no-diffstats",
    });

    expect(session?.diffStats).toBeNull();
  });

  it("carries one message timestamp per billable round-trip", async () => {
    const session = await parseClaudeTranscript(
      [
        userLine(),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:01.000Z",
          requestId: "req-1",
          message: {
            role: "assistant",
            id: "msg-1",
            model: "claude-opus-4",
            content: [{ type: "text", text: "a" }],
            usage: USAGE,
          },
        }),
        // Same message id and requestId: one turn written across two lines, so
        // one timestamp, not two.
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:02.000Z",
          requestId: "req-1",
          message: {
            role: "assistant",
            id: "msg-1",
            model: "claude-opus-4",
            content: [{ type: "text", text: "b" }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "message-timestamps" }
    );

    expect(session?.assistantMessages).toBe(1);
    expect(session?.messageTimestamps).toEqual(["2026-07-09T12:00:01.000Z"]);
  });
});

describe("a line that parses as JSON but is not a record", () => {
  // `JSON.parse` succeeds for `null`, a scalar, and an array — all legal JSON,
  // none of them a transcript record. The cast to `Record<string, unknown>`
  // asserts a shape nothing checked, so these reached the handlers. A throw here
  // is not a caught malformed line: desktop retries the permanent failure on
  // every pass and the cloud renderer blanks the whole transcript.
  const GOOD = JSON.stringify({
    type: "user",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "/workspace/project",
    message: { role: "user", content: "go" },
  });

  it.each([
    ["null", "null"],
    ["a number", "123"],
    ["a string", '"just text"'],
    ["an array", "[1,2,3]"],
    ["a boolean", "true"],
  ])("counts %s as malformed and keeps parsing", async (_label, line) => {
    const session = await parseClaudeTranscript([GOOD, line, GOOD], {
      sessionId: "non-record-line",
    });

    expect(session).not.toBeNull();
    expect(session?.parseQuality?.malformedLines).toBe(1);
    // The surrounding transcript still parsed, which is the point of counting
    // rather than throwing.
    expect(session?.parseQuality?.totalLines).toBe(3);
  });

  it("keeps a record whose timestamp cannot be read, with an unknown stamp", async () => {
    // Written raw: the overflowing literal has to survive to `JSON.parse` to
    // become Infinity, which is the input under test. `toISOString` throws for it,
    // and that throw used to abort the entire scan.
    //
    // Deliberately NOT counted as a malformed line: the line is well-formed JSON
    // and IS a record, so only one field is unreadable. Counting it would conflate
    // "this file is damaged" with "one stamp is junk" and inflate the quality
    // signal desktop uses to decide whether a transcript imported cleanly.
    const overflow =
      '{"type":"user","timestamp":1e999,"message":{"role":"user","content":"hi"}}';

    const session = await parseClaudeTranscript([GOOD, overflow], {
      sessionId: "unreadable-timestamp",
    });

    expect(session).not.toBeNull();
    expect(session?.parseQuality?.malformedLines).toBe(0);
    // The session still spans only the readable stamp, rather than adopting a
    // nonsense one.
    expect(session?.startedAt).toBe("2026-07-09T12:00:00.000Z");
    expect(session?.endedAt).toBe("2026-07-09T12:00:00.000Z");
  });
});
