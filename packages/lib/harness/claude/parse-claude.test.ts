import { describe, expect, it } from "vitest";
import { ASSISTANT_LINE, USER_LINE } from "./parse-claude.test-fixtures";
import { parseClaudeTranscript } from "./parse-claude-core";

describe("parseClaudeTranscript", () => {
  it("parses a minimal transcript from an in-memory line iterable", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "test-session",
    });

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("test-session");
    expect(session?.model).toBe("claude-opus-4");
    expect(session?.userMessages).toBe(1);
    // One deduped API turn.
    expect(session?.assistantMessages).toBe(1);
    expect(session?.tokensByModel["claude-opus-4"]).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
    });
    expect(session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
    ]);
    expect(session?.startedAt).toBe("2026-07-09T12:00:00.000Z");
    // The core never touches the filesystem; the desktop shell stamps mtime.
    expect(session?.fileModifiedAt).toBeNull();
    expect(session?.subagents).toEqual([]);
  });

  it("FEA-3942: counts MultiEdit tool uses toward diffStats (summed per-edit deltas, one file)", async () => {
    const multiEditLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_multiedit_1",
            name: "MultiEdit",
            input: {
              file_path: "src/foo.ts",
              edits: [
                // computeLineDelta: +2 / -1
                { old_string: "old1", new_string: "new1a\nnew1b" },
                // computeLineDelta:  0 / -1
                { old_string: "keep\ndrop", new_string: "keep" },
              ],
            },
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, multiEditLine], {
      sessionId: "s",
    });

    // Two edits summed on one distinct file — before FEA-3942 MultiEdit was
    // ignored and diffStats would have been null.
    expect(session?.diffStats).toEqual({
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 2,
    });
  });

  it("FEA-3668: ignores a leading cwd of `/`, attributing to the first real cwd", async () => {
    // Automated launches record `/` on the first turn before the agent cd's into
    // the real worktree; the session cwd must be the real dir, not `/`.
    const rootLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/",
      message: { role: "user", content: "cd into the worktree" },
    });
    const worktreeLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      cwd: "/private/tmp/nrev-fix-fea-3590-47751",
      message: { role: "user", content: "now do the work" },
    });

    const session = await parseClaudeTranscript(
      [rootLine, worktreeLine, ASSISTANT_LINE],
      { sessionId: "s" }
    );

    expect(session?.cwd).toBe("/private/tmp/nrev-fix-fea-3590-47751");
  });

  it("FEA-3668: leaves cwd null when every record's cwd is `/`", async () => {
    const rootLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/",
      message: { role: "user", content: "hi" },
    });

    const session = await parseClaudeTranscript([rootLine, ASSISTANT_LINE], {
      sessionId: "s",
    });

    expect(session?.cwd).toBeNull();
  });

  it("returns null when the transcript has no usable timestamp", async () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "no timestamp here" },
    });
    expect(await parseClaudeTranscript([line], { sessionId: "s" })).toBeNull();
  });

  it("skips blank, malformed, and partial trailing lines", async () => {
    const lines = ["", "not-json", "{partial", USER_LINE, ASSISTANT_LINE, "  "];
    const session = await parseClaudeTranscript(lines, { sessionId: "s" });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(1);
  });

  it("accepts an async iterable of lines", async () => {
    // Mimics a streamed fetch: each line arrives across an await boundary.
    async function* gen(): AsyncGenerator<string> {
      for (const line of [USER_LINE, ASSISTANT_LINE]) {
        await Promise.resolve();
        yield line;
      }
    }
    const session = await parseClaudeTranscript(gen(), { sessionId: "s" });
    expect(session?.assistantMessages).toBe(1);
  });

  it("parses pr-link records into prLinks with dedup", async () => {
    const prLink1 = JSON.stringify({
      type: "pr-link",
      prUrl: "https://github.com/org/repo/pull/42",
      prRepository: "org/repo",
      prNumber: 42,
      timestamp: "2026-07-09T12:00:02.000Z",
    });
    const prLink2 = JSON.stringify({
      type: "pr-link",
      prUrl: "https://github.com/org/repo/pull/42",
      prRepository: "org/repo",
      prNumber: 42,
      timestamp: "2026-07-09T12:00:03.000Z",
    });
    const prLink3 = JSON.stringify({
      type: "pr-link",
      prUrl: "https://github.com/org/repo/pull/99",
      prRepository: "org/repo",
      prNumber: 99,
      timestamp: "2026-07-09T12:00:04.000Z",
    });
    const lines = [USER_LINE, ASSISTANT_LINE, prLink1, prLink2, prLink3];
    const session = await parseClaudeTranscript(lines, { sessionId: "s" });

    expect(session?.prLinks).toHaveLength(2);
    expect(session?.prLinks[0]).toEqual({
      number: "42",
      repo: "org/repo",
      url: "https://github.com/org/repo/pull/42",
    });
    expect(session?.prLinks[1]).toEqual({
      number: "99",
      repo: "org/repo",
      url: "https://github.com/org/repo/pull/99",
    });
  });

  it("dedups resume/compaction-replayed entries by uuid (FEA-3453)", async () => {
    // Claude Code re-writes earlier entries verbatim (same uuid + timestamp)
    // into the continued log on resume/compaction. The replayed human/assistant
    // turns must NOT render twice.
    const humanUuid = "0199a000-0000-7000-8000-000000000001";
    const assistantUuid = "0199a000-0000-7000-8000-000000000002";
    const compactionUuid = "0199a000-0000-7000-8000-000000000003";
    const apiErrorUuid = "0199a000-0000-7000-8000-000000000004";
    const turnDurationUuid = "0199a000-0000-7000-8000-000000000005";
    const human = JSON.stringify({
      type: "user",
      uuid: humanUuid,
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/workspace/example-project",
      message: { role: "user", content: "steer the agent" },
    });
    const assistant = JSON.stringify({
      type: "assistant",
      uuid: assistantUuid,
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "on it" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0,
        },
      },
    });
    // Auto-compaction summary — replayed verbatim after resume like the turns.
    const compaction = JSON.stringify({
      type: "user",
      uuid: compactionUuid,
      isCompactSummary: true,
      timestamp: "2026-07-09T12:00:02.000Z",
      message: { role: "user", content: "summary of the conversation so far" },
    });
    // API-error marker — also replayed verbatim; must not inflate apiErrors.
    const apiError = JSON.stringify({
      type: "user",
      uuid: apiErrorUuid,
      isApiErrorMessage: true,
      error: "rate_limit_error",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: { role: "user", content: [{ type: "text", text: "429" }] },
    });
    // turn_duration system entry — replayed too; must not inflate turnDurations.
    const turnDuration = JSON.stringify({
      type: "system",
      uuid: turnDurationUuid,
      subtype: "turn_duration",
      durationMs: 1234,
      timestamp: "2026-07-09T12:00:04.000Z",
    });
    // Post-resume: the exact same lines are replayed verbatim.
    const originalSegment = [
      human,
      assistant,
      compaction,
      apiError,
      turnDuration,
    ];
    const session = await parseClaudeTranscript(
      [...originalSegment, ...originalSegment],
      { sessionId: "resumed" }
    );

    expect(session).not.toBeNull();
    // Each original turn appears exactly once despite the verbatim replay: the
    // steering prompt (human), the assistant reply, and the api-error turn
    // (a `user`-role entry that renders once). The compaction summary is
    // synthetic and never becomes a human message.
    expect(session?.messages.map((m) => m.role)).toEqual([
      "human",
      "assistant",
      "human",
    ]);
    expect(session?.userMessages).toBe(2);
    expect(session?.assistantMessages).toBe(1);
    // Token usage is deduped independently (FEA-1459) and stays single-counted.
    expect(session?.tokensByModel["claude-opus-4"]).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
    });
    // Metadata aggregates captured before entry dispatch are deduped too: the
    // replayed compaction / api-error / turn-duration markers are each counted
    // exactly once, not twice.
    expect(session?.compactions).toHaveLength(1);
    expect(session?.apiErrors).toHaveLength(1);
    expect(session?.turnDurations).toHaveLength(1);
  });

  it("does not dedup distinct entries that omit a uuid", async () => {
    // Fallback safety: entries without a uuid cannot be replay-matched, so two
    // genuinely distinct uuid-less human turns are both preserved.
    const session = await parseClaudeTranscript([USER_LINE, USER_LINE], {
      sessionId: "no-uuid",
    });
    expect(session?.userMessages).toBe(2);
    expect(session?.messages.map((m) => m.role)).toEqual(["human", "human"]);
  });

  it("defaults prLinks to empty when no pr-link records exist", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session?.prLinks).toEqual([]);
  });

  it("drops one bad token value and keeps parsing the rest of the transcript", async () => {
    // A well-formed assistant line whose fractional token counter trips the
    // parser's safe-integer guard (`InvalidTokenCountError`). Before the fix this
    // aborted the whole transcript (blank messages + zero tokens); now its usage
    // is dropped and parsing continues.
    const badTokenLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        id: "msg-bad",
        content: [{ type: "text", text: "bad token turn" }],
        usage: { input_tokens: 10.5, output_tokens: 5 },
      },
    });
    // A LATER good assistant turn whose usage must still be counted.
    const goodTokenLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        id: "msg-good",
        content: [{ type: "text", text: "good token turn" }],
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
        },
      },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, badTokenLine, goodTokenLine],
      { sessionId: "s" }
    );

    // The transcript renders (was previously blanked by the abort).
    expect(session).not.toBeNull();
    expect(
      session?.messages.map((m) => m.text).filter((t): t is string => t != null)
    ).toEqual(expect.arrayContaining(["bad token turn", "good token turn"]));
    // Only the NEXT good event's usage is counted; the bad snapshot is dropped
    // (not zeroed and not aborted).
    expect(session?.tokensByModel["claude-opus-4"]).toEqual({
      input: 20,
      output: 7,
      cacheRead: 3,
      cacheWrite: 1,
    });
    // The bad turn's message has no token block; the good turn is deduped to one.
    expect(session?.assistantMessages).toBe(1);
  });

  it("skips pr-link records missing required fields", async () => {
    const noUrl = JSON.stringify({
      type: "pr-link",
      prRepository: "org/repo",
      prNumber: 42,
      timestamp: "2026-07-09T12:00:02.000Z",
    });
    const noNumber = JSON.stringify({
      type: "pr-link",
      prUrl: "https://github.com/org/repo/pull/42",
      prRepository: "org/repo",
      timestamp: "2026-07-09T12:00:02.000Z",
    });
    const lines = [USER_LINE, ASSISTANT_LINE, noUrl, noNumber];
    const session = await parseClaudeTranscript(lines, { sessionId: "s" });
    expect(session?.prLinks).toEqual([]);
  });
});
