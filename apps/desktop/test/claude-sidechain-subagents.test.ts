/**
 * @file claude-sidechain-subagents.test.ts
 * @description Subagent identity across the two representations the harness writes: inline `isSidechain` entries in the parent transcript, and sibling `agent-*.jsonl` sidecar files. Covers parent linkage, the self-parent guard, tool-use de-duplication where both representations carry one call, and the sandbox rule that a symlinked sidecar outside the session directory is not folded.
 *
 * Carved out of `collectors-parsers.test.ts`, which now covers the remaining
 * four harnesses (Copilot, OpenCode, Codex, Cursor) in one grandfathered file,
 * so the Claude parser's contract is readable from the file tree. Behavior is
 * unchanged — these are the same tests, relocated.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

describe("Claude parser sidechain + sidecar subagents", () => {
  test("Claude parser carries inline sidechain parentUuid into subagent hierarchy", async () => {
    const dir = makeTempDir("claude-sidechain-");
    const filePath = writeJsonl(dir, "claude-sidechain.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        uuid: "parent-sidechain",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_parent_sidechain",
              name: "Read",
              input: { file_path: "parent.ts" },
            },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        uuid: "child-sidechain",
        parentUuid: "parent-sidechain",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_sidechain",
              name: "Read",
              input: { file_path: "nested.ts" },
            },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.subagents?.length, 2);
    const child = parsed.subagents?.find(
      (subagent) => subagent.id === "child-sidechain"
    );
    assert.equal(child?.parentId, "parent-sidechain");
    assert.equal(child?.toolUses?.[0]?.subagentId, "child-sidechain");
  });

  test("Claude parser does not create self-parented sidechain subagents from fallback ids", async () => {
    const dir = makeTempDir("claude-sidechain-fallback-");
    const filePath = path.join(dir, "claude-sidechain-fallback.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        parentUuid: "parent-only-id",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "fallback.ts" },
            },
          ],
        },
      })}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.subagents?.[0]?.id, "parent-only-id");
    assert.equal(parsed.subagents?.[0]?.parentId, null);
  });

  test("Claude parser de-dupes matching inline sidechain and sidecar tool uses", async () => {
    const dir = makeTempDir("claude-sidechain-sidecar-");
    const sessionId = "claude-sidechain-sidecar";
    const nativeSubagentId = "agent-dup";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      filePath,
      [
        {
          type: "assistant",
          timestamp: "2024-03-09T16:00:00.000Z",
          uuid: nativeSubagentId,
          isSidechain: true,
          message: {
            role: "assistant",
            model: "claude-opus-4-5",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            content: [
              {
                type: "tool_use",
                id: "toolu_duplicate",
                name: "Read",
                input: { file_path: "inline.ts" },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: "tool_use",
              id: "toolu_duplicate",
              name: "Read",
              input: { file_path: "inline.ts" },
            },
          ],
        },
      })}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    const subagent = parsed.subagents?.find(
      (candidate) => candidate.id === nativeSubagentId
    );
    assert.equal(subagent?.toolUses?.length, 1);
    assert.equal(subagent?.toolUses?.[0]?.id, "toolu_duplicate");
    assert.deepEqual(subagent?.toolUses?.[0]?.input, {
      file_path: "inline.ts",
    });
  });

  test("sidecar conflicts remove the matching inline invocation everywhere", async () => {
    const dir = makeTempDir("claude-sidechain-conflict-");
    const sessionId = "claude-sidechain-conflict";
    const nativeSubagentId = "agent-conflict";
    const toolUseId = "toolu_sidecar_conflict";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeJsonl(dir, `${sessionId}.jsonl`, [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        uuid: nativeSubagentId,
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: "Read",
              input: { file_path: "inline.ts" },
            },
          ],
        },
      },
    ]);
    writeFileSync(
      path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
      [
        {
          type: "assistant",
          timestamp: "2024-03-09T16:00:00.000Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: "Read",
                input: { file_path: "inline.ts" },
              },
            ],
          },
        },
        {
          type: "user",
          timestamp: "2024-03-09T16:00:01.000Z",
          message: {
            content: [
              { type: "tool_result", tool_use_id: toolUseId, content: "first" },
            ],
          },
        },
        {
          type: "user",
          timestamp: "2024-03-09T16:00:02.000Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: "second",
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(JSON.stringify(parsed).includes(toolUseId), false);
  });

  test("Claude one-read sidecar fold preserves completion alongside an oversized input", async () => {
    const dir = makeTempDir("claude-sidecar-result-");
    const sessionId = "claude-sidecar-result";
    const nativeSubagentId = "agent-result";
    const filePath = writeJsonl(dir, `${sessionId}.jsonl`, [
      {
        type: "user",
        timestamp: "2026-08-17T20:00:00.000Z",
        message: { role: "user", content: "work" },
      },
      {
        type: "assistant",
        timestamp: "2026-08-17T20:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: "text", text: "done" }],
        },
      },
    ]);
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const oversizedInput = {
      file_path: "src/large.ts",
      content: "x".repeat(5000),
    };
    writeFileSync(
      path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
      `${[
        {
          type: "user",
          timestamp: "2026-08-17T20:00:01.000Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_one_read",
                content: "finished",
              },
            ],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-08-17T20:00:00.500Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_one_read",
                name: "Write",
                input: oversizedInput,
              },
            ],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed);
    const toolUse = parsed.subagents?.find(
      (subagent) => subagent.id === nativeSubagentId
    )?.toolUses?.[0];
    assert.equal(toolUse?.id, "toolu_one_read");
    // ISS-6480 retired the drop this used to pin. The contract under test is
    // the fold itself: completion evidence survives for a tool use whose input
    // exceeds the old bound — which now also survives.
    assert.deepEqual(toolUse?.input, oversizedInput);
    assert.equal(toolUse?.output, "finished");
    assert.equal(toolUse?.resultTimestamp, "2026-08-17T20:00:01.000Z");
    assert.equal(toolUse?.isError, undefined);
  });

  test("Claude parser ignores symlinked subagent sidecars outside the session directory", async () => {
    const dir = makeTempDir("claude-sidecar-");
    const outsideDir = makeTempDir("claude-sidecar-out-");
    try {
      const sessionId = "claude-sidecar";
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      const subagentsDir = path.join(dir, sessionId, "subagents");
      const outsideSubagent = path.join(outsideDir, "agent-outside.jsonl");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(
        filePath,
        [
          {
            type: "user",
            timestamp: "2024-03-09T16:00:00.000Z",
            cwd: "/Users/dev/proj",
            message: { role: "user", content: "hello" },
          },
          {
            type: "assistant",
            timestamp: "2024-03-09T16:00:05.000Z",
            message: {
              model: "claude-opus-4-5",
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              content: [{ type: "text", text: "hello" }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf8"
      );
      writeFileSync(
        outsideSubagent,
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2024-03-09T16:00:06.000Z",
          message: {
            model: "claude-opus-4-5",
            usage: {
              input_tokens: 1000,
              output_tokens: 1000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            content: [{ type: "text", text: "outside" }],
          },
        })}\n`,
        "utf8"
      );
      symlinkSync(
        outsideSubagent,
        path.join(subagentsDir, "agent-outside.jsonl")
      );

      const parsed = await parseClaudeFile(filePath);

      assert.ok(parsed);
      assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
