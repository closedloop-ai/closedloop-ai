import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import {
  copyTranscripts,
  defaultSourceUserDataDir,
  isGitIgnored,
  prepareDataset,
  snapshotDatabase,
  toSandboxSettings,
  utcStamp,
} from "../scripts/perf-prepare-dataset.mjs";

let workDir = "";

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "profiling-dataset-"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A WAL-mode SQLite file with rows still sitting in the -wal, like the real one. */
function createFixtureDatabase(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "agent-dashboard.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, harness TEXT)");
  const insert = db.prepare("INSERT INTO sessions (id, harness) VALUES (?, ?)");
  for (let index = 0; index < 25; index += 1) {
    insert.run(`session-${index}`, "claude");
  }
  db.close();
  return dbPath;
}

const gitIgnoredStub = () => ({ status: 0 });
const gitNotIgnoredStub = () => ({ status: 1 });
const NOT_IGNORED_REFUSAL = /does not report it as ignored/;

describe("perf dataset preparation", () => {
  test("VACUUM INTO produces a readable snapshot of a WAL database", () => {
    const sourceDir = path.join(workDir, "snapshot-source");
    const sourceDb = createFixtureDatabase(sourceDir);
    const targetDb = path.join(workDir, "snapshot-target.sqlite");

    const bytes = snapshotDatabase(sourceDb, targetDb);

    assert.ok(bytes > 0);
    const copy = new DatabaseSync(targetDb, { readOnly: true });
    try {
      const row = copy.prepare("SELECT COUNT(*) AS total FROM sessions").get();
      assert.equal(row?.total, 25);
    } finally {
      copy.close();
    }
  });

  test("settings are rewritten to the canonical off state", () => {
    const sanitized = toSandboxSettings({
      dataSyncLevel: "full",
      cloudConnectionEnabled: true,
      cloudCommandsPaused: false,
      transcriptSyncEnabled: true,
      syncObservabilityTier: "full",
      verboseLogging: true,
      sandboxBaseDirectory: "/home/someone/Workspace",
    });

    // The full safe-state group `dataSyncLevelToBooleans(DataSyncLevel.Off)`
    // derives — writing the level alone would leave the flags the runtime
    // actually reads still pointing at the cloud.
    assert.equal(sanitized.dataSyncLevel, "off");
    assert.equal(sanitized.cloudConnectionEnabled, false);
    assert.equal(sanitized.cloudCommandsPaused, true);
    assert.equal(sanitized.transcriptSyncEnabled, false);
    assert.equal(sanitized.syncObservabilityTier, "local");
    // Unrelated preferences survive so the sandbox still behaves like a profile.
    assert.equal(sanitized.verboseLogging, true);
  });

  test("profile identity and credential-ish keys are stripped", () => {
    const sanitized = toSandboxSettings({
      savedConfigs: [{ id: "profile-1", gatewayId: "gw-1" }],
      activeConfigId: "profile-1",
      managedKeyHintDismissedAt: "2026-01-01T00:00:00Z",
      apiOrigin: "https://api.example.test",
    });

    assert.equal("savedConfigs" in sanitized, false);
    assert.equal("activeConfigId" in sanitized, false);
    assert.equal(
      "managedKeyHintDismissedAt" in sanitized,
      false,
      "a key-ish name is dropped by default so a new setting cannot leak"
    );
    assert.equal(sanitized.apiOrigin, "https://api.example.test");
  });

  test("refuses to write a target git does not report as ignored", () => {
    const sourceDir = path.join(workDir, "refusal-source");
    createFixtureDatabase(sourceDir);
    const targetDir = path.join(workDir, "not-ignored-target");

    assert.throws(
      () =>
        prepareDataset({
          sourceDir,
          targetDir,
          repoRoot: workDir,
          runGit: gitNotIgnoredStub,
        }),
      NOT_IGNORED_REFUSAL
    );
    assert.equal(
      existsSync(targetDir),
      false,
      "the refusal must happen before anything is written"
    );
  });

  test("fails closed when git cannot answer at all", () => {
    const spawnFailure = () => ({ status: null, error: new Error("no git") });

    assert.equal(isGitIgnored("/some/path", workDir, spawnFailure), false);
  });

  test("prepares a complete dataset when the target is ignored", () => {
    const sourceDir = path.join(workDir, "full-source");
    createFixtureDatabase(sourceDir);
    writeFileSync(
      path.join(sourceDir, "desktop-settings.json"),
      JSON.stringify({
        dataSyncLevel: "full",
        cloudConnectionEnabled: true,
        savedConfigs: [{ id: "profile-1" }],
        verboseLogging: false,
      }),
      "utf8"
    );
    const targetDir = path.join(workDir, "ignored-target");

    const summary = prepareDataset({
      sourceDir,
      targetDir,
      repoRoot: workDir,
      runGit: gitIgnoredStub,
    });

    assert.equal(summary.targetDir, targetDir);
    assert.ok(existsSync(summary.targetDb));
    const settings = JSON.parse(
      readFileSync(path.join(targetDir, "desktop-settings.json"), "utf8")
    );
    assert.equal(settings.dataSyncLevel, "off");
    assert.equal(settings.cloudConnectionEnabled, false);
    assert.equal("savedConfigs" in settings, false);
  });

  test("copies a bounded transcript set into the sandbox CLAUDE_HOME layout", () => {
    const sourceHome = path.join(workDir, "claude-source");
    const projectDir = path.join(sourceHome, "projects", "-home-someone-repo");
    mkdirSync(projectDir, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(
        path.join(projectDir, `session-${index}.jsonl`),
        '{"type":"user"}\n',
        "utf8"
      );
    }
    const sandboxHome = path.join(workDir, "claude-sandbox");

    const copied = copyTranscripts(sourceHome, sandboxHome, 3);

    assert.equal(copied, 3);
    // `claude-home.ts` resolves transcripts at
    // `<CLAUDE_HOME>/projects/<project>/<sessionId>.jsonl`.
    assert.ok(
      existsSync(
        path.join(
          sandboxHome,
          "projects",
          "-home-someone-repo",
          "session-0.jsonl"
        )
      )
    );
  });

  test("resolves the platform userData directory", () => {
    assert.equal(
      defaultSourceUserDataDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/x"),
      path.join("/cfg", "Closedloop")
    );
    assert.equal(
      defaultSourceUserDataDir("linux", {}, "/home/x"),
      path.join("/home/x", ".config", "Closedloop")
    );
    assert.equal(
      defaultSourceUserDataDir("darwin", {}, "/Users/x"),
      path.join("/Users/x", "Library", "Application Support", "Closedloop")
    );
    assert.equal(
      defaultSourceUserDataDir(
        "win32",
        { APPDATA: "C:\\Roaming" },
        "C:\\Users\\x"
      ),
      path.join("C:\\Roaming", "Closedloop")
    );
  });

  test("the dataset stamp is path-safe and unambiguously UTC", () => {
    assert.equal(
      utcStamp(new Date("2026-08-04T15:12:33.456Z")),
      "20260804T151233Z"
    );
  });
});
