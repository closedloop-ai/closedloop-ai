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
  walkSubagentTranscripts,
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
  getVscodeWorkspaceStorageDir,
  workspacePathFromUri,
} from "../src/main/collectors/copilot/copilot-home.js";
import {
  collectTranscriptFiles,
  sessionIdFromTranscriptPath as cursorSessionId,
  getCursorHome,
} from "../src/main/collectors/cursor/cursor-home.js";
import {
  getOpenCodeConfigHome,
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
  // ISS-4527 review: the Copilot-Chat (VS Code) workspace-storage root override,
  // isolated + restored so a real local Copilot Chat history cannot leak into
  // the default-path assertion and so the seeded all-views smoke can pin it.
  "COPILOT_VSCODE_STORAGE_DIR",
  // ISS-5302: the win32 arm of the VS Code workspace-storage default reads
  // `%APPDATA%`. Snapshotted here so the platform-default case can pin it (and
  // clear it) without leaking either state out of the test.
  "APPDATA",
  "OPENCODE_DATA_DIR",
  // ISS-4386: the OpenCode CONFIG home (agents/commands live here, not in the
  // data home). Isolated + restored so a real local `$OPENCODE_CONFIG_DIR` /
  // `$OPENCODE_CONFIG` / `$XDG_CONFIG_HOME` cannot leak into the default-path
  // assertions.
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "XDG_CONFIG_HOME",
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
    Reflect.deleteProperty(process.env, key);
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

/**
 * Run `fn` with `process.platform` stubbed, then restore the ORIGINAL property
 * descriptor — assigning the saved value back would leave a plain data property
 * where Node had its own, which every later test in the process would inherit.
 */
function withPlatform(platform: typeof process.platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    fn();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
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

  test("walkSubagentTranscripts returns a direct sidecar keyed by its bare basename", () => {
    const subagents = path.join(makeTempDir("claude-walk-"), "subagents");
    const direct = touch(path.join(subagents, "agent-aaaa.jsonl"));
    assert.deepEqual(walkSubagentTranscripts(subagents), [
      { filePath: direct, relId: "agent-aaaa" },
    ]);
  });

  test("walkSubagentTranscripts is empty when the subagents dir is absent", () => {
    const missing = path.join(makeTempDir("claude-walk-absent-"), "subagents");
    assert.deepEqual(walkSubagentTranscripts(missing), []);
  });

  test("walkSubagentTranscripts RECURSES into nested workflow agents (FEA-3420)", () => {
    // Direct sidecar sits at depth 0; a Claude workflow agent lives one level
    // deeper under workflows/<workflow-id>/agent-*.jsonl. The old one-level
    // readdir skipped the nested file entirely.
    const subagents = path.join(
      makeTempDir("claude-walk-nested-"),
      "subagents"
    );
    const direct = touch(path.join(subagents, "agent-direct.jsonl"));
    const nested = touch(
      path.join(subagents, "workflows", "wf-1", "agent-nested.jsonl")
    );
    assert.deepEqual(walkSubagentTranscripts(subagents), [
      { filePath: direct, relId: "agent-direct" },
      // Nested id is the subagents/-relative path with separators folded to __,
      // so the parent fold keeps it distinct from a same-named direct sidecar.
      { filePath: nested, relId: "workflows__wf-1__agent-nested" },
    ]);
  });

  test("walkSubagentTranscripts gives identically named agents in different workflows collision-free ids (no double-count)", () => {
    // Two workflows each own an `agent-x.jsonl`. A bare-basename identity would
    // collapse them into one subagent row (dropping one agent's tokens/tools);
    // the workflow-qualified relId keeps both, folded exactly once each.
    const subagents = path.join(
      makeTempDir("claude-walk-collide-"),
      "subagents"
    );
    const a = touch(path.join(subagents, "workflows", "wf-a", "agent-x.jsonl"));
    const b = touch(path.join(subagents, "workflows", "wf-b", "agent-x.jsonl"));
    assert.deepEqual(walkSubagentTranscripts(subagents), [
      { filePath: a, relId: "workflows__wf-a__agent-x" },
      { filePath: b, relId: "workflows__wf-b__agent-x" },
    ]);
  });

  test("walkSubagentTranscripts keeps ids injective when a path segment contains the __ delimiter (FEA-3420 review)", () => {
    // Two DIFFERENT nested paths that would fold to the SAME bare-`__`-joined
    // relId (`workflows__wf__1__agent-x`) and collapse one agent's transcript
    // onto the other's row — the exact token-loss the walk exists to prevent:
    //   workflows/wf__1/agent-x    (a segment literally contains `__`)
    //   workflows__wf/1/agent-x    (a different split of the same characters)
    // Per-segment `%`/`_` escaping makes the join injective, so the two survive
    // as distinct relIds.
    const subagents = path.join(makeTempDir("claude-walk-delim-"), "subagents");
    const a = touch(
      path.join(subagents, "workflows", "wf__1", "agent-x.jsonl")
    );
    const b = touch(
      path.join(subagents, "workflows__wf", "1", "agent-x.jsonl")
    );
    const results = walkSubagentTranscripts(subagents);
    const relIds = results.map((r) => r.relId);
    assert.equal(
      new Set(relIds).size,
      2,
      "distinct nested paths must not collide onto one relId"
    );
    // Sorted by relId (hermetic order): `%` (0x25) sorts before `_` (0x5F), so
    // the `workflows__wf`-parent path (b) precedes the `wf__1`-child path (a).
    assert.deepEqual(results, [
      { filePath: b, relId: "workflows%5F%5Fwf__1__agent-x" },
      { filePath: a, relId: "workflows__wf%5F%5F1__agent-x" },
    ]);
  });

  test("walkSubagentTranscripts returns only agent-*.jsonl files, ignoring workflow journal/index files", () => {
    const subagents = path.join(
      makeTempDir("claude-walk-filter-"),
      "subagents"
    );
    const agent = touch(
      path.join(subagents, "workflows", "wf-1", "agent-keep.jsonl")
    );
    // Non-agent transcript siblings must be ignored.
    touch(path.join(subagents, "workflows", "wf-1", "journal.jsonl"));
    touch(path.join(subagents, "workflows", "wf-1", "index.json"));
    touch(path.join(subagents, "agent-keep.txt"));
    assert.deepEqual(walkSubagentTranscripts(subagents), [
      { filePath: agent, relId: "workflows__wf-1__agent-keep" },
    ]);
  });

  test("walkSubagentTranscripts is deterministically sorted by relId across machines", () => {
    // Discovery order is filesystem-dependent; the fold appends order-sensitive
    // arrays, so the walk must return a stable relId-sorted list.
    const subagents = path.join(makeTempDir("claude-walk-sort-"), "subagents");
    touch(path.join(subagents, "agent-z.jsonl"));
    touch(path.join(subagents, "agent-a.jsonl"));
    touch(path.join(subagents, "workflows", "wf-2", "agent-m.jsonl"));
    touch(path.join(subagents, "workflows", "wf-1", "agent-m.jsonl"));
    assert.deepEqual(
      walkSubagentTranscripts(subagents).map((e) => e.relId),
      [
        "agent-a",
        "agent-z",
        "workflows__wf-1__agent-m",
        "workflows__wf-2__agent-m",
      ]
    );
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

  test("getVscodeWorkspaceStorageDir honors COPILOT_VSCODE_STORAGE_DIR (~ expanded), else the platform default (ISS-4527)", () => {
    // The override lets the seeded all-views smoke point Copilot-Chat discovery
    // at an empty dir so it never scans the operator's real VS Code workspace
    // storage (which COPILOT_HOME does NOT isolate — that only covers the CLI).
    setEnv("COPILOT_VSCODE_STORAGE_DIR", "/custom/vscode-ws");
    assert.equal(getVscodeWorkspaceStorageDir(), "/custom/vscode-ws");
    setEnv("COPILOT_VSCODE_STORAGE_DIR", "~/vscode-ws");
    assert.equal(
      getVscodeWorkspaceStorageDir(),
      path.join(os.homedir(), "vscode-ws")
    );
    // Cleared → falls back to the real, unisolated os.homedir()-rooted default,
    // so the default path is still under the home directory.
    setEnv("COPILOT_VSCODE_STORAGE_DIR", undefined);
    assert.ok(
      getVscodeWorkspaceStorageDir().startsWith(os.homedir()),
      "default VS Code workspace-storage root is under the home directory"
    );
  });

  test("getVscodeWorkspaceStorageDir resolves a DIFFERENT real root per platform (ISS-5302)", () => {
    // With the override cleared the platform switch is what answers, and the
    // three arms are three genuinely different locations. A wrong arm does not
    // fail loudly — it scans a directory that does not exist on that OS, so
    // Copilot Chat silently reads as "never used" for every user on it.
    setEnv("COPILOT_VSCODE_STORAGE_DIR", undefined);
    const home = os.homedir();
    withPlatform("darwin", () => {
      assert.equal(
        getVscodeWorkspaceStorageDir(),
        path.join(
          home,
          "Library",
          "Application Support",
          "Code",
          "User",
          "workspaceStorage"
        )
      );
    });
    withPlatform("win32", () => {
      setEnv("APPDATA", path.join("C:", "Users", "dev", "Roaming"));
      assert.equal(
        getVscodeWorkspaceStorageDir(),
        path.join(
          "C:",
          "Users",
          "dev",
          "Roaming",
          "Code",
          "User",
          "workspaceStorage"
        )
      );
      // A stripped environment with no %APPDATA% must still resolve ABSOLUTELY,
      // under the home directory — a relative "Code/User/…" would be scanned
      // against whatever cwd the app happened to launch from.
      setEnv("APPDATA", undefined);
      assert.equal(
        getVscodeWorkspaceStorageDir(),
        path.join(
          home,
          "AppData",
          "Roaming",
          "Code",
          "User",
          "workspaceStorage"
        )
      );
    });
    withPlatform("linux", () => {
      assert.equal(
        getVscodeWorkspaceStorageDir(),
        path.join(home, ".config", "Code", "User", "workspaceStorage")
      );
    });
  });

  test("workspacePathFromUri converts only a file: URI, and never loses the workspace to one it cannot convert (ISS-5302)", () => {
    // The result is stored as the session's `cwd`, so an empty string would
    // present the workspace as the filesystem ROOT and group every unattributed
    // Copilot Chat session under it. Absent stays absent.
    assert.equal(workspacePathFromUri(undefined), null);
    assert.equal(workspacePathFromUri(""), null);
    assert.equal(workspacePathFromUri(42), null);
    // Already a plain path: returned verbatim, never re-encoded.
    assert.equal(workspacePathFromUri("/home/dev/proj"), "/home/dev/proj");
    // A convertible file: URI is percent-decoded into a real path.
    assert.equal(
      workspacePathFromUri("file:///home/dev/my%20proj"),
      "/home/dev/my proj"
    );
    // A file: URI carrying a HOST cannot be converted on POSIX
    // (ERR_INVALID_FILE_URL_HOST). The fallback still yields a readable path
    // rather than dropping the workspace over a URL-shape problem.
    assert.equal(
      workspacePathFromUri("file://server/share/my%20proj"),
      "server/share/my proj"
    );
    // ...and when the decode ALSO throws (a truncated escape), the raw
    // remainder is kept, so no input can make this return null-by-accident.
    assert.equal(
      workspacePathFromUri("file://server/%E0%A4%A"),
      "server/%E0%A4%A"
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

  test("getOpenCodeConfigHome uses OPENCODE_CONFIG_DIR verbatim as the config home (P1 review, ISS-4386)", () => {
    // OPENCODE_CONFIG_DIR is the DIRECTORY override — it already IS the config
    // home that holds agents/ + commands/, so it is used as-is (no dirname).
    setEnv("OPENCODE_CONFIG_DIR", "/custom/oc-dir");
    assert.equal(getOpenCodeConfigHome(), "/custom/oc-dir");
    // `~` is expanded.
    setEnv("OPENCODE_CONFIG_DIR", "~/oc-dir");
    assert.equal(getOpenCodeConfigHome(), path.join(os.homedir(), "oc-dir"));
    // Precedence: OPENCODE_CONFIG_DIR wins over OPENCODE_CONFIG.
    setEnv("OPENCODE_CONFIG_DIR", "/custom/oc-dir");
    setEnv("OPENCODE_CONFIG", "/other/opencode.json");
    assert.equal(getOpenCodeConfigHome(), "/custom/oc-dir");
  });

  test("getOpenCodeConfigHome returns the parent of an OPENCODE_CONFIG file only when it is a real file (P1 review, ISS-4386)", () => {
    setEnv("OPENCODE_CONFIG_DIR", undefined);
    const ocRoot = makeTempDir("oc-config-file-");
    const configFile = touch(path.join(ocRoot, "opencode.json"));
    // A real config FILE → its containing dir is the config home so sibling
    // agents/ + commands/ are discovered.
    setEnv("OPENCODE_CONFIG", configFile);
    assert.equal(getOpenCodeConfigHome(), ocRoot);
  });

  test("getOpenCodeConfigHome ignores an OPENCODE_CONFIG that points at a DIRECTORY (P1 review)", () => {
    if (process.platform === "win32") {
      return; // win32 resolves to %APPDATA%/opencode below.
    }
    setEnv("OPENCODE_CONFIG_DIR", undefined);
    setEnv("XDG_CONFIG_HOME", undefined);
    // OPENCODE_CONFIG set to a config DIRECTORY (a plausible misread) must NOT
    // repoint the scan root to that directory's PARENT — falls through to the
    // XDG/default home instead of scanning `<parent>/agents`.
    const dir = makeTempDir("oc-config-as-dir-");
    setEnv("OPENCODE_CONFIG", dir);
    assert.equal(
      getOpenCodeConfigHome(),
      path.join(os.homedir(), ".config", "opencode")
    );
  });

  test("getOpenCodeConfigHome ignores a bare-filename OPENCODE_CONFIG (dirname '.') (P1 review)", () => {
    if (process.platform === "win32") {
      return;
    }
    setEnv("OPENCODE_CONFIG_DIR", undefined);
    setEnv("XDG_CONFIG_HOME", undefined);
    // dirname("opencode.json") === "." would scan cwd-relative `./agents`;
    // reject it and fall through to the default home.
    setEnv("OPENCODE_CONFIG", "opencode.json");
    assert.equal(
      getOpenCodeConfigHome(),
      path.join(os.homedir(), ".config", "opencode")
    );
  });

  test("getOpenCodeConfigHome honors XDG_CONFIG_HOME over the default (ISS-4386)", () => {
    if (process.platform === "win32") {
      return; // win32 resolves to %APPDATA%/opencode, not XDG.
    }
    // Clear the higher-precedence OPENCODE_CONFIG_DIR / OPENCODE_CONFIG so XDG is
    // the winning branch.
    setEnv("OPENCODE_CONFIG_DIR", undefined);
    setEnv("OPENCODE_CONFIG", undefined);
    setEnv("XDG_CONFIG_HOME", "/xdg/config");
    assert.equal(getOpenCodeConfigHome(), path.join("/xdg/config", "opencode"));
  });

  test("getOpenCodeConfigHome defaults to ~/.config/opencode (ISS-4386)", () => {
    if (process.platform === "win32") {
      return; // win32 resolves to %APPDATA%/opencode, not ~/.config.
    }
    // Clear ALL higher-precedence inputs so the ~/.config default is exercised.
    setEnv("OPENCODE_CONFIG_DIR", undefined);
    setEnv("OPENCODE_CONFIG", undefined);
    setEnv("XDG_CONFIG_HOME", undefined);
    assert.equal(
      getOpenCodeConfigHome(),
      path.join(os.homedir(), ".config", "opencode")
    );
  });
});
