import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { collectTsFiles } from "./helpers/collect-ts-files.js";

// PLN-999 guardrail. electron-vite bundles the desktop main process: rollup only
// emits the entry points it is told about plus their STATIC import graph.
// Several Node entry points are spawned as separate processes by runtime PATH —
// `new URL("./<name>.js", import.meta.url)` handed to utilityProcess.fork /
// worker_threads — and are NEVER statically imported. Unless each is declared as
// its own rollup entry, it is silently dropped from dist/main and the fork
// crashes at runtime with `ERR_MODULE_NOT_FOUND` (the db-host-worker boot loop).
//
// The old per-file `tsc` build emitted every `.ts`, so these "just existed";
// headless tests fork-mock the workers, so they never caught the gap. This test
// closes it: every `new URL("./<name>.js", import.meta.url)` worker reference in
// src/main MUST have a matching `"<name>":` input entry in the electron-vite
// config (entry key === emitted basename, because entryFileNames is "[name].js").

const MAIN_DIR = "src/main";
const CONFIG_PATH = "electron.vite.config.ts";
const WORKER_URL_PATTERN =
  /new URL\(\s*["']\.\/([^"']+?)\.js["']\s*,\s*import\.meta\.url/g;

function workerEntryNamesReferencedIn(source: string): string[] {
  const names: string[] = [];
  WORKER_URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = WORKER_URL_PATTERN.exec(source);
  while (match !== null) {
    names.push(match[1]);
    match = WORKER_URL_PATTERN.exec(source);
  }
  return names;
}

describe("desktop forked-worker entry bundling (PLN-999)", () => {
  test('every new URL("./<name>.js", import.meta.url) worker is a declared electron-vite entry', () => {
    const configSource = readFileSync(CONFIG_PATH, "utf8");

    const referenced = new Set<string>();
    for (const file of collectTsFiles(MAIN_DIR)) {
      for (const name of workerEntryNamesReferencedIn(
        readFileSync(file, "utf8")
      )) {
        referenced.add(name);
      }
    }

    // Sanity: the known forked workers must be discoverable, so a regression in
    // the scan itself can't make this test vacuously pass.
    assert.ok(
      referenced.has("db-host-worker"),
      "expected to find the db-host-worker runtime reference in src/main"
    );

    const missing = [...referenced].filter(
      (name) => !configSource.includes(`"${name}":`)
    );
    assert.deepEqual(
      missing,
      [],
      `These forked-worker entry points are referenced via new URL(import.meta.url) but are NOT declared as electron-vite rollup inputs, so they will be dropped from dist/main and crash the fork at runtime. Add each to MAIN_WORKER_ENTRIES in ${CONFIG_PATH}:\n${missing.join("\n")}`
    );
  });
});
