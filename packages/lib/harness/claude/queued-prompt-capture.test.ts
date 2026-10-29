/**
 * @file queued-prompt-capture.test.ts
 * @description ISS-12625 — a prompt typed while a turn was still running
 * arrives as a `queued_command` attachment rather than a `user` record, so the
 * parser dropped it from both the conversation and `userMessages`.
 *
 * `attachment.commandMode` is the discriminator, and the cases here exist to
 * keep the two modes a transcript carries apart: `prompt` is a person typing,
 * `task-notification` is the harness announcing a finished background task to
 * itself. A test that only proved "a queued_command becomes a turn" would pass
 * just as happily with the notifications counted as typing.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude";
import { ABSENT_FIELD_VALUE } from "./parse-claude-accumulator";

const ANCHOR_TIMESTAMP = "2026-07-09T12:00:00.000Z";
const QUEUED_TIMESTAMP = "2026-07-09T12:00:05.000Z";

const USER_LINE = JSON.stringify({
  type: "user",
  uuid: "u-1",
  timestamp: ANCHOR_TIMESTAMP,
  cwd: "/workspace/project",
  message: { role: "user", content: "first" },
});

/**
 * The anchor turn above is what makes the count assertions mean "added": a
 * suite with no baseline turn cannot tell a captured prompt from a replaced one.
 */
const queuedLine = (
  attachment: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) =>
  JSON.stringify({
    type: "attachment",
    userType: "external",
    uuid: "q-1",
    timestamp: QUEUED_TIMESTAMP,
    attachment: { type: "queued_command", ...attachment },
    ...extra,
  });

const parse = (lines: string[], sessionId: string) =>
  parseClaudeTranscript(lines, { sessionId });

const parseWithDiagnostics = (lines: string[], sessionId: string) => {
  const lines_: string[] = [];
  return parseClaudeTranscript(lines, {
    sessionId,
    logger: (line: string) => {
      lines_.push(line);
    },
  }).then((session) => ({ session, log: lines_.join("\n") }));
};

describe("a queued prompt is the human turn it was (ISS-12625)", () => {
  it("records a prompt from a harness version that stamps no origin", async () => {
    const session = await parse(
      [
        USER_LINE,
        queuedLine({
          commandMode: "prompt",
          prompt: "remove the feature flag",
        }),
      ],
      "queued-prompt-no-origin"
    );

    expect(session?.userMessages).toBe(2);
    expect(session?.messages.at(-1)).toEqual({
      role: "human",
      timestamp: QUEUED_TIMESTAMP,
      text: "remove the feature flag",
    });
  });

  it("records a prompt whose attachment origin is explicitly human", async () => {
    const session = await parse(
      [
        USER_LINE,
        queuedLine({
          commandMode: "prompt",
          origin: { kind: "human" },
          prompt: "go ahead and build",
        }),
      ],
      "queued-prompt-human-origin"
    );

    expect(session?.userMessages).toBe(2);
    expect(session?.messages.at(-1)?.text).toBe("go ahead and build");
  });

  it("ignores a task notification, which no person typed", async () => {
    const session = await parse(
      [
        USER_LINE,
        queuedLine({
          commandMode: "task-notification",
          prompt: "Task agent-7 finished",
        }),
      ],
      "queued-task-notification"
    );

    expect(session?.userMessages).toBe(1);
    expect(session?.messages).toHaveLength(1);
  });

  it("drops a prompt whose attachment origin names a non-human kind", async () => {
    const session = await parse(
      [
        USER_LINE,
        queuedLine({
          commandMode: "prompt",
          origin: { kind: "slash-command" },
          prompt: "/compact",
        }),
      ],
      "queued-prompt-synthetic-origin"
    );

    expect(session?.userMessages).toBe(1);
    expect(session?.messages).toHaveLength(1);
  });

  it("drops a queued command whose mode it does not recognise", async () => {
    const session = await parse(
      [
        USER_LINE,
        queuedLine({ commandMode: "prompt-with-attachments", prompt: "look" }),
      ],
      "queued-unknown-mode"
    );

    expect(session?.userMessages).toBe(1);
    expect(session?.messages).toHaveLength(1);
  });

  it("drops a queued prompt carrying no text", async () => {
    const session = await parse(
      [USER_LINE, queuedLine({ commandMode: "prompt", prompt: "   " })],
      "queued-prompt-blank"
    );

    expect(session?.userMessages).toBe(1);
    expect(session?.messages).toHaveLength(1);
  });

  it("keeps a fork-replayed queued prompt without counting it", async () => {
    // ISS-8659: the inherited conversation is kept so session detail does not
    // open mid-thread, but the typing belongs to the parent.
    const session = await parse(
      [
        USER_LINE,
        queuedLine(
          { commandMode: "prompt", prompt: "the parent typed this" },
          { forkedFrom: { sessionId: "parent-session", messageUuid: "m-1" } }
        ),
      ],
      "queued-prompt-replayed"
    );

    expect(session?.userMessages).toBe(1);
    expect(session?.messages.at(-1)).toEqual({
      role: "human",
      timestamp: QUEUED_TIMESTAMP,
      text: "the parent typed this",
      isForkReplayed: true,
    });
  });

  it("keeps the queued prompt where the record sat, not where its clock says", async () => {
    // The ISS-12625 operator ruling (2026-10-19) is RECORD order: a prompt is
    // typed mid-turn, so its timestamp can precede the message already ahead of
    // it. Every other case here has the two orders agreeing, which a
    // sort-by-timestamp implementation would satisfy just as well.
    const session = await parse(
      [
        USER_LINE,
        JSON.stringify({
          type: "assistant",
          uuid: "a-1",
          timestamp: "2026-07-09T20:53:10.822Z",
          message: { role: "assistant", content: "working on it" },
        }),
        queuedLine({
          commandMode: "prompt",
          prompt: "typed while that was running",
        }),
      ],
      "queued-prompt-record-order"
    );

    const timestamps = session?.messages.map((m) => m.timestamp);
    expect(timestamps).toEqual([
      ANCHOR_TIMESTAMP,
      "2026-07-09T20:53:10.822Z",
      QUEUED_TIMESTAMP,
    ]);
    // Stated as the inversion it is, so sorting the array fails here loudly.
    expect(QUEUED_TIMESTAMP < "2026-07-09T20:53:10.822Z").toBe(true);
  });

  it("reports an unrecognised mode as drift instead of dropping it", async () => {
    const { session, log } = await parseWithDiagnostics(
      [
        USER_LINE,
        queuedLine({ commandMode: "prompt-with-attachments", prompt: "look" }),
      ],
      "queued-unknown-mode-reported"
    );

    expect(session?.userMessages).toBe(1);
    expect(log).toContain("attachment.commandMode=prompt-with-attachments");
  });

  it("reports a queued command with no commandMode at all", async () => {
    // PR #8942 review (marisolashgrove, tamsinb): the absence has to reach the
    // drift log too. A renamed discriminator drops every queued prompt, and the
    // whole point of ISS-12625 is that such a drop must not be silent.
    const { session, log } = await parseWithDiagnostics(
      [USER_LINE, queuedLine({ prompt: "no mode on this one" })],
      "queued-absent-mode-reported"
    );

    expect(session?.userMessages).toBe(1);
    expect(log).toContain(`attachment.commandMode=${ABSENT_FIELD_VALUE}`);
  });

  it("reports a non-string commandMode under the same absent name", async () => {
    // Unreadable is unreadable: a retyped discriminator and a removed one need
    // the same remediation, so they share one drift name rather than rendering
    // an arbitrary transcript value into the log.
    const { session, log } = await parseWithDiagnostics(
      [USER_LINE, queuedLine({ commandMode: 7, prompt: "numeric mode" })],
      "queued-nonstring-mode-reported"
    );

    expect(session?.userMessages).toBe(1);
    expect(log).toContain(`attachment.commandMode=${ABSENT_FIELD_VALUE}`);
  });

  it("records a prompt that arrives as content blocks beside a pasted image", async () => {
    // PR #8942 review (tamsinb): a queued prompt carries the block-array shape
    // whenever something was pasted with it. Reading only the string form
    // dropped those with no turn and no drift line.
    const session = await parse(
      [
        USER_LINE,
        queuedLine({
          commandMode: "prompt",
          prompt: [
            { type: "text", text: "fix the chart in this screenshot" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBOR",
              },
            },
          ],
        }),
      ],
      "queued-prompt-content-blocks"
    );

    expect(session?.userMessages).toBe(2);
    expect(session?.messages.at(-1)).toEqual({
      role: "human",
      timestamp: QUEUED_TIMESTAMP,
      text: "fix the chart in this screenshot",
    });
  });

  it("takes nothing from a queue-operation record carrying the same prompt", async () => {
    // Both carriers in one session: only the attachment contributes a turn.
    const session = await parse(
      [
        USER_LINE,
        JSON.stringify({
          type: "queue-operation",
          uuid: "qo-1",
          timestamp: "2026-07-09T20:00:00.000Z",
          prompt: "queued via the operation record",
          commandMode: "prompt",
        }),
        queuedLine({ commandMode: "prompt", prompt: "the real queued prompt" }),
      ],
      "queued-both-carriers"
    );

    expect(session?.userMessages).toBe(2);
    expect(session?.messages.map((m) => m.text)).toEqual([
      "first",
      "the real queued prompt",
    ]);
  });
});
