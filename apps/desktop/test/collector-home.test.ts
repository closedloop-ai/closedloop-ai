/**
 * @file collector-home.test.ts
 * @description Path-discovery coverage for the per-harness `*-home` modules
 * (FEA-2235 coverage gap). These resolve collector roots (honoring env
 * overrides), derive session ids from paths, and enumerate transcript/rollout
 * files. Previously only exercised indirectly through the parsers (which are
 * handed explicit paths), so the resolution + enumeration surface was untested.
 * Every test pins the home via an env override pointed at a temp dir, so nothing
 * depends on the real home directory; env vars are snapshotted and restored.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  sessionIdFromTranscriptPath as claudeSessionId,
  getClaudeHome,
  getProjectsDir,
  listAllTranscriptFiles as listClaudeTranscripts,
} from "../src/main/collectors/claude/claude-home.js";
import {
  collectRolloutFiles,
  getCodexHome,
  getCodexSessionsDir,
  sessionIdFromRolloutPath,
} from "../src/main/collectors/codex/codex-home.js";
import {
  getCopilotCliHome,
  getCopilotCliSessionStateDir,
} from "../src/main/collectors/copilot/copilot-home.js";
import {
  collectTranscriptFiles,
  sessionIdFromTranscriptPath as cursorSessionId,
  getCursorHome,
} from "../src/main/collectors/cursor/cursor-home.js";
import {
  getOpenCodeDbPath,
  getOpenCodeDbWatchFiles,
  getOpenCodeHome,
} from "../src/main/collectors/opencode/opencode-home.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

const ENV_KEYS = [
  "CLAUDE_HOME",
  "CODEX_HOME",
  "CURSOR_HOME",
  "COPILOT_HOME",
  "OPENCODE_DATA_DIR",
] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

function setEnv(
  key: (typeof ENV_KEYS)[number],
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    setEnv(key, originalEnv[key]);
  }
  await cleanupTempDirs();
});

function touch(filePath: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "{}", "utf8");
  return filePath;
}

describe("claude-home", () => {
  test("getClaudeHome honors CLAUDE_HOME, else defaults to ~/.claude", () => {
    setEnv("CLAUDE_HOME", "/custom/claude");
    assert.equal(getClaudeHome(), "/custom/claude");
    setEnv("CLAUDE_HOME", undefined);
    assert.equal(getClaudeHome(), path.join(os.homedir(), ".claude"));
  });

  test("getProjectsDir is <home>/projects", () => {
    setEnv("CLAUDE_HOME", "/custom/claude");
    assert.equal(getProjectsDir(), path.join("/custom/claude", "projects"));
  });

  test("sessionIdFromTranscriptPath strips the .jsonl extension", () => {
    assert.equal(claudeSessionId("/x/projects/proj/ses-abc.jsonl"), "ses-abc");
  });

  test("listAllTranscriptFiles returns top-level session files but not subagent transcripts", () => {
    const home = makeTempDir("claude-home-");
    setEnv("CLAUDE_HOME", home);
    const projects = path.join(home, "projects", "proj-1");
    const top = touch(path.join(projects, "ses-1.jsonl"));
    // Subagent transcript is nested one level deeper and must be excluded.
    touch(path.join(projects, "ses-1", "subagents", "agent-x.jsonl"));
    assert.deepEqual(listClaudeTranscripts(), [top]);
  });

  test("listAllTranscriptFiles returns empty when the projects dir is absent", () => {
    setEnv("CLAUDE_HOME", makeTempDir("claude-empty-"));
    assert.deepEqual(listClaudeTranscripts(), []);
  });
});

describe("codex-home", () => {
  test("getCodexHome honors CODEX_HOME (first comma entry, ~ expanded), else ~/.codex", () => {
    setEnv("CODEX_HOME", "/custom/codex");
    assert.equal(getCodexHome(), "/custom/codex");
    setEnv("CODEX_HOME", "~/codexdata");
    assert.equal(getCodexHome(), path.join(os.homedir(), "codexdata"));
    setEnv("CODEX_HOME", "/first/codex,/second/codex");
    assert.equal(getCodexHome(), "/first/codex");
    setEnv("CODEX_HOME", undefined);
    assert.equal(getCodexHome(), path.join(os.homedir(), ".codex"));
  });

  test("getCodexSessionsDir resolves under the codex home", () => {
    setEnv("CODEX_HOME", "/custom/codex");
    assert.ok(getCodexSessionsDir().startsWith("/custom/codex"));
  });

  test("sessionIdFromRolloutPath extracts the uuid, else strips the rollout- prefix", () => {
    assert.equal(
      sessionIdFromRolloutPath(
        "/s/rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl"
      ),
      "11111111-2222-3333-4444-555555555555"
    );
    assert.equal(
      sessionIdFromRolloutPath("/s/rollout-legacy-name.jsonl"),
      "legacy-name"
    );
  });

  test("collectRolloutFiles walks nested dirs, is depth-bounded, and tolerates a missing root", () => {
    const root = makeTempDir("codex-home-");
    const nested = touch(
      path.join(root, "2026", "06", "24", "rollout-a.jsonl")
    );
    const tooDeep = touch(
      path.join(root, "a", "b", "c", "d", "deep-rollout.jsonl")
    );
    const found = collectRolloutFiles(root, { maxDepth: 3 });
    assert.ok(
      found.includes(nested),
      "nested rollout within depth is collected"
    );
    assert.ok(!found.includes(tooDeep), "rollout beyond maxDepth is excluded");
    assert.deepEqual(collectRolloutFiles("/no/such/codex/root"), []);
  });
});

describe("cursor-home", () => {
  test("getCursorHome honors CURSOR_HOME (~ expanded), else ~/.cursor", () => {
    setEnv("CURSOR_HOME", "/custom/cursor");
    assert.equal(getCursorHome(), "/custom/cursor");
    setEnv("CURSOR_HOME", "~/cursordata");
    assert.equal(getCursorHome(), path.join(os.homedir(), "cursordata"));
    setEnv("CURSOR_HOME", undefined);
    assert.equal(getCursorHome(), path.join(os.homedir(), ".cursor"));
  });

  test("sessionIdFromTranscriptPath uses the parent directory name", () => {
    assert.equal(
      cursorSessionId("/c/projects/p/agent-transcripts/ses-9/ses-9.jsonl"),
      "ses-9"
    );
  });

  test("collectTranscriptFiles collects nested .jsonl transcripts", () => {
    const root = makeTempDir("cursor-home-");
    const t = touch(
      path.join(root, "proj", "agent-transcripts", "ses-1", "ses-1.jsonl")
    );
    assert.deepEqual(collectTranscriptFiles(root), [t]);
  });
});

describe("copilot-home", () => {
  test("getCopilotCliHome honors COPILOT_HOME (~ expanded), else ~/.copilot", () => {
    setEnv("COPILOT_HOME", "/custom/copilot");
    assert.equal(getCopilotCliHome(), "/custom/copilot");
    setEnv("COPILOT_HOME", "~/copilotdata");
    assert.equal(getCopilotCliHome(), path.join(os.homedir(), "copilotdata"));
    setEnv("COPILOT_HOME", undefined);
    assert.equal(getCopilotCliHome(), path.join(os.homedir(), ".copilot"));
  });

  test("getCopilotCliSessionStateDir is <home>/session-state", () => {
    setEnv("COPILOT_HOME", "/custom/copilot");
    assert.equal(
      getCopilotCliSessionStateDir(),
      path.join("/custom/copilot", "session-state")
    );
  });
});

describe("opencode-home", () => {
  test("getOpenCodeHome honors OPENCODE_DATA_DIR (~ expanded)", () => {
    setEnv("OPENCODE_DATA_DIR", "/custom/opencode");
    assert.equal(getOpenCodeHome(), "/custom/opencode");
    setEnv("OPENCODE_DATA_DIR", "~/ocdata");
    assert.equal(getOpenCodeHome(), path.join(os.homedir(), "ocdata"));
  });

  test("getOpenCodeDbPath is <home>/opencode.db", () => {
    setEnv("OPENCODE_DATA_DIR", "/custom/opencode");
    assert.equal(
      getOpenCodeDbPath(),
      path.join("/custom/opencode", "opencode.db")
    );
  });

  test("getOpenCodeDbWatchFiles lists the db plus its WAL/SHM sidecars", () => {
    assert.deepEqual(getOpenCodeDbWatchFiles(), [
      "opencode.db",
      "opencode.db-wal",
      "opencode.db-shm",
    ]);
  });
});
