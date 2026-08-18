#!/usr/bin/env node
// @ts-check
/**
 * Measure Agent Dashboard storage without creating missing DB files.
 *
 * The first-party Agent Dashboard store lives at
 * `<userData>/agent-dashboard.pgdata`. A missing directory is reported as
 * absent and is never opened or created.
 *
 * ISS-5303 reduced this to a shell. The parsing, the recursive walk and the
 * absent-directory branch live in `measure-agent-dashboard-storage-lib.mjs`,
 * and the platform-default userData directory now comes from the canonical
 * `defaultSourceUserDataDir` in `perf-prepare-dataset.mjs` — the same helper
 * the perf-qa dataset prep resolves a real profile with, so the two can no
 * longer disagree about where Electron puts this app's data.
 *
 * That reuse is a deliberate behaviour FIX on Linux: the local copy this file
 * used to carry always returned `~/.config/Closedloop`, while the canonical
 * helper honours `XDG_CONFIG_HOME` the way Electron itself does. On an operator
 * who exports `XDG_CONFIG_HOME`, the old code measured a directory the app has
 * never written to and reported a confident `exists: false`. darwin and win32
 * semantics are unchanged (`~/Library/Application Support/Closedloop`, and
 * `%APPDATA%` falling back to `~/AppData/Roaming`).
 *
 * Usage:
 *   node scripts/measure-agent-dashboard-storage.mjs [--user-data <dir>]
 */

import path from "node:path";
import {
  AGENT_DASHBOARD_STORAGE_DIRNAME,
  AGENT_DASHBOARD_STORAGE_MODE,
  measureExistingDirectory,
  parseUserDataArg,
} from "./measure-agent-dashboard-storage-lib.mjs";
import { defaultSourceUserDataDir } from "./perf-prepare-dataset.mjs";

const userDataPath =
  parseUserDataArg(process.argv) ?? defaultSourceUserDataDir();
const target = {
  mode: AGENT_DASHBOARD_STORAGE_MODE,
  path: path.join(userDataPath, AGENT_DASHBOARD_STORAGE_DIRNAME),
};

console.log(
  JSON.stringify(
    { userDataPath, measurements: [measureExistingDirectory(target)] },
    null,
    2
  )
);
