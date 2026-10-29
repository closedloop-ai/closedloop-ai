/**
 * ISS-4430 — shared plumbing for the desktop profiling workloads.
 *
 * The run-directory contract, the JSONL writers, and the graceful-close path are
 * identical for the sessions lane and the import lane, and the env-var names are
 * a contract with the `just` targets — so they live here once rather than being
 * re-declared in each workload, where they could drift apart silently.
 *
 * Not a spec: it does not match the perf config's `*.perf.ts` glob, so Playwright
 * imports it without collecting it as a test file.
 *
 * The web workload (`e2e/perf/web-workload.perf.ts`) keeps its own copies of the
 * small pieces it needs. It compiles in a different TypeScript program under a
 * different Playwright config and shares no module resolution with this
 * directory; a change to the run-directory or marks contract has to be made in
 * both places.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ElectronApplication, expect } from "@playwright/test";

/**
 * Twin constants for the run-directory contract owned by
 * `scripts/perf/thresholds.ts` (`PerfLane`, `PERF_RUN_MANIFEST_FILE_NAME`).
 * That module lives in a separate TypeScript program — ISS-5142 put
 * `test/**` under a rootDir-scoped project, so importing across the repo
 * boundary no longer typechecks. Values must stay byte-identical to the
 * registry's: a drifted lane name or manifest file name makes the report
 * treat every run as a capture failure — honest, but useless.
 */
export const PerfLane = {
  Desktop: "desktop",
  DesktopImport: "desktop-import",
} as const;
export type PerfLane = (typeof PerfLane)[keyof typeof PerfLane];
const PERF_RUN_MANIFEST_FILE_NAME = "manifest.json";

/**
 * Absolute path to the prepared dataset sandbox. Fixed name — the `just` targets
 * and `perf-prepare-dataset.mjs`'s closing instructions both print it, so
 * renaming it here silently breaks both. Deliberately NOT in
 * `src/shared/profiling.ts`: it configures the WORKLOAD, not the app, and the
 * app never reads it.
 */
export const DESKTOP_USER_DATA_DIR_ENV = "CLOSEDLOOP_DESKTOP_USER_DATA_DIR";

/** Per-step wall time. Registered in `PERF_LANE_ARTIFACTS` for every lane. */
export const WORKLOAD_MARKS_FILE_NAME = "workload-marks.jsonl";

/**
 * ISS-6820 — the surface each measured step belongs to.
 *
 * Twin of `scripts/perf/surfaces.ts` (`PerfSurface`), for the same rootDir
 * reason as {@link PerfLane} above; `scripts/perf/twin-constants.test.ts` pins
 * the values. The desktop lane has no `platform` step, so only the four named
 * surfaces appear here — an extra member nothing emits would be a claim the
 * evidence never backs.
 */
export const PerfSurface = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Agents: "agents",
} as const;
export type PerfSurface = (typeof PerfSurface)[keyof typeof PerfSurface];

/**
 * ISS-6820 — per-step surface attribution and the wall-clock window each step
 * occupied.
 *
 * Deliberately UNREGISTERED in `scripts/perf/thresholds.ts`, on the same
 * grounds as the import lane's `import-progress.jsonl`: it is not a subject
 * with a budget, it is the index that lets an analyst attribute the rows in
 * `ipc.jsonl` and `db-ops.jsonl` — both of which carry a `ts` epoch — to the
 * surface that was on screen when they happened. Registering it would fan one
 * scripted route into a duplicate set of findings already reported as steps.
 */
export const WORKLOAD_PHASES_FILE_NAME = "workload-phases.jsonl";

/** The store the dataset CLI snapshots; its presence proves a real sandbox. */
export const DESKTOP_DB_FILE_NAME = "agent-dashboard.sqlite";

/** The settings file the dataset CLI rewrites into its sandbox-safe form. */
export const DESKTOP_SETTINGS_FILE_NAME = "desktop-settings.json";

/**
 * Appended to a step name whose wait never satisfied.
 *
 * Twin of `scripts/perf/thresholds.ts` (`TIMEOUT_STEP_SUFFIX`), which owns the
 * value and is where the analyzer reads it: ISS-7785 made the report route these
 * rows out of the timing aggregates, so a drift here would silently restore the
 * old behaviour of filing an expired wait bound as a `workload-step-max`
 * finding. `scripts/perf/twin-constants.test.ts` pins it.
 */
export const TIMEOUT_STEP_SUFFIX = ":timeout";

/**
 * Rows the Sessions list requests per page.
 *
 * Twin of the renderer's `PAGE_SIZE`
 * (`apps/desktop/src/renderer/components/sessions/sessions-render-model.ts`),
 * which this program cannot import across the ISS-5142 rootDir boundary;
 * `scripts/perf/twin-constants.test.ts` pins it. Used only to decide whether a
 * sandbox holds enough sessions for the paginate steps to have anything to turn
 * to. Turning a page needs a SECOND page, so the threshold is `<=`, not `<`: at
 * exactly one full page `TablePagination` renders no control, and those steps
 * wait out their bound instead of measuring a page turn.
 */
export const SESSIONS_PAGE_SIZE = 25;

/**
 * Bound on the app's own quit path. `launchDesktopApp`'s `cleanup` gives close
 * five seconds and then SIGKILLs, which is right for E2E and wrong here: the
 * main and db-host CPU profilers stop and WRITE during that quit, and a killed
 * process leaves a truncated `.cpuprofile` (or none at all).
 */
export const GRACEFUL_CLOSE_MS = 120_000;

/** Where {@link resolveCollectorHomes} creates its guaranteed-empty homes. */
export const EMPTY_COLLECTOR_HOMES_DIR_NAME = "collector-homes";

/**
 * Every collector home this app resolves, and the directory name each maps to.
 *
 * All five harness collectors honour an env override, so there is no collector a
 * workload cannot isolate:
 *   Claude   → CLAUDE_HOME                  (collectors/claude/claude-home.ts)
 *            + CLAUDE_DESKTOP_SESSIONS_HOME (Claude Desktop sidecar root)
 *   Codex    → CODEX_HOME                   (main/util/codex-home-paths.ts)
 *   Copilot  → COPILOT_HOME                 (CLI session state)
 *            + COPILOT_VSCODE_STORAGE_DIR   (Copilot Chat workspace storage)
 *   Cursor   → CURSOR_HOME                  (collectors/cursor/cursor-home.ts)
 *   OpenCode → OPENCODE_DATA_DIR            (opencode.db)
 *            + OPENCODE_CONFIG_DIR          (agent/command component scan root)
 *
 * `OPENCODE_CONFIG_DIR` is the highest-precedence knob in OpenCode's own
 * resolution order, so setting it also neutralizes an inherited
 * `OPENCODE_CONFIG` or `XDG_CONFIG_HOME`.
 *
 * EVERY desktop workload must map ALL of these, not just the import lane.
 * `launchDesktopApp` inherits the operator's environment and the app's collector
 * manager imports AND watches these directories continuously — so an unmapped
 * home means a browse-only workload still ingests the operator's live
 * transcripts mid-run, mutating its own dataset while it measures it.
 */
export const COLLECTOR_HOME_ENV = {
  CLAUDE_HOME: "claude",
  // Review (#5717): the Claude Desktop sidecar root resolves under
  // `os.homedir()` on macOS when unset, so a workload that left it ambient
  // scanned the operator's live Desktop history mid-measurement — the same
  // dataset mutation this map exists to prevent.
  CLAUDE_DESKTOP_SESSIONS_HOME: "claude-desktop-sessions",
  CODEX_HOME: "codex",
  COPILOT_HOME: "copilot",
  COPILOT_VSCODE_STORAGE_DIR: "copilot-vscode",
  CURSOR_HOME: "cursor",
  OPENCODE_DATA_DIR: "opencode",
  OPENCODE_CONFIG_DIR: "opencode-config",
} as const;

/** The subset of `LaunchedApp` the close path needs. */
export type ClosableApp = {
  app: ElectronApplication;
  cleanup: () => Promise<void>;
};

/**
 * An absolute directory path from the environment, or a fail-fast explanation.
 * A workload that guessed at either path would either profile the wrong data or
 * write its evidence somewhere nobody looks.
 */
export function requireAbsoluteDirEnv(name: string, remedy: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is not set. ${remedy}`);
  }
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(
      `${name} must be an absolute path (got "${trimmed}"). ${remedy}`
    );
  }
  return trimmed;
}

/**
 * Name the lane this directory holds, so the report attributes findings without
 * having to infer the lane from which artifacts happen to be present.
 *
 * `details` carries whatever else identifies WHICH measurement the run made —
 * the import lane's store shape, say. It belongs here rather than in an
 * unregistered evidence file because the marks a lane emits are named per lane,
 * not per variant, so two variants of one lane land under the same threshold
 * subject and are otherwise indistinguishable to a reader of the report. The
 * report's manifest schema is a non-strict `z.object` that ignores keys it does
 * not know, so an added key cannot break an existing reader.
 */
export function writeRunManifest(
  runDir: string,
  lane: string,
  details: Readonly<Record<string, string>> = {}
): void {
  fs.writeFileSync(
    path.join(runDir, PERF_RUN_MANIFEST_FILE_NAME),
    `${JSON.stringify({ ...details, lane }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Append one JSONL row. Plain synchronous append rather than a buffered writer:
 * a workload emits a handful of rows over minutes, and a row that survives a
 * crashed run is worth more than the write it saves.
 */
export function appendJsonlRow(
  runDir: string,
  fileName: string,
  row: object
): void {
  fs.appendFileSync(
    path.join(runDir, fileName),
    `${JSON.stringify(row)}\n`,
    "utf8"
  );
}

/** Append one measured step to the run's registered marks file. */
export function appendMark(runDir: string, step: string, ms: number): void {
  appendJsonlRow(runDir, WORKLOAD_MARKS_FILE_NAME, {
    step,
    ms,
    ts: Date.now(),
  });
}

/**
 * Append one step's surface attribution and wall-clock window (ISS-6820).
 *
 * `startedAtEpochMs`/`endedAtEpochMs` are wall clock, not the monotonic clock
 * the duration is taken on, because their only job is to be comparable with the
 * `ts` field the app's own capture sinks stamp on every IPC and db-host row.
 */
export function appendPhase(
  runDir: string,
  phase: {
    surface: PerfSurface;
    step: string;
    ms: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
  }
): void {
  appendJsonlRow(runDir, WORKLOAD_PHASES_FILE_NAME, phase);
}

/**
 * Close through the app's own quit path and wait for it.
 *
 * Both CPU profilers stop and serialize during quit, and a `.cpuprofile` for a
 * multi-minute run is large enough that the E2E helper's five-second window can
 * expire mid-write. Drive `close()` here with room to finish, then hand off to
 * `cleanup` — which finds the app already down and, when the launch asked to
 * keep the profile, leaves it intact.
 */
export async function closeAppForProfileWrite(
  launched: ClosableApp
): Promise<void> {
  const closed = launched.app.close();
  closed.catch(() => {
    // Swallowed here and reported below; the cleanup backstop still runs.
  });
  const settled = await Promise.race([
    closed.then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), GRACEFUL_CLOSE_MS).unref();
    }),
  ]);
  if (!settled) {
    console.warn(
      `[perf] the app did not exit within ${GRACEFUL_CLOSE_MS}ms; CPU profiles may be truncated.`
    );
  }
  try {
    await launched.cleanup();
  } catch (error) {
    // ISS-7654 removed what used to land here: the E2E cleanup re-read
    // `app.process()` on an ElectronApplication this function had already
    // closed, and threw on Playwright's disposed handle (dogfood run
    // 20260805T152620Z). The backstop stays for a teardown that genuinely fails
    // — a surviving Electron process still rejects — because the artifacts are
    // on disk by now and that must not turn a captured run into a failed one.
    console.warn(`[perf] cleanup backstop failed: ${describeError(error)}`);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map every collector home onto a directory this run controls.
 *
 * With no `transcriptSourceDir` — the browse lanes — every home resolves to a
 * freshly created EMPTY directory under the run folder, so the app can discover
 * nothing to import and the dataset it is measuring cannot change underneath it.
 *
 * With a `transcriptSourceDir` — the import lane — a subdirectory of that source
 * wins when it exists, so any transcript set the dataset CLI copies is picked up
 * automatically as its `--with-transcripts` coverage grows; the rest still fall
 * back to empty stand-ins.
 *
 * The stand-ins are created rather than merely named: a collector pointed at a
 * directory that exists and is empty resolves to "nothing here", which is the
 * state being engineered, and the mapping is then visible on disk.
 */
export function resolveCollectorHomes(options: {
  runDir: string;
  transcriptSourceDir?: string;
}): Record<string, string> {
  const emptyHomesRoot = path.join(
    options.runDir,
    EMPTY_COLLECTOR_HOMES_DIR_NAME
  );
  const homes: Record<string, string> = {};
  for (const [envName, dirName] of Object.entries(COLLECTOR_HOME_ENV)) {
    const sourceHome = options.transcriptSourceDir
      ? path.join(options.transcriptSourceDir, dirName)
      : null;
    if (sourceHome && fs.existsSync(sourceHome)) {
      homes[envName] = sourceHome;
      continue;
    }
    const emptyHome = path.join(emptyHomesRoot, dirName);
    fs.mkdirSync(emptyHome, { recursive: true });
    homes[envName] = emptyHome;
  }
  return homes;
}

/**
 * Prove the mapping before the app can act on it. This assertion is the whole
 * safety property: a home that escaped every root this run owns is, by
 * construction, the operator's real one.
 */
export function assertCollectorHomesIsolated(
  homes: Record<string, string>,
  allowedRoots: readonly string[]
): void {
  for (const envName of Object.keys(COLLECTOR_HOME_ENV)) {
    const home = homes[envName];
    expect(home, `${envName} must be mapped before launch`).toBeTruthy();
    expect(
      allowedRoots.some((root) => isInside(root, home)),
      `${envName}="${home}" escapes every directory this run owns (${allowedRoots.join(", ")}) — the app would read the operator's live transcripts.`
    ).toBe(true);
    expect(
      fs.existsSync(home),
      `${envName}="${home}" does not exist; the collector would fall back to its default home.`
    ).toBe(true);
  }
}

/** True when `target` resolves inside `root`. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * Reads the sandbox's session count, or explains why it could not.
 *
 * Opened READ-ONLY: this runs against the dataset the workload is about to
 * measure, and a precondition check that could write to it would be changing the
 * population it exists to describe.
 */
function readSandboxSessionCount(dbPath: string): number {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(
      `Cannot open ${dbPath}: ${describeError(error)}. Rebuild the sandbox with ` +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs`."
    );
  }
  let row: Record<string, unknown> | undefined;
  try {
    row = db.prepare("SELECT COUNT(*) AS total FROM sessions").get();
  } catch (error) {
    // Overwhelmingly "no such table: sessions" — a file that is not a Desktop
    // store at all. Raw, that reads as a harness bug; named, it points at the
    // sandbox the operator actually pointed the run at.
    throw new Error(
      `${dbPath} has no readable \`sessions\` table (${describeError(error)}). ` +
        `${DESKTOP_USER_DATA_DIR_ENV} is not pointing at a Desktop store; rebuild one with ` +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs`."
    );
  } finally {
    db.close();
  }

  const total = Number(row?.total);
  if (!Number.isFinite(total)) {
    throw new Error(
      `${dbPath} returned no usable session count. The snapshot is corrupt; rebuild it with ` +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs`."
    );
  }
  return total;
}

/**
 * Every desktop workload's floor: the sandbox exists and its store is readable.
 *
 * Deliberately says NOTHING about how populated it is. Which population a run
 * needs is the workload's own question — the branches lane measures a corpus it
 * builds itself and is not entitled to fail because the Sessions table is thin.
 * Returns the resolved database path so a caller can ask a further question of
 * it without re-deriving it.
 */
export function requireSandboxDatabase(userDataDir: string): string {
  const dbPath = path.join(userDataDir, DESKTOP_DB_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No ${DESKTOP_DB_FILE_NAME} in ${userDataDir}. ` +
        `${DESKTOP_USER_DATA_DIR_ENV} must point at a sandbox built by ` +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs`, not at a bare directory."
    );
  }
  // Readability is part of the floor: an unreadable or non-Desktop file fails
  // every lane, and failing here names the sandbox instead of surfacing later as
  // an unexplained wedge inside a measured step.
  readSandboxSessionCount(dbPath);
  return dbPath;
}

/**
 * The Sessions lane's extra precondition: the corpus is not empty.
 *
 * File existence alone was never enough (ISS-7785). A snapshot whose sessions
 * all sit outside the view's window renders an empty list, every Sessions step
 * then wedges on a row selector that will never resolve, and a twenty-minute run
 * reports expired wait bounds where its measurements should be. A run that
 * cannot measure anything has to fail here, at the precondition, naming the
 * query that shows why — not eight minutes later as a wall of `:timeout` marks.
 *
 * The count is the WHOLE table, deliberately not the default 7-day window: the
 * sessions workload widens the range to "All time" before it measures, so a
 * corpus that is merely old is fine and only an empty one is fatal.
 */
export function requireSandboxSessions(userDataDir: string): void {
  const dbPath = requireSandboxDatabase(userDataDir);
  const sessionCount = readSandboxSessionCount(dbPath);
  if (sessionCount === 0) {
    throw new Error(
      `${dbPath} holds ZERO sessions, so this run would measure nothing. ` +
        "Rebuild the sandbox from a populated Desktop profile with " +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs` (or `just profile-desktop-prep`), " +
        "and confirm it with: " +
        `sqlite3 "${dbPath}" "SELECT count(*), max(last_activity_at) FROM sessions;"`
    );
  }
  if (sessionCount <= SESSIONS_PAGE_SIZE) {
    console.warn(
      `[perf] sandbox holds ${sessionCount} session(s), no more than one ${SESSIONS_PAGE_SIZE}-row page. ` +
        "A single-page list renders no next-page control at all, so each paginate step waits out " +
        "its full bound and records an unsettled mark rather than a page turn. Rebuild the sandbox " +
        "from a fuller profile to measure the browse-at-scale case the lane exists for."
    );
  }
}
