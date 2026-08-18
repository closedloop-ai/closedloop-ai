/**
 * @file parse-cursor.records.test.ts
 * Per-handler branch coverage for parseCursorTranscript — session-meta, turn-context,
 * user-message, assistant-message, tool-call, and file-edit handlers.
 * Each section drives parseCursorTranscript with synthetic inline JSONL lines that
 * exercise one specific uncovered branch, paired with an opposite/control case so
 * falsifiability is guaranteed.
 *
 * Constraint: types: [] in tsconfig — no Buffer, process, or node:* imports.
 */
import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "./parse-cursor";

const TS0 = "2026-07-11T08:00:00.000Z";
const TS1 = "2026-07-11T08:00:01.000Z";

// Biome useTopLevelRegex: regex must be module-level
const CURSOR_SESSION_NAME_RE = /^Cursor Session/;

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

// ── handleSessionMeta: cwd alias chain ───────────────────────────────────────

describe("handleSessionMeta: cwd field aliases", () => {
  it("workdir alias sets cwd when cwd field is absent (Branch 7[1])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { workdir: "/workspace/wd-proj" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "wdid" });
    expect(session?.cwd).toBe("/workspace/wd-proj");
    expect(session?.name).toBe("wd-proj");
  });

  it("workspace alias sets cwd when cwd and workdir are absent (Branch 7[2])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { workspace: "/workspace/ws-proj" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "wsid" });
    expect(session?.cwd).toBe("/workspace/ws-proj");
    expect(session?.name).toBe("ws-proj");
  });

  it("cwd wins over workdir when both are present", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/cwd-proj", workdir: "/workspace/wd-proj" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "cwdid" });
    expect(session?.cwd).toBe("/workspace/cwd-proj");
  });

  it("non-meaningful cwd '/' is rejected: cwd stays null (isMeaningfulCwd false path)", async () => {
    // asStringOrNull("/") returns "/" (a string, not null), so the ?? chain stops there.
    // isMeaningfulCwd("/") returns false → the if body is skipped → acc.cwd stays null.
    // workdir is NOT a fallback here; it would only be reached if cwd were absent (null field).
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/" },
      }),
      line({
        type: "user_message",
        timestamp: TS1,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "skipcwd",
    });
    expect(session?.cwd).toBeNull();
    expect(session?.name).toMatch(CURSOR_SESSION_NAME_RE);
  });

  it("cwd not overridden when already set (Branch 6[1])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/first" },
      }),
      line({
        type: "session_meta",
        timestamp: TS1,
        payload: { cwd: "/workspace/second" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "cwd-guard",
    });
    expect(session?.cwd).toBe("/workspace/first");
  });
});

// ── handleSessionMeta: version alias chain ────────────────────────────────────

describe("handleSessionMeta: version field aliases", () => {
  it("version field sets acc.version", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", version: "1.0.0" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "v1" });
    expect(session?.version).toBe("1.0.0");
  });

  it("cli_version alias used when version is absent", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", cli_version: "2.0.0" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "v2" });
    expect(session?.version).toBe("2.0.0");
  });

  it("version not overridden when already set (Branch 8[1])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", cli_version: "1.0.0" },
      }),
      line({
        type: "session_meta",
        timestamp: TS1,
        payload: { cli_version: "9.9.9" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "v-guard",
    });
    expect(session?.version).toBe("1.0.0");
  });
});

// ── handleSessionMeta: model guard ────────────────────────────────────────────

describe("handleSessionMeta: model guard", () => {
  it("model not overridden when already set (Branch 9[1])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", model: "claude-a" },
      }),
      line({
        type: "session_meta",
        timestamp: TS1,
        payload: { model: "claude-b" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "model-guard",
    });
    // turn_context would override but session_meta second call is blocked
    expect(session?.model).toBe("claude-a");
  });
});

// ── handleSessionMeta: gitBranch alias chain ─────────────────────────────────

describe("handleSessionMeta: gitBranch aliases", () => {
  it("git.ref fallback when git.branch is absent (Branch 15[1])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", git: { ref: "refs/heads/main" } },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "gitref" });
    expect(session?.gitBranch).toBe("refs/heads/main");
  });

  it("git_branch field used when git object is absent (Branch 16[0])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", git_branch: "develop" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "git-branch",
    });
    expect(session?.gitBranch).toBe("develop");
  });

  it("gitBranch stays null when no git info is present (Branch 17[1])", async () => {
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "no-git" });
    expect(session?.gitBranch).toBeNull();
  });

  it("gitBranch not overridden when already set (Branch 11[1])", async () => {
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", git: { branch: "main" } },
      }),
      line({
        type: "session_meta",
        timestamp: TS1,
        payload: { git: { branch: "feature" } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "git-guard",
    });
    expect(session?.gitBranch).toBe("main");
  });

  it("non-object git field is ignored; falls through to git_branch (Branch 12[1])", async () => {
    // git: "not-object" → typeof is "string", not "object" → skip git-object block
    // git_branch is then checked
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: {
          cwd: "/p",
          git: "not-an-object",
          git_branch: "fallback-branch",
        },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "git-nonobj",
    });
    expect(session?.gitBranch).toBe("fallback-branch");
  });

  it("session_start and session.created aliases reach handleSessionMeta", async () => {
    const l1 = [
      line({
        type: "session_start",
        timestamp: TS0,
        payload: { cwd: "/workspace/proj-a" },
      }),
    ];
    const s1 = await parseCursorTranscript(l1, { sessionId: "alias1" });
    expect(s1?.name).toBe("proj-a");

    const l2 = [
      line({
        type: "session.created",
        timestamp: TS0,
        payload: { cwd: "/workspace/proj-b" },
      }),
    ];
    const s2 = await parseCursorTranscript(l2, { sessionId: "alias2" });
    expect(s2?.name).toBe("proj-b");
  });
});

// ── handleTurnContext: cwd guard branches ─────────────────────────────────────

describe("handleTurnContext: cwd branches", () => {
  it("sets cwd from turn_context when acc.cwd is null (Branch 18[0], 20[0])", async () => {
    const lines = [
      line({
        type: "turn_context",
        timestamp: TS0,
        payload: { model: "claude-x", cwd: "/workspace/tc-proj" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "tc-cwd" });
    expect(session?.cwd).toBe("/workspace/tc-proj");
    expect(session?.name).toBe("tc-proj");
  });

  it("turn_context with no cwd in payload skips cwd update (Branch 19[1])", async () => {
    // !acc.cwd is true, but payload.cwd is absent → the && short-circuits on payload.cwd being falsy
    const lines = [
      line({
        type: "turn_context",
        timestamp: TS0,
        payload: { model: "claude-x" },
      }),
      line({
        type: "user_message",
        timestamp: TS1,
        payload: { content: "go" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-no-cwd",
    });
    expect(session?.cwd).toBeNull();
    expect(session?.userMessages).toBe(1);
  });

  it("turn_context cwd not used when acc.cwd already set", async () => {
    // !acc.cwd is false → whole condition is false → skip cwd update
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/workspace/from-meta" },
      }),
      line({
        type: "turn_context",
        timestamp: TS1,
        payload: { model: "claude-x", cwd: "/workspace/from-tc" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-cwd-guard",
    });
    expect(session?.cwd).toBe("/workspace/from-meta");
  });

  it("turn_context non-meaningful cwd '/' is rejected (Branch 20[1])", async () => {
    // isMeaningfulCwd("/") → false → cwd stays null
    const lines = [
      line({
        type: "turn_context",
        timestamp: TS0,
        payload: { model: "claude-x", cwd: "/" },
      }),
      line({
        type: "user_message",
        timestamp: TS1,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-root-cwd",
    });
    expect(session?.cwd).toBeNull();
    expect(session?.name).toMatch(CURSOR_SESSION_NAME_RE);
  });

  it("turn_context and model_context aliases both route to handleTurnContext", async () => {
    const l1 = [
      line({
        type: "turn.context",
        timestamp: TS0,
        payload: { model: "model-a" },
      }),
      line({ type: "user_message", timestamp: TS1, payload: { content: "x" } }),
    ];
    const s1 = await parseCursorTranscript(l1, { sessionId: "tc-alias1" });
    expect(s1?.model).toBe("model-a");

    const l2 = [
      line({
        type: "model_context",
        timestamp: TS0,
        payload: { model: "model-b" },
      }),
      line({ type: "user_message", timestamp: TS1, payload: { content: "x" } }),
    ];
    const s2 = await parseCursorTranscript(l2, { sessionId: "tc-alias2" });
    expect(s2?.model).toBe("model-b");
  });
});

// ── handleUserMessage: text fallbacks and iso guard ───────────────────────────

describe("handleUserMessage: text field fallbacks", () => {
  it("uses content field when present (control)", async () => {
    const lines = [
      line({
        type: "user_message",
        timestamp: TS0,
        payload: { content: "from content" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "um-content",
    });
    expect(session?.messages[0]?.text).toBe("from content");
  });

  it("falls back to text field when content is absent (Branch 27[1] context)", async () => {
    const lines = [
      line({
        type: "user_message",
        timestamp: TS0,
        payload: { text: "from text" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "um-text",
    });
    expect(session?.messages[0]?.text).toBe("from text");
  });

  it("falls back to message field when content and text are absent", async () => {
    const lines = [
      line({
        type: "user_message",
        timestamp: TS0,
        payload: { message: "from message" },
      }),
    ];
    const session = await parseCursorTranscript(lines, { sessionId: "um-msg" });
    expect(session?.messages[0]?.text).toBe("from message");
  });

  it("text is null when no content/text/message field", async () => {
    const lines = [line({ type: "user_message", timestamp: TS0, payload: {} })];
    const session = await parseCursorTranscript(lines, {
      sessionId: "um-notext",
    });
    expect(session?.messages[0]?.text).toBeNull();
  });

  it("no timestamp: pendingTurnStartedAt not set (Branch 26[1])", async () => {
    // A user_message with no timestamp: iso is null → if(iso) body is skipped
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      JSON.stringify({ type: "user_message", payload: { content: "no-ts" } }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "um-no-ts",
    });
    // User message was still counted
    expect(session?.userMessages).toBe(1);
    // No turn duration should be pushed (pendingTurnStartedAt was null)
    expect(session?.turnDurations).toHaveLength(0);
  });
});

// ── handleUserMessage: isSynthetic spread ─────────────────────────────────────

describe("handleUserMessage: isSynthetic spread", () => {
  it("isSynthetic is absent (not false/undefined) for real model (Branch 30[0] false)", async () => {
    const lines = [
      line({
        type: "turn_context",
        timestamp: TS0,
        payload: { model: "claude-sonnet" },
      }),
      line({
        type: "user_message",
        timestamp: TS1,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "um-real-model",
    });
    const msg = session?.messages[0];
    expect(msg?.model).toBe("claude-sonnet");
    // isSynthetic must be ABSENT (not false/undefined), not just falsy
    expect("isSynthetic" in (msg ?? {})).toBe(false);
  });

  it("isSynthetic is true for cursor-default synthetic model (Branch 30[0] true)", async () => {
    // No turn_context and no session_meta model → falls to "cursor-default" which ends with "-default"
    const lines = [
      line({
        type: "user_message",
        timestamp: TS0,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "um-synthetic",
    });
    const msg = session?.messages[0];
    expect(msg?.isSynthetic).toBe(true);
  });
});

// ── handleAssistantMessage: text fallback and model derivation ────────────────

describe("handleAssistantMessage: text and model", () => {
  it("falls back to text field when content is absent (Branch 27[1])", async () => {
    const lines = [
      line({
        type: "assistant_message",
        timestamp: TS0,
        payload: { text: "from text" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "am-text",
    });
    expect(session?.messages[0]?.role).toBe("assistant");
    expect(session?.messages[0]?.text).toBe("from text");
  });

  it("uses acc.model when currentTurnModel is null (Branch 28[1])", async () => {
    // session_meta sets model; no turn_context → currentTurnModel stays null
    const lines = [
      line({
        type: "session_meta",
        timestamp: TS0,
        payload: { cwd: "/p", model: "meta-model" },
      }),
      line({
        type: "assistant_message",
        timestamp: TS1,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "am-meta-model",
    });
    expect(session?.messages[0]?.model).toBe("meta-model");
  });

  it("uses 'cursor-default' when both currentTurnModel and model are null (Branch 29[1])", async () => {
    // No session_meta model, no turn_context → both null → "cursor-default"
    const lines = [
      line({
        type: "assistant_message",
        timestamp: TS0,
        payload: { content: "hi" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "am-nomodel",
    });
    // The resolved cursorResolved is "cursor-default" (both null)
    const msg = session?.messages[0];
    expect(msg?.model).toBeNull();
    // cursor-default ends with "-default" → isSynthetic: true
    expect(msg?.isSynthetic).toBe(true);
  });

  it("agent_message alias routes to handleAssistantMessage", async () => {
    const lines = [
      line({
        type: "agent_message",
        timestamp: TS0,
        payload: { content: "from agent" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "agent-msg",
    });
    expect(session?.assistantMessages).toBe(1);
    expect(session?.messages[0]?.role).toBe("assistant");
  });
});

// ── handleToolCall: name field fallbacks ──────────────────────────────────────

describe("handleToolCall: name field fallbacks", () => {
  it("uses name field directly (control)", async () => {
    const lines = [
      line({ type: "tool_call", timestamp: TS0, payload: { name: "Bash" } }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-name",
    });
    expect(session?.toolUses[0]?.name).toBe("Bash");
  });

  it("falls back to tool_name when name is absent (Branch 31[1])", async () => {
    const lines = [
      line({
        type: "tool_call",
        timestamp: TS0,
        payload: { tool_name: "EditFile" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-toolname",
    });
    expect(session?.toolUses[0]?.name).toBe("EditFile");
  });

  it("falls back to command_name when name and tool_name are absent (Branch 31[2])", async () => {
    const lines = [
      line({
        type: "terminal_command",
        timestamp: TS0,
        payload: { command_name: "ls" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-cmdname",
    });
    expect(session?.toolUses[0]?.name).toBe("ls");
  });

  it("uses 'tool' default when all name fields are absent (Branch 31[3])", async () => {
    const lines = [line({ type: "tool_use", timestamp: TS0, payload: {} })];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-noname",
    });
    expect(session?.toolUses[0]?.name).toBe("tool");
  });

  it("uses payload.input when arguments is null (Branch 32[1], 33[0])", async () => {
    const lines = [
      line({
        type: "function_call",
        timestamp: TS0,
        payload: { name: "fn", input: { k: "v" } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-input",
    });
    expect(session?.toolUses[0]?.input).toEqual({ k: "v" });
  });

  it("uses payload.arguments when present (Branch 33[1] — arguments not null)", async () => {
    const lines = [
      line({
        type: "tool_call",
        timestamp: TS0,
        payload: { name: "fn", arguments: { k: "a" } },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "tc-args",
    });
    expect(session?.toolUses[0]?.input).toEqual({ k: "a" });
  });
});

// ── handleFileEdit: all branches (previously zero coverage) ──────────────────

describe("handleFileEdit: file_edit and its aliases", () => {
  it("file_edit with file field and iso timestamp (Branch 34[0])", async () => {
    const lines = [
      line({
        type: "file_edit",
        timestamp: TS0,
        payload: { file: "src/app.ts" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "fe-file",
    });
    expect(session?.toolUses[0]?.name).toBe("file_edit");
    expect(session?.toolUses[0]?.input).toBe("src/app.ts");
    expect(session?.toolUses[0]?.timestamp).toBe(TS0);
  });

  it("file_edit falls back to path when file is absent (Branch 35[1])", async () => {
    const lines = [
      line({
        type: "file_edit",
        timestamp: TS0,
        payload: { path: "lib/utils.ts" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "fe-path",
    });
    expect(session?.toolUses[0]?.input).toBe("lib/utils.ts");
  });

  it("file_edit input is null when both file and path are absent (Branch 35[2])", async () => {
    const lines = [line({ type: "file_edit", timestamp: TS0, payload: {} })];
    const session = await parseCursorTranscript(lines, {
      sessionId: "fe-null",
    });
    expect(session?.toolUses[0]?.input).toBeNull();
  });

  it("file_edit with no iso uses firstTimestamp as fallback (Branch 34[1])", async () => {
    // First put a session_meta to set firstTimestamp, then a file_edit WITHOUT timestamp
    const lines = [
      line({ type: "session_meta", timestamp: TS0, payload: { cwd: "/p" } }),
      JSON.stringify({ type: "file_edit", payload: { file: "x.ts" } }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "fe-notimestamp",
    });
    expect(session?.toolUses[0]?.timestamp).toBe(TS0);
  });

  it("apply_edit alias routes to handleFileEdit", async () => {
    const lines = [
      line({ type: "apply_edit", timestamp: TS0, payload: { file: "out.ts" } }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "apply-edit",
    });
    expect(session?.toolUses[0]?.name).toBe("file_edit");
    expect(session?.toolUses[0]?.input).toBe("out.ts");
  });

  it("code_edit alias routes to handleFileEdit", async () => {
    const lines = [
      line({
        type: "code_edit",
        timestamp: TS0,
        payload: { path: "index.ts" },
      }),
    ];
    const session = await parseCursorTranscript(lines, {
      sessionId: "code-edit",
    });
    expect(session?.toolUses[0]?.name).toBe("file_edit");
    expect(session?.toolUses[0]?.input).toBe("index.ts");
  });
});
