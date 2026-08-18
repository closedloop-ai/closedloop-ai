/**
 * @file claude-human-turns.test.ts
 * @description Which `type:"user"` transcript entries count as HUMAN steering. The agent runtime reuses the user role for synthetic turns — tool-result-only turns, `isMeta` expansions, compaction summaries, `origin.kind` notifications, ScheduleWakeup re-injections, system-reminder blocks, teammate messages, and local-command stdout — and each must be excluded without dropping a genuine prompt (FEA-2192 / FEA-2641 / FEA-2927 / FEA-3124).
 *
 * Carved out of `collectors-parsers.test.ts`, which now covers the remaining
 * four harnesses (Copilot, OpenCode, Codex, Cursor) in one grandfathered file,
 * so the Claude parser's contract is readable from the file tree. Behavior is
 * unchanged — these are the same tests, relocated.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

describe("Claude parser human-turn classification", () => {
  test("Claude parser excludes tool-result-only user turns from human messages (FEA-2192)", async () => {
    const dir = makeTempDir("claude-toolresult-");
    const filePath = writeJsonl(dir, "claude-toolresult.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Read the config file." },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "config.ts" },
            },
          ],
        },
      },
      {
        // Synthetic tool-result turn: delivered as a `user` entry but carrying no
        // human-authored text. Must NOT be counted as human steering (FEA-2192).
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "export const config = {};",
            },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:03.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Only the genuine prompt counts; the tool-result turn is not a human message.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Read the config file.");
    // The tool_result is still back-linked to its tool_use (applyToolResult runs).
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0]?.output, "export const config = {};");
  });

  test("Claude parser keeps user turns mixing text and tool_result as human messages (FEA-2192)", async () => {
    const dir = makeTempDir("claude-mixed-");
    const filePath = writeJsonl(dir, "claude-mixed.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "config.ts" },
            },
          ],
        },
      },
      {
        // A user turn carrying BOTH a tool_result and human-authored text — a
        // genuine prompt that must NOT be skipped (FEA-2192).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "export const config = {};",
            },
            { type: "text", text: "Now refactor it." },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The mixed turn still counts as one human message and keeps its text...
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Now refactor it.");
    // ...while the tool_result in the same turn is still back-linked to its tool.
    assert.equal(parsed.toolUses[0]?.output, "export const config = {};");
  });

  test("Claude parser excludes synthetic user turns (meta, compaction, task-notification) from human messages (FEA-2192)", async () => {
    const dir = makeTempDir("claude-synthetic-");
    const filePath = writeJsonl(dir, "claude-synthetic.jsonl", [
      {
        // Genuine human prompt.
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: { role: "user", content: "Run the review." },
      },
      {
        // Slash-command expansion injected as a meta turn.
        type: "user",
        isMeta: true,
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "# Comprehensive Review\nRun..." }],
        },
      },
      {
        // Auto-compaction continuation summary.
        type: "user",
        isCompactSummary: true,
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation.",
        },
      },
      {
        // Background-task completion notification (origin.kind).
        type: "user",
        origin: { kind: "task-notification" },
        timestamp: "2024-03-09T16:00:03.000Z",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>abc</task-id>\n<result>DONE</result>\n</task-notification>",
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:04.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [{ type: "text", text: "On it." }],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Only the genuine prompt is a human message; meta/compaction/task-notification
    // turns reuse the `user` role but are not human steering (FEA-2192).
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Run the review.");
  });

  test("Claude parser still captures tool_result on a synthetic user turn (FEA-2192)", async () => {
    const dir = makeTempDir("claude-synthetic-toolresult-");
    const filePath = writeJsonl(dir, "claude-synthetic-toolresult.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "config.ts" },
            },
          ],
        },
      },
      {
        // Synthetic (isMeta) turn that ALSO carries a tool_result. The synthetic
        // guard must skip the human message, but applyToolResult runs first and
        // unconditionally, so the tool output must still be back-linked (FEA-2192).
        type: "user",
        isMeta: true,
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "export const config = {};",
            },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The synthetic turn adds no human message...
    assert.equal(parsed.userMessages, 0);
    assert.equal(parsed.messages.filter((m) => m.role === "human").length, 0);
    // ...but its tool_result is still captured and back-linked to the tool_use.
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0]?.output, "export const config = {};");
  });

  test("Claude parser excludes ScheduleWakeup XML re-injection from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-xml-");
    const filePath = writeJsonl(dir, "claude-wakeup-xml.jsonl", [
      {
        // Genuine typed prompt — must still count.
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Run the suite." },
      },
      {
        // Assistant records the ScheduleWakeup prompt to re-inject later.
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_1",
              name: "ScheduleWakeup",
              input: { prompt: "/babysit-pr 2257 --no-merge" },
            },
          ],
        },
      },
      {
        // Harness re-injects the scheduled prompt as expanded slash-command XML.
        // Must NOT be counted as a human message (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "<command-message>babysit-pr</command-message>\n<command-name>/babysit-pr</command-name>\n<command-args>2257 --no-merge</command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Only the genuine prompt counts; the XML re-injection is excluded.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Run the suite.");
    // The ScheduleWakeup tool_use is still captured even though the re-injection
    // is excluded from human messages.
    const wakeupTool = parsed.toolUses.find(
      (tu) => tu.name === "ScheduleWakeup"
    );
    assert.ok(wakeupTool, "ScheduleWakeup tool_use must be captured");
  });

  test("Claude parser excludes ScheduleWakeup plain-text re-injection from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-plain-");
    const filePath = writeJsonl(dir, "claude-wakeup-plain.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Start the task." },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_2",
              name: "ScheduleWakeup",
              input: { prompt: "check the deploy status" },
            },
          ],
        },
      },
      {
        // Harness re-injects the prompt verbatim as plain text. Must NOT count (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: { role: "user", content: "check the deploy status" },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Start the task.");
  });

  test("Claude parser consumes a scheduled prompt per firing — a later genuine identical prompt still counts (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-consume-");
    const filePath = writeJsonl(dir, "claude-wakeup-consume.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_consume",
              name: "ScheduleWakeup",
              input: { prompt: "check status" },
            },
          ],
        },
      },
      {
        // The single scheduled firing re-injects the prompt: NOT counted, and
        // this match CONSUMES the recorded firing.
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: { role: "user", content: "check status" },
      },
      {
        // A human later GENUINELY types the same text. With the firing already
        // consumed, this must count as a human message.
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: { role: "user", content: "check status" },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "check status");
    assert.equal(humanMessages[0]?.timestamp, "2024-03-09T16:00:02.000Z");
  });

  test("Claude parser excludes slash-normalized ScheduleWakeup XML re-injection from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-slashnorm-");
    const filePath = writeJsonl(dir, "claude-wakeup-slashnorm.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Go ahead." },
      },
      {
        // Older transcript records the prompt WITHOUT the leading slash.
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_3",
              name: "ScheduleWakeup",
              input: { prompt: "babysit-pr 2257 --no-merge" },
            },
          ],
        },
      },
      {
        // XML re-injection carries the leading slash in <command-name>; the
        // parser strips it when matching against the slash-free recorded prompt
        // (FEA-2641). Must NOT count as a human message.
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/babysit-pr</command-name>\n<command-args>2257 --no-merge</command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Go ahead.");
  });

  test("Claude parser excludes <local-command-stdout> user entries from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-local-stdout-");
    const filePath = writeJsonl(dir, "claude-local-stdout.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Build it." },
      },
      {
        // Local command output echoed back as a user entry — not human input (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: "<local-command-stdout>Bye!</local-command-stdout>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The local-command-stdout echo must not be counted as a human message.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Build it.");
    // FEA-3112: the echo is kept in the transcript as a role:"system" message
    // (not dropped), so the session-detail trace still shows the command output.
    const systemMessages = parsed.messages.filter((m) => m.role === "system");
    assert.equal(systemMessages.length, 1);
    assert.equal(
      systemMessages[0]?.text,
      "<local-command-stdout>Bye!</local-command-stdout>"
    );
  });

  test("Claude parser excludes teammate-injected user entries from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-teammate-msg-");
    const filePath = writeJsonl(dir, "claude-teammate-msg.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Keep going." },
      },
      {
        // Agent-to-agent message injected as a user entry — not human steering (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: "Another Claude session sent a message: check the PR status",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Keep going.");
  });

  test("Claude parser counts genuine typed slash command with no matching ScheduleWakeup as a human message (FEA-2641)", async () => {
    const dir = makeTempDir("claude-genuine-slash-");
    const filePath = writeJsonl(dir, "claude-genuine-slash.jsonl", [
      {
        // User types a slash command; no ScheduleWakeup recorded this prompt,
        // so it is genuine human input and must count (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: {
          role: "user",
          content:
            "<command-name>/model</command-name>\n<command-args></command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // No matching ScheduleWakeup → must be counted as a human message.
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.messages.filter((m) => m.role === "human").length, 1);
  });

  test("Claude parser counts typed /exit as a human turn and keeps the slash-command record (FEA-3124)", async () => {
    const dir = makeTempDir("claude-exit-cmd-");
    const filePath = writeJsonl(dir, "claude-exit-cmd.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Build it." },
      },
      {
        // Typed /exit — a human-run command IS a human turn (FEA-3124 ruling
        // 2026-07-16, PRD-526: userMessages is the mechanical count of records
        // a human submitted; steering-vs-automation is the attribution layer's
        // call). Reverses the FEA-2641 non-steering carve-out.
        type: "user",
        timestamp: "2024-03-09T18:00:00.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 2);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 2);
    assert.equal(humanMessages[0]?.text, "Build it.");
    assert.ok(
      humanMessages[1]?.text?.includes("<command-name>/exit</command-name>"),
      "typed /exit must be recorded as a role:human message"
    );
    assert.ok(
      parsed.slashCommands.some((c) => c.name === "/exit"),
      "typed /exit must still be recorded as a slash command"
    );
  });

  test("Claude parser counts typed /quit as a human turn and keeps the slash-command record (FEA-3124)", async () => {
    const dir = makeTempDir("claude-quit-cmd-");
    const filePath = writeJsonl(dir, "claude-quit-cmd.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Build it." },
      },
      {
        // /quit is the CLI alias of /exit — same FEA-3124 mechanical-count
        // ruling applies.
        type: "user",
        timestamp: "2024-03-09T18:00:00.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/quit</command-name>\n<command-message>quit</command-message>\n<command-args></command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 2);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 2);
    assert.ok(
      humanMessages[1]?.text?.includes("<command-name>/quit</command-name>"),
      "typed /quit must be recorded as a role:human message"
    );
    assert.ok(
      parsed.slashCommands.some((c) => c.name === "/quit"),
      "typed /quit must still be recorded as a slash command"
    );
  });

  test("Claude parser counts user entries with origin.kind='human' as genuine messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-origin-human-");
    const filePath = writeJsonl(dir, "claude-origin-human.jsonl", [
      {
        // Newer harness versions stamp origin.kind:"human" on genuinely-typed
        // prompts. Must NOT be treated as synthetic — it is real human input
        // (FEA-2641; contrast: origin.kind:"task-notification" IS synthetic).
        type: "user",
        origin: { kind: "human" },
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Deploy to staging." },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Deploy to staging.");
  });

  test("Claude parser excludes system-reminder-only user entries from human messages (FEA-2927)", async () => {
    const dir = makeTempDir("claude-sysreminder-");
    const filePath = writeJsonl(dir, "claude-sysreminder.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Build it." },
      },
      {
        // System-reminder injected by the harness — NOT human steering (FEA-2927).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content:
            "<system-reminder>\nThe task tools haven't been used recently. Consider using TaskCreate.\n</system-reminder>",
        },
      },
      {
        // Multiple system-reminder blocks — also NOT human steering.
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "<system-reminder>\nMCP server instructions block 1.\n</system-reminder>\n\n<system-reminder>\nDeferred tool listing block 2.\n</system-reminder>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Build it.");
  });

  test("Claude parser handles invalid ScheduleWakeup inputs without crashing and still counts subsequent genuine prompts (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-edge-");
    const filePath = writeJsonl(dir, "claude-wakeup-edge.jsonl", [
      {
        // null prompt — must not crash or record anything in scheduledPrompts.
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_null",
              name: "ScheduleWakeup",
              input: { prompt: null },
            },
          ],
        },
      },
      {
        // Empty string prompt — must not record (empty after trim).
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_empty",
              name: "ScheduleWakeup",
              input: { prompt: "" },
            },
          ],
        },
      },
      {
        // Numeric prompt — not a string, must not be recorded.
        type: "assistant",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_num",
              name: "ScheduleWakeup",
              input: { prompt: 42 },
            },
          ],
        },
      },
      {
        // Missing prompt field entirely — must not crash.
        type: "assistant",
        timestamp: "2024-03-09T16:00:03.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_nofield",
              name: "ScheduleWakeup",
              input: {},
            },
          ],
        },
      },
      {
        // Genuine human prompt after all the invalid edge inputs — must still count.
        type: "user",
        timestamp: "2024-03-09T16:00:04.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Proceed normally." },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Genuine prompt after all invalid ScheduleWakeup inputs must count.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Proceed normally.");
    // All four ScheduleWakeup tool_uses are still captured despite invalid inputs.
    assert.equal(
      parsed.toolUses.filter((tu) => tu.name === "ScheduleWakeup").length,
      4
    );
  });
});
