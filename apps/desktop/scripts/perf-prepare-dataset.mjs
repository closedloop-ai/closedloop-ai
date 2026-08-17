// @ts-check
/**
 * ISS-4430 — build a sandboxed profiling dataset from a real Desktop profile.
 *
 * Profiling has to run against a realistic population (thousands of sessions),
 * and the only realistic population anyone has is their own. So each operator
 * profiles a COPY of their own data — and the copy must never reach git and must
 * never phone home. Both are enforced structurally here, not by policy:
 *
 *  - The target is refused unless `git check-ignore` confirms it is ignored.
 *  - The copied `desktop-settings.json` is rewritten to the canonical
 *    `DataSyncLevel.Off` safe state and every auth/relay/key-ish field is
 *    dropped, so a Desktop launched against this sandbox has nothing to connect
 *    with and nothing enabled to connect for.
 *
 * The DB copy is a `VACUUM INTO` snapshot, not a file copy: the store runs in
 * WAL mode (`connection-pragmas.ts`), so a bare `cp` of `agent-dashboard.sqlite`
 * can silently omit everything still sitting in the `-wal`.
 *
 * Canonical values are HARDCODED here rather than imported: this is a plain
 * `.mjs` Node CLI with no TypeScript build step. They are transcribed from
 * `src/shared/contracts.ts` (`DataSyncLevel`) and `src/shared/data-sync-level.ts`
 * (`dataSyncLevelToBooleans`), and `test/profiling-prepare-dataset.test.ts` pins
 * them so a drift in either source is caught.
 *
 * Usage:
 *   node scripts/perf-prepare-dataset.mjs [--source <userDataDir>]
 *                                         [--target <datasetDir>]
 *                                         [--with-transcripts <n>]
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Electron `app.getName()` for this app; the userData directory basename. */
const APP_DIR_NAME = "Closedloop";
/** The desktop local store, and the settings file next to it. */
const DB_FILE_NAME = "agent-dashboard.sqlite";
const SETTINGS_FILE_NAME = "desktop-settings.json";

/**
 * `DataSyncLevel.Off` plus the FULL group of booleans `dataSyncLevelToBooleans`
 * derives for it. Writing the level alone would leave the individual flags the
 * runtime actually reads untouched, so a sandbox launch could still connect.
 */
const SAFE_SYNC_STATE = Object.freeze({
  dataSyncLevel: "off",
  cloudConnectionEnabled: false,
  cloudCommandsPaused: true,
  transcriptSyncEnabled: false,
  syncObservabilityTier: "local",
});

/**
 * Settings keys dropped outright. `savedConfigs` carries the per-profile gateway
 * identity (gatewayId, public key, compute target, pending onboarding attempt);
 * `activeConfigId` points into it.
 */
const STRIPPED_SETTINGS_KEYS = Object.freeze([
  "savedConfigs",
  "activeConfigId",
]);

/**
 * Belt-and-braces on top of the explicit list: any key whose NAME suggests a
 * credential is dropped too, so a settings field added after this script was
 * written cannot leak into a sandbox by default. Dropping a benign key is
 * harmless — the settings store falls back to its defaults.
 */
const SECRETISH_KEY_PATTERN = /key|token|secret|credential|password|auth/i;

/** Timestamps that end up in a directory name must be path-safe. */
const STAMP_PUNCTUATION_PATTERN = /[-:]/g;
const STAMP_MILLIS_PATTERN = /\.\d{3}Z$/;

/** Bounds the transcript scan so a huge Claude home cannot stall the copy. */
const MAX_TRANSCRIPT_SCAN_PROJECTS = 500;

/**
 * Electron's userData directory for this app on the current platform.
 */
export function defaultSourceUserDataDir(
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir()
) {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", APP_DIR_NAME);
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, APP_DIR_NAME);
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return path.join(configHome, APP_DIR_NAME);
}

/** `20260804T151233Z` — sortable, path-safe, unambiguously UTC. */
export function utcStamp(now = new Date()) {
  return now
    .toISOString()
    .replace(STAMP_MILLIS_PATTERN, "Z")
    .replace(STAMP_PUNCTUATION_PATTERN, "");
}

/**
 * True when git reports `target` as ignored. Anything else — a non-zero exit, a
 * missing git, a spawn failure — is false, because the guard must fail CLOSED:
 * "we could not prove this path is ignored" and "this path is not ignored" have
 * to lead to the same refusal.
 */
export function isGitIgnored(target, repoRoot, runGit = defaultRunGit) {
  const result = runGit(["check-ignore", "--quiet", target], repoRoot);
  return result.status === 0;
}

/**
 * Rewrite a settings object into the sandbox-safe form: sync fully off, every
 * credential-ish or profile-identity key removed. Pure — takes and returns a
 * plain object — so the contract is testable without touching disk.
 */
export function toSandboxSettings(settings) {
  const sanitized = {};
  for (const [key, value] of Object.entries(settings)) {
    if (STRIPPED_SETTINGS_KEYS.includes(key)) {
      continue;
    }
    if (SECRETISH_KEY_PATTERN.test(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  // Applied AFTER the copy so the safe state always wins, even if a source key
  // of the same name survived the filter above.
  return { ...sanitized, ...SAFE_SYNC_STATE };
}

/**
 * Write a WAL-consistent single-file snapshot of `sourceDb` to `targetDb`.
 * The source is opened READ-ONLY so a concurrently running Desktop is never
 * mutated by the copy.
 */
export function snapshotDatabase(sourceDb, targetDb) {
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    // Single-quoted SQL string literal; escape any quote in the path.
    db.exec(`VACUUM INTO '${targetDb.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return statSync(targetDb).size;
}

/**
 * Copy up to `limit` Claude Code session transcripts into a sandbox CLAUDE_HOME
 * (`<sandbox>/claude/projects/<project>/<sessionId>.jsonl`), preserving the
 * layout `claude-home.ts` expects so the import workload can point CLAUDE_HOME
 * at the sandbox instead of reading the operator's live transcripts.
 */
export function copyTranscripts(sourceClaudeHome, sandboxClaudeHome, limit) {
  const sourceProjects = path.join(sourceClaudeHome, "projects");
  if (limit <= 0 || !existsSync(sourceProjects)) {
    return 0;
  }
  const targetProjects = path.join(sandboxClaudeHome, "projects");
  mkdirSync(targetProjects, { recursive: true });
  let copied = 0;
  const projects = readdirSync(sourceProjects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_TRANSCRIPT_SCAN_PROJECTS);
  for (const project of projects) {
    if (copied >= limit) {
      break;
    }
    const sourceDir = path.join(sourceProjects, project.name);
    const files = readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files) {
      if (copied >= limit) {
        break;
      }
      const targetDir = path.join(targetProjects, project.name);
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(
        path.join(sourceDir, file.name),
        path.join(targetDir, file.name)
      );
      copied += 1;
    }
  }
  return copied;
}

/**
 * Best-effort "is Desktop running right now?" check. A running app is not fatal
 * — `VACUUM INTO` still produces a consistent snapshot — but the POPULATION
 * keeps moving under it, so runs are less comparable. Any failure to probe
 * reports "unknown" rather than a confident "no".
 */
export function isDesktopRunning(runProbe = defaultRunPgrep) {
  const result = runProbe();
  if (result.status === null || result.error) {
    return null;
  }
  return result.status === 0;
}

/**
 * Build the dataset. Returns a summary object; throws on a refusal so the CLI
 * can exit non-zero with the reason.
 */
export function prepareDataset(options) {
  const {
    sourceDir,
    targetDir,
    repoRoot,
    withTranscripts = 0,
    sourceClaudeHome,
    runGit = defaultRunGit,
  } = options;

  if (!isGitIgnored(targetDir, repoRoot, runGit)) {
    throw new Error(
      `Refusing to write ${targetDir}: git does not report it as ignored.\n` +
        "A dataset copy must never be committable. Add `.perf/` to .gitignore " +
        "(or point --target at an already-ignored path) and re-run."
    );
  }

  if (existsSync(targetDir)) {
    if (lstatSync(targetDir).isSymbolicLink()) {
      throw new Error(
        `Refusing to write to ${targetDir}: it is a symlink. ` +
          "A symlink can traverse into a tracked directory, leaking user data into git."
      );
    }
    const resolved = realpathSync(targetDir);
    if (resolved !== path.resolve(targetDir)) {
      throw new Error(
        `Refusing to write to ${targetDir}: a parent component is a symlink ` +
          `(resolves to ${resolved}). The dataset could escape its gitignored directory.`
      );
    }
  }

  const sourceDb = path.join(sourceDir, DB_FILE_NAME);
  if (!existsSync(sourceDb)) {
    throw new Error(`No Desktop database at ${sourceDb}`);
  }

  mkdirSync(targetDir, { recursive: true });
  const targetDb = path.join(targetDir, DB_FILE_NAME);
  const dbBytes = snapshotDatabase(sourceDb, targetDb);

  const sourceSettings = path.join(sourceDir, SETTINGS_FILE_NAME);
  const settings = existsSync(sourceSettings)
    ? toSandboxSettings(JSON.parse(readFileSync(sourceSettings, "utf8")))
    : { ...SAFE_SYNC_STATE };
  writeFileSync(
    path.join(targetDir, SETTINGS_FILE_NAME),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8"
  );

  const sandboxClaudeHome = path.join(targetDir, "claude");
  const transcriptsCopied = copyTranscripts(
    sourceClaudeHome ?? path.join(os.homedir(), ".claude"),
    sandboxClaudeHome,
    withTranscripts
  );

  return {
    targetDir,
    targetDb,
    dbBytes,
    transcriptsCopied,
    sandboxClaudeHome,
    settingsKeys: Object.keys(settings).sort(),
  };
}

function defaultRunGit(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function defaultRunPgrep() {
  return spawnSync("pgrep", ["-f", APP_DIR_NAME], { encoding: "utf8" });
}

function parseArgs(argv) {
  const parsed = { withTranscripts: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      parsed.sourceDir = argv[index + 1];
      index += 1;
    } else if (arg === "--target") {
      parsed.targetDir = argv[index + 1];
      index += 1;
    } else if (arg === "--with-transcripts") {
      parsed.withTranscripts = Math.max(
        0,
        Number.parseInt(argv[index + 1] ?? "0", 10) || 0
      );
      index += 1;
    }
  }
  return parsed;
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..", "..");
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = args.sourceDir ?? defaultSourceUserDataDir();
  const targetDir =
    args.targetDir ??
    path.join(repoRoot, ".perf", "datasets", `desktop-${utcStamp()}`);

  const running = isDesktopRunning();
  if (running === true) {
    console.warn(
      "\nWARNING: Closedloop Desktop appears to be RUNNING.\n" +
        "  The snapshot will still be internally consistent, but the population\n" +
        "  keeps changing underneath it, so runs taken now are less comparable.\n" +
        "  Quit Desktop and re-run for a stable dataset.\n"
    );
  }

  const summary = prepareDataset({
    sourceDir,
    targetDir,
    repoRoot,
    withTranscripts: args.withTranscripts,
  });

  console.log("Dataset ready.");
  console.log(`  source:      ${sourceDir}`);
  console.log(`  dataset:     ${summary.targetDir}`);
  console.log(
    `  database:    ${summary.targetDb} (${formatMib(summary.dbBytes)})`
  );
  console.log(`  transcripts: ${summary.transcriptsCopied}`);
  console.log(
    "  sync state:  off (cloud connection disabled, commands paused)"
  );
  console.log("\nRun a workload against it with:");
  console.log(
    `  export CLOSEDLOOP_PROFILE_DIR="${path.join(repoRoot, ".perf", "runs", utcStamp())}"`
  );
  console.log(
    `  export CLOSEDLOOP_DESKTOP_USER_DATA_DIR="${summary.targetDir}"`
  );
  console.log(`  export CLAUDE_HOME="${summary.sandboxClaudeHome}"`);
  console.log(
    "  # add CLOSEDLOOP_PROFILE_TRACE=1 for a Chromium content trace"
  );
}

function formatMib(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `perf-prepare-dataset: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
