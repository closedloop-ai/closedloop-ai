/**
 * ISS-11105: behavior pins for the perf-qa dataset-prep script paths that
 * profiling-prepare-dataset.test.ts does not reach: the platform fallbacks, the
 * run probe, the existing-target guards, the missing-source refusal, the
 * transcript scan bound, and the CLI entry (argument parsing, summary output,
 * the running-Desktop warning and the error exit).
 *
 * The CLI entry runs in-process: `process.argv[1]` is pointed at the script and
 * the module is re-imported, so its entry guard fires the way `node
 * scripts/perf-prepare-dataset.mjs` would. `spawnSync` is mocked so neither git
 * nor pgrep runs, and HOME is pointed at a temp dir so no operator data is read.
 */
import type * as NodeChildProcess from "node:child_process";
import type * as NodeFs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyTranscripts,
  defaultSourceUserDataDir,
  isDesktopRunning,
  prepareDataset,
  utcStamp,
} from "../scripts/perf-prepare-dataset.mjs";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawnSync: mocks.spawnSync };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  mocks.readdirSync.mockImplementation(actual.readdirSync);
  return { ...actual, readdirSync: mocks.readdirSync };
});

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/perf-prepare-dataset.mjs", import.meta.url)
);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..", "..");
const DB_FILE_NAME = "agent-dashboard.sqlite";
const SETTINGS_FILE_NAME = "desktop-settings.json";
const SAFE_SYNC_STATE = {
  dataSyncLevel: "off",
  cloudConnectionEnabled: false,
  cloudCommandsPaused: true,
  transcriptSyncEnabled: false,
  syncObservabilityTier: "local",
};
const FIXED_NOW = new Date("2026-09-11T12:00:00.000Z");
const RUNNING_WARNING = /Closedloop Desktop appears to be RUNNING/;
const NOT_IGNORED_REFUSAL = /does not report it as ignored/;
const SYMLINK_REFUSAL = /it is a symlink/;
const NON_ERROR_THROWN: unknown = "pgrep exploded";
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "APPDATA"] as const;

const gitIgnored = () => ({ status: 0 });

let workDir = "";

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "perf-prep-br-")));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  mocks.spawnSync.mockReset();
  mocks.readdirSync.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("defaultSourceUserDataDir", () => {
  it("falls back to AppData/Roaming on win32 when APPDATA is unset", () => {
    expect(defaultSourceUserDataDir("win32", {}, "C:\\Users\\x")).toBe(
      path.join("C:\\Users\\x", "AppData", "Roaming", "Closedloop")
    );
  });
});

describe("isDesktopRunning", () => {
  it.each([
    { probe: { status: null }, expected: null },
    { probe: { status: 0, error: new Error("EPERM") }, expected: null },
    { probe: { status: 0 }, expected: true },
    { probe: { status: 1 }, expected: false },
  ])("maps probe $probe to $expected", ({ probe, expected }) => {
    expect(isDesktopRunning(() => probe)).toBe(expected);
  });

  it("probes with pgrep for the app name by default", () => {
    mocks.spawnSync.mockReturnValue({ status: 1 });

    expect(isDesktopRunning()).toBe(false);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "pgrep",
      ["-f", "Closedloop"],
      { encoding: "utf8" }
    );
  });
});

describe("copyTranscripts", () => {
  it("stops scanning projects once the limit is reached", () => {
    const sourceHome = path.join(workDir, "claude-source");
    writeTranscript(sourceHome, "a-project", "s1.jsonl");
    writeTranscript(sourceHome, "a-project", "s2.jsonl");
    writeTranscript(sourceHome, "b-project", "s3.jsonl");
    const sandboxHome = path.join(workDir, "claude-sandbox");

    expect(copyTranscripts(sourceHome, sandboxHome, 2)).toBe(2);

    expect(mocks.readdirSync).not.toHaveBeenCalledWith(
      path.join(sourceHome, "projects", "b-project"),
      expect.anything()
    );
    expect(existsSync(path.join(sandboxHome, "projects", "b-project"))).toBe(
      false
    );
  });
});

describe("prepareDataset", () => {
  it("writes the canonical off state when the source has no settings file", () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, []);
    const targetDir = path.join(workDir, "target");

    const summary = prepareDataset({
      sourceDir,
      targetDir,
      repoRoot: workDir,
      runGit: gitIgnored,
    });

    expect(
      JSON.parse(readFileSync(path.join(targetDir, SETTINGS_FILE_NAME), "utf8"))
    ).toEqual(SAFE_SYNC_STATE);
    expect(summary.settingsKeys).toEqual(Object.keys(SAFE_SYNC_STATE).sort());
  });

  it("accepts a target directory that already exists as a real directory", () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, [{ id: "s1", lastActivityAt: null }]);
    const targetDir = path.join(workDir, "target");
    mkdirSync(targetDir);

    const summary = prepareDataset({
      sourceDir,
      targetDir,
      repoRoot: workDir,
      runGit: gitIgnored,
    });

    expect(summary.targetDb).toBe(path.join(targetDir, DB_FILE_NAME));
    expect(summary.sessionCount).toBe(1);
  });

  it("refuses a target that is itself a symlink", () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, []);
    const realDir = path.join(workDir, "real");
    mkdirSync(realDir);
    const targetDir = path.join(workDir, "link");
    symlinkSync(realDir, targetDir, "dir");

    expect(() =>
      prepareDataset({
        sourceDir,
        targetDir,
        repoRoot: workDir,
        runGit: gitIgnored,
      })
    ).toThrow(SYMLINK_REFUSAL);
    expect(existsSync(path.join(realDir, DB_FILE_NAME))).toBe(false);
  });

  it("refuses a target reached through a symlinked parent", () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, []);
    const realParent = path.join(workDir, "real-parent");
    mkdirSync(path.join(realParent, "dataset"), { recursive: true });
    const linkParent = path.join(workDir, "link-parent");
    symlinkSync(realParent, linkParent, "dir");
    const targetDir = path.join(linkParent, "dataset");

    expect(() =>
      prepareDataset({
        sourceDir,
        targetDir,
        repoRoot: workDir,
        runGit: gitIgnored,
      })
    ).toThrow(
      `Refusing to write to ${targetDir}: a parent component is a symlink (resolves to ${path.join(realParent, "dataset")}). The dataset could escape its gitignored directory.`
    );
    expect(existsSync(path.join(realParent, "dataset", DB_FILE_NAME))).toBe(
      false
    );
  });

  it("refuses a source with no Desktop database before creating the target", () => {
    const sourceDir = path.join(workDir, "empty-source");
    mkdirSync(sourceDir);
    const targetDir = path.join(workDir, "target");

    expect(() =>
      prepareDataset({
        sourceDir,
        targetDir,
        repoRoot: workDir,
        runGit: gitIgnored,
      })
    ).toThrow(`No Desktop database at ${path.join(sourceDir, DB_FILE_NAME)}`);
    expect(existsSync(targetDir)).toBe(false);
  });
});

describe("the CLI entry", () => {
  let savedArgv: string[] = [];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedArgv = process.argv;
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]])
    );
    process.env.HOME = path.join(workDir, "home");
    process.env.XDG_CONFIG_HOME = path.join(workDir, "xdg");
    process.env.APPDATA = path.join(workDir, "appdata");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    process.argv = savedArgv;
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("prints the summary, copies transcripts, and warns when Desktop is running", async () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, [
      { id: "s1", lastActivityAt: "2026-08-30T00:00:00.000Z" },
      { id: "s2", lastActivityAt: "2026-09-01T00:00:00.000Z" },
    ]);
    writeTranscript(path.join(workDir, "home", ".claude"), "proj", "t.jsonl");
    const targetDir = path.join(workDir, "dataset");
    mocks.spawnSync.mockReturnValue({ status: 0 });

    const run = await runCli([
      "--source",
      sourceDir,
      "--target",
      targetDir,
      "--with-transcripts",
      "1",
    ]);

    expect(run.exit).not.toHaveBeenCalled();
    expect(run.warnings).toHaveLength(1);
    expect(run.warnings[0]).toMatch(RUNNING_WARNING);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "git",
      ["check-ignore", "--quiet", targetDir],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(run.logs).toEqual(
      expect.arrayContaining([
        "Dataset ready.",
        `  source:      ${sourceDir}`,
        `  dataset:     ${targetDir}`,
        "  sessions:    2, newest activity 2026-09-01T00:00:00.000Z (10d old)",
        "  transcripts: 1",
        `  export CLAUDE_HOME="${path.join(targetDir, "claude")}"`,
      ])
    );
    expect(
      existsSync(path.join(targetDir, "claude", "projects", "proj", "t.jsonl"))
    ).toBe(true);
  });

  it("defaults the source dir, ignores unknown flags, and reports an unreadable population as unknown", async () => {
    const sourceDir = defaultSourceUserDataDir();
    mkdirSync(sourceDir, { recursive: true });
    const db = new DatabaseSync(path.join(sourceDir, DB_FILE_NAME));
    db.exec("CREATE TABLE other (id TEXT)");
    db.close();
    writeTranscript(path.join(workDir, "home", ".claude"), "proj", "t.jsonl");
    const targetDir = path.join(workDir, "dataset");
    mocks.spawnSync.mockImplementation((command: string) =>
      command === "pgrep" ? { status: 1 } : { status: 0 }
    );

    const run = await runCli([
      "--verbose",
      "--target",
      targetDir,
      "--with-transcripts",
    ]);

    expect(run.exit).not.toHaveBeenCalled();
    expect(run.warnings).toEqual([]);
    expect(run.logs).toEqual(
      expect.arrayContaining([
        `  source:      ${sourceDir}`,
        "  sessions:    unknown, newest activity unknown",
        "  transcripts: 0",
      ])
    );
  });

  it("prints an unparseable newest-activity stamp verbatim and skips the warning when the probe is inconclusive", async () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, [{ id: "s1", lastActivityAt: "yesterday" }]);
    const targetDir = path.join(workDir, "dataset");
    mocks.spawnSync.mockImplementation((command: string) =>
      command === "pgrep" ? { status: null } : { status: 0 }
    );

    const run = await runCli(["--source", sourceDir, "--target", targetDir]);

    expect(run.warnings).toEqual([]);
    expect(run.logs).toContain("  sessions:    1, newest activity yesterday");
  });

  it("defaults the target under .perf/datasets and exits 1 with the refusal when git does not ignore it", async () => {
    const sourceDir = path.join(workDir, "source");
    createSessionsDb(sourceDir, []);
    const defaultTarget = path.join(
      REPO_ROOT,
      ".perf",
      "datasets",
      `desktop-${utcStamp(FIXED_NOW)}`
    );
    mocks.spawnSync.mockReturnValue({ status: 1 });

    const run = await runCli(["--source", sourceDir]);

    expect(run.exit).toHaveBeenCalledWith(1);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toMatch(NOT_IGNORED_REFUSAL);
    expect(
      run.errors[0].startsWith(
        `perf-prepare-dataset: Refusing to write ${defaultTarget}:`
      )
    ).toBe(true);
    expect(run.logs).toEqual([]);
    expect(existsSync(defaultTarget)).toBe(false);
  });

  it("reports a non-Error throw by its string form and exits 1", async () => {
    mocks.spawnSync.mockImplementation(() => {
      throw NON_ERROR_THROWN;
    });

    const run = await runCli(["--target", path.join(workDir, "dataset")]);

    expect(run.exit).toHaveBeenCalledWith(1);
    expect(run.errors).toEqual(["perf-prepare-dataset: pgrep exploded"]);
    expect(run.logs).toEqual([]);
  });
});

type SessionRow = { id: string; lastActivityAt: string | null };

function createSessionsDb(dir: string, rows: readonly SessionRow[]): void {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, DB_FILE_NAME));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, last_activity_at TEXT)");
  const insert = db.prepare(
    "INSERT INTO sessions (id, last_activity_at) VALUES (?, ?)"
  );
  for (const row of rows) {
    insert.run(row.id, row.lastActivityAt);
  }
  db.close();
}

function writeTranscript(
  claudeHome: string,
  project: string,
  fileName: string
): void {
  const dir = path.join(claudeHome, "projects", project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), '{"type":"user"}\n', "utf8");
}

async function runCli(args: readonly string[]) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });
  vi.spyOn(console, "warn").mockImplementation((line: string) => {
    warnings.push(line);
  });
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(line);
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  process.argv = [process.execPath, SCRIPT_PATH, ...args];
  vi.resetModules();
  await import("../scripts/perf-prepare-dataset.mjs");
  return { logs, warnings, errors, exit };
}
