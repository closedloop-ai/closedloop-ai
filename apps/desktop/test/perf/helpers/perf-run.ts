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

/** The store the dataset CLI snapshots; its presence proves a real sandbox. */
export const DESKTOP_DB_FILE_NAME = "agent-dashboard.sqlite";

/** The settings file the dataset CLI rewrites into its sandbox-safe form. */
export const DESKTOP_SETTINGS_FILE_NAME = "desktop-settings.json";

/** Appended to a step name whose wait never satisfied. */
export const TIMEOUT_STEP_SUFFIX = ":timeout";

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
 */
export function writeRunManifest(runDir: string, lane: string): void {
  fs.writeFileSync(
    path.join(runDir, PERF_RUN_MANIFEST_FILE_NAME),
    `${JSON.stringify({ lane }, null, 2)}\n`,
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
    // The E2E cleanup calls `app.process()` on an ElectronApplication that this
    // function already closed, which throws on Playwright's disposed handle
    // (dogfood run 20260805T152620Z). The artifacts are on disk by now — a
    // failing backstop must not turn a captured run into a failed one.
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
