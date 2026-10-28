/**
 * @file copilot-source-routing.test.ts
 * @description ISS-11281: pins the Copilot source listings — which VS Code
 * `workspaceStorage/<hash>/chatSessions/*.json` files and which CLI
 * `session-state/<id>/events.jsonl` files are enumerated, what is skipped, and
 * how a hash dir's `workspace.json` resolves to a workspace path — and how the
 * collector routes a source path to the chat or CLI parser, listed or not.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "@repo/lib/harness/types";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createCopilotCollector } from "../src/main/collectors/copilot/copilot-collector.js";
import {
  getCopilotCliHome,
  getVscodeWorkspaceStorageDir,
  listChatSessionFiles,
  listCliEventFiles,
  workspacePathFromUri,
} from "../src/main/collectors/copilot/copilot-home.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

const ENV_KEYS = ["COPILOT_VSCODE_STORAGE_DIR", "COPILOT_HOME"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  await cleanupTempDirs();
});

function hashDir(root: string, name: string, workspace?: unknown): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  if (workspace !== undefined) {
    writeFileSync(
      path.join(dir, "workspace.json"),
      typeof workspace === "string" ? workspace : JSON.stringify(workspace),
      "utf8"
    );
  }
  return dir;
}

function chatSessions(dir: string, files: string[]): void {
  const chatDir = path.join(dir, "chatSessions");
  mkdirSync(chatDir, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(chatDir, file), "{}", "utf8");
  }
}

describe("Copilot home overrides", () => {
  it("trims the env overrides and expands only a leading ~/", () => {
    process.env.COPILOT_HOME = "  ~/copilot-home  ";
    process.env.COPILOT_VSCODE_STORAGE_DIR = "\t~/vscode-storage\n";
    assert.equal(getCopilotCliHome(), path.join(os.homedir(), "copilot-home"));
    assert.equal(
      getVscodeWorkspaceStorageDir(),
      path.join(os.homedir(), "vscode-storage")
    );

    process.env.COPILOT_HOME = " /data/~/copilot ";
    process.env.COPILOT_VSCODE_STORAGE_DIR = " /data/~/storage ";
    assert.equal(getCopilotCliHome(), "/data/~/copilot");
    assert.equal(getVscodeWorkspaceStorageDir(), "/data/~/storage");
  });

  it("falls back to the default roots when an override is unset or blank", () => {
    Reflect.deleteProperty(process.env, "COPILOT_HOME");
    assert.equal(getCopilotCliHome(), path.join(os.homedir(), ".copilot"));
    process.env.COPILOT_HOME = "   ";
    assert.equal(getCopilotCliHome(), path.join(os.homedir(), ".copilot"));

    Reflect.deleteProperty(process.env, "COPILOT_VSCODE_STORAGE_DIR");
    const platformDefault = getVscodeWorkspaceStorageDir();
    assert.equal(path.basename(platformDefault), "workspaceStorage");
    process.env.COPILOT_VSCODE_STORAGE_DIR = "   ";
    assert.equal(getVscodeWorkspaceStorageDir(), platformDefault);
  });
});

describe("workspacePathFromUri", () => {
  it("returns a non-file value verbatim, without decoding it", () => {
    assert.equal(workspacePathFromUri("/repos/a%20b"), "/repos/a%20b");
    assert.equal(workspacePathFromUri(""), null);
    assert.equal(workspacePathFromUri(42), null);
  });

  it("converts a file: URI, falling back to a decoded then a raw strip for a URI the platform refuses", () => {
    assert.equal(workspacePathFromUri("file:///repos/a%20b"), "/repos/a b");
    assert.equal(
      workspacePathFromUri("file://remote-host/share/a%20b"),
      "remote-host/share/a b"
    );
    assert.equal(
      workspacePathFromUri("file://remote-host/bad%E0%A4%A"),
      "remote-host/bad%E0%A4%A"
    );
  });
});

describe("listChatSessionFiles", () => {
  it("returns nothing when the workspaceStorage root does not exist", () => {
    process.env.COPILOT_VSCODE_STORAGE_DIR = path.join(
      makeTempDir("copilot-home-"),
      "missing"
    );
    assert.deepEqual(listChatSessionFiles(), []);
  });

  it("lists .json chat files per hash dir with the folder, workspace, or no workspace path", () => {
    const root = makeTempDir("copilot-home-");
    process.env.COPILOT_VSCODE_STORAGE_DIR = root;
    chatSessions(hashDir(root, "a-folder", { folder: "/repos/alpha" }), [
      "one.json",
      "notes.txt",
    ]);
    chatSessions(hashDir(root, "b-workspace", { workspace: "/repos/beta" }), [
      "two.json",
    ]);
    chatSessions(hashDir(root, "c-broken", "{not json"), ["three.json"]);
    chatSessions(hashDir(root, "d-empty", {}), ["four.json"]);
    hashDir(root, "e-no-chat", { folder: "/repos/gamma" });
    mkdirSync(path.join(root, "f-nested", "chatSessions", "dir.json"), {
      recursive: true,
    });
    writeFileSync(path.join(root, "stray-file.json"), "{}", "utf8");

    const listed = listChatSessionFiles()
      .map((entry) => [
        path.relative(root, entry.filePath),
        entry.workspacePath,
      ])
      .sort();
    assert.deepEqual(listed, [
      [path.join("a-folder", "chatSessions", "one.json"), "/repos/alpha"],
      [path.join("b-workspace", "chatSessions", "two.json"), "/repos/beta"],
      [path.join("c-broken", "chatSessions", "three.json"), null],
      [path.join("d-empty", "chatSessions", "four.json"), null],
    ]);
  });
});

describe("listCliEventFiles", () => {
  it("returns nothing when the session-state dir does not exist", () => {
    process.env.COPILOT_HOME = makeTempDir("copilot-home-");
    assert.deepEqual(listCliEventFiles(), []);
  });

  it("lists each session dir that holds an events.jsonl, skipping files and empty dirs", () => {
    const home = makeTempDir("copilot-home-");
    process.env.COPILOT_HOME = home;
    const stateDir = path.join(home, "session-state");
    mkdirSync(path.join(stateDir, "ses-a"), { recursive: true });
    writeFileSync(path.join(stateDir, "ses-a", "events.jsonl"), "", "utf8");
    mkdirSync(path.join(stateDir, "ses-empty"), { recursive: true });
    writeFileSync(path.join(stateDir, "loose.jsonl"), "", "utf8");

    assert.deepEqual(listCliEventFiles(), [
      {
        filePath: path.join(stateDir, "ses-a", "events.jsonl"),
        sessionId: "ses-a",
      },
    ]);
  });
});

const T0 = "2026-03-09T16:00:00.000Z";
const CHAT_SESSION = {
  sessionId: "chat-1",
  requests: [{ id: "r", timestamp: T0, message: { text: "q" } }],
};
const CLI_EVENTS = `${JSON.stringify({
  type: "user_message",
  timestamp: T0,
  payload: { text: "hi" },
})}\n`;

/** One listed chat file, one listed CLI file, and the env pointing at both. */
function seedSources(): { chatFile: string; cliFile: string } {
  const storage = makeTempDir("copilot-collector-");
  const home = makeTempDir("copilot-collector-");
  process.env.COPILOT_VSCODE_STORAGE_DIR = storage;
  process.env.COPILOT_HOME = home;
  const hash = hashDir(storage, "h1", { folder: "/repos/listed" });
  mkdirSync(path.join(hash, "chatSessions"), { recursive: true });
  const chatFile = path.join(hash, "chatSessions", "chat.json");
  writeFileSync(chatFile, JSON.stringify(CHAT_SESSION), "utf8");
  const cliDir = path.join(home, "session-state", "cli-1");
  mkdirSync(cliDir, { recursive: true });
  const cliFile = path.join(cliDir, "events.jsonl");
  writeFileSync(cliFile, CLI_EVENTS, "utf8");
  return { chatFile, cliFile };
}

describe("createCopilotCollector", () => {
  it("is keyed copilot, watches both roots, matches .json and .jsonl, and lists chat before CLI sources", () => {
    const { chatFile, cliFile } = seedSources();
    const collector = createCopilotCollector();
    assert.equal(collector.key, Harness.Copilot);
    assert.equal(collector.cacheName, "copilot");
    assert.deepEqual(collector.watchRoots(), [
      process.env.COPILOT_VSCODE_STORAGE_DIR,
      path.join(process.env.COPILOT_HOME ?? "", "session-state"),
    ]);
    assert.equal(collector.watchMatch("a.json"), true);
    assert.equal(collector.watchMatch("a.jsonl"), true);
    assert.equal(collector.watchMatch("a.txt"), false);
    assert.deepEqual(collector.listSources(), [chatFile, cliFile]);
  });

  it("derives a session id only for CLI sources", () => {
    const collector = createCopilotCollector();
    assert.ok(collector.sessionIdForSource);
    assert.equal(
      collector.sessionIdForSource("/x/session-state/abc/events.jsonl"),
      "copilot-cli-abc"
    );
    assert.equal(collector.sessionIdForSource("/x/chatSessions/a.json"), null);
  });

  it("parses listed chat and CLI sources with their listing's workspace and session id", async () => {
    const { chatFile, cliFile } = seedSources();
    const collector = createCopilotCollector();
    const [chat] = await collector.parse(chatFile);
    assert.equal(chat.cwd, "/repos/listed");
    const [cli] = await collector.parse(cliFile);
    assert.equal(cli.sessionId, "copilot-cli-cli-1");
  });

  it("re-derives context from the path shape for a source the listings do not hold", async () => {
    seedSources();
    const collector = createCopilotCollector();
    const elsewhere = makeTempDir("copilot-collector-");
    const hash = hashDir(elsewhere, "h2", { folder: "/repos/unlisted" });
    mkdirSync(path.join(hash, "chatSessions"), { recursive: true });
    const chatFile = path.join(hash, "chatSessions", "late.json");
    writeFileSync(chatFile, JSON.stringify(CHAT_SESSION), "utf8");
    const [chat] = await collector.parse(chatFile);
    assert.equal(chat.cwd, "/repos/unlisted");

    const cliDir = path.join(elsewhere, "late-session");
    mkdirSync(cliDir, { recursive: true });
    const cliFile = path.join(cliDir, "events.jsonl");
    writeFileSync(cliFile, CLI_EVENTS, "utf8");
    const [cli] = await collector.parse(cliFile);
    assert.equal(cli.sessionId, "copilot-cli-late-session");

    assert.deepEqual(await collector.parse(path.join(elsewhere, "x.txt")), []);
  });

  it("returns no session for a listed or unlisted source that parses to nothing", async () => {
    const { chatFile, cliFile } = seedSources();
    writeFileSync(chatFile, JSON.stringify({ requests: [] }), "utf8");
    writeFileSync(cliFile, "", "utf8");
    const collector = createCopilotCollector();
    assert.deepEqual(await collector.parse(chatFile), []);
    assert.deepEqual(await collector.parse(cliFile), []);

    const elsewhere = makeTempDir("copilot-collector-");
    const emptyChat = path.join(elsewhere, "empty.json");
    writeFileSync(emptyChat, JSON.stringify({ requests: [] }), "utf8");
    const emptyCli = path.join(elsewhere, "empty.jsonl");
    writeFileSync(emptyCli, "", "utf8");
    assert.deepEqual(await collector.parse(emptyChat), []);
    assert.deepEqual(await collector.parse(emptyCli), []);
  });
});
