import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

// FEA-4093: hook firings are captured from `attachment` records whose
// `attachment.type` is `hook_success` / `hook_error` /
// `hook_non_blocking_error`. Before this the parser dropped `attachment`
// records entirely, so every Hook component aggregated to zero usage even
// though hooks fire regularly. The two `_error` variants are failed firings.

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "myproject",
  message: { role: "user", content: "hello" },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-09T12:00:01.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4",
    content: [{ type: "text", text: "hi there" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  },
});

const hookAttachment = (
  overrides: Record<string, unknown>,
  timestamp = "2026-07-09T12:00:02.000Z"
) =>
  JSON.stringify({
    type: "attachment",
    timestamp,
    attachment: {
      type: "hook_success",
      hookName: "PreToolUse:Bash",
      hookEvent: "PreToolUse",
      command: 'node "hook-handler.js"',
      exitCode: 0,
      ...overrides,
    },
  });

describe("parseClaudeTranscript hook firings → session.hooks (FEA-4093)", () => {
  it("captures a hook_success attachment as a hook use", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, hookAttachment({})],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(1);
    const hook = session?.hooks[0];
    expect(hook?.name).toBe("PreToolUse:Bash");
    expect(hook?.event).toBe("PreToolUse");
    expect(hook?.command).toBe('node "hook-handler.js"');
    expect(hook?.succeeded).toBe(true);
    expect(hook?.timestamp).toBe("2026-07-09T12:00:02.000Z");
  });

  it("captures a hook_error attachment with succeeded=false", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        ASSISTANT_LINE,
        hookAttachment({
          type: "hook_error",
          hookName: "Stop:cleanup",
          hookEvent: "Stop",
          exitCode: 1,
        }),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(1);
    expect(session?.hooks[0]?.name).toBe("Stop:cleanup");
    expect(session?.hooks[0]?.succeeded).toBe(false);
  });

  it("captures a hook_non_blocking_error attachment with succeeded=false", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        ASSISTANT_LINE,
        hookAttachment({
          type: "hook_non_blocking_error",
          hookName: "SessionStart:startup",
          hookEvent: "SessionStart",
          exitCode: 1,
        }),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(1);
    expect(session?.hooks[0]?.name).toBe("SessionStart:startup");
    expect(session?.hooks[0]?.succeeded).toBe(false);
  });

  it("keeps two handlers on the same matcher (same name+ts+toolUseID, different command) as separate firings", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        ASSISTANT_LINE,
        hookAttachment({ toolUseID: "toolu_shared", command: "handler-a.sh" }),
        hookAttachment({ toolUseID: "toolu_shared", command: "handler-b.sh" }),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(2);
    expect(session?.hooks.map((hook) => hook.command)).toEqual([
      "handler-a.sh",
      "handler-b.sh",
    ]);
  });

  it("captures multiple distinct hook firings in order", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        hookAttachment(
          { hookName: "SessionStart:startup", hookEvent: "SessionStart" },
          "2026-07-09T12:00:00.500Z"
        ),
        ASSISTANT_LINE,
        hookAttachment({}),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks.map((hook) => hook.name)).toEqual([
      "SessionStart:startup",
      "PreToolUse:Bash",
    ]);
  });

  it("dedupes a replayed identical hook attachment (same name+ts+toolUseID)", async () => {
    const line = hookAttachment({ toolUseID: "toolu_dupe" });
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, line, line],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(1);
  });

  it("ignores a non-hook attachment (would fail if attachments were blindly captured)", async () => {
    const fileAttachment = JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-09T12:00:02.000Z",
      attachment: {
        type: "file",
        filename: "notes.md",
        content: "some file content",
      },
    });
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, fileAttachment],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toEqual([]);
  });

  it("leaves hooks empty for a transcript with no hook firings", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "test-session",
    });
    expect(session?.hooks).toEqual([]);
  });

  it("skips a hook attachment with a blank hookName", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, hookAttachment({ hookName: "   " })],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toEqual([]);
  });

  it("skips an attachment that names a hook under a type this parser does not know", async () => {
    // The three outcome types are the whole vocabulary, and `succeeded` is
    // derived as `type === "hook_success"` — so admitting a fourth type would
    // record it as a FAILED firing, asserting a failure that never happened.
    // The named-but-unknown shape is the one the type gate exists for; an
    // attachment with no hookName at all is refused by the name gate instead.
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, hookAttachment({ type: "hook_progress" })],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toEqual([]);
  });
});

// The identity tuple is `name \0 timestamp \0 toolUseID \0 command`. Every one
// of these cases is a pair that differs in exactly ONE slot, so a dedup key that
// dropped that slot — or that joined the slots without a separator — would
// collapse the pair into a single firing and silently lose a hook that ran.
describe("the hook dedup identity keeps every slot", () => {
  it("keeps the same hook firing at two different times as two firings", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        ASSISTANT_LINE,
        hookAttachment(
          { hookName: "UserPromptSubmit:guard", hookEvent: "UserPromptSubmit" },
          "2026-07-09T12:00:02.000Z"
        ),
        hookAttachment(
          { hookName: "UserPromptSubmit:guard", hookEvent: "UserPromptSubmit" },
          "2026-07-09T12:05:00.000Z"
        ),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks.map((hook) => hook.timestamp)).toEqual([
      "2026-07-09T12:00:02.000Z",
      "2026-07-09T12:05:00.000Z",
    ]);
  });

  it("keeps one handler firing on two tool calls stamped the same instant as two firings", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        ASSISTANT_LINE,
        hookAttachment({ toolUseID: "toolu_first" }),
        hookAttachment({ toolUseID: "toolu_second" }),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(2);
  });

  it("keeps two firings whose identity fields concatenate alike but split differently", async () => {
    // Deliberately constructed so the four slots joined WITHOUT a separator
    // produce the same string for both records, while the real identities
    // differ. A separator-less key drops the second firing; one such
    // coincidence in a transcript is all it takes.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        ASSISTANT_LINE,
        hookAttachment({ toolUseID: "toolu_01", command: "check.sh" }),
        hookAttachment({ toolUseID: "toolu_01check.sh", command: undefined }),
      ],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(2);
    expect(session?.hooks.map((hook) => hook.command)).toEqual([
      "check.sh",
      null,
    ]);
  });

  it("records a hook firing that carries no timestamp", async () => {
    // A hook that ran is a fact whether or not the record was stamped, so the
    // firing is kept with a null timestamp rather than dropped. `NormalizedHookUse`
    // declares the field nullable for exactly this record.
    const untimed = JSON.stringify({
      type: "attachment",
      attachment: {
        type: "hook_success",
        hookName: "SessionStart:startup",
        hookEvent: "SessionStart",
        command: "startup.sh",
      },
    });
    const session = await parseClaudeTranscript(
      [USER_LINE, ASSISTANT_LINE, untimed],
      { sessionId: "test-session" }
    );
    expect(session?.hooks).toHaveLength(1);
    expect(session?.hooks[0]?.name).toBe("SessionStart:startup");
    expect(session?.hooks[0]?.timestamp).toBeNull();
  });
});
