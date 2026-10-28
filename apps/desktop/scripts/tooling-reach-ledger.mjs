// @ts-check
/**
 * ISS-5303 — the tooling-partition reach ledger.
 *
 * The `tooling` partition (desktop-relative `scripts/`) is measured by the c8
 * node lane, which reports only files loaded at runtime. A script no test ever
 * imports contributes nothing and simply vanishes from the numbers — the
 * partition percentage looks healthy while most of the directory is unmeasured.
 * PRD-618 rule 4 forbids that: a file outside the measurement must be NAMED,
 * never silently omitted.
 *
 * This module is that naming. Each entry declares one `scripts/` file the node
 * lane cannot execute and says why, and `diffToolingReach` reconciles the
 * declared set against what the run actually measured.
 *
 * TWO RULES GOVERN AN ENTRY, and both exist because the easy failure mode is
 * laundering an inconvenient number into an "exclusion":
 *
 *   1. A reason must be a FILE-SPECIFIC IMPOSSIBILITY — this file cannot be
 *      executed by a node-lane test. A low or awkward branch percentage is
 *      NEVER a reason. If a file is coverable, it gets covered; if covering it
 *      lowers the partition average, PRD-618 rule 3 says that is honest
 *      denominator growth ("progress, not regression") and it gets disclosed.
 *   2. An entry is a claim about the tree, so it can rot. `diffToolingReach`
 *      reports an entry whose file is gone AND an entry whose file turned out
 *      to be executed after all, so a stale exclusion cannot outlive its reason.
 *
 * The ledger REPORTS; it does not gate. `report-coverage.mjs` folds these
 * entries into the emitted `validityLedger` and prints any gap, but adds no new
 * exit code: `coverage-main.yml`'s lane step has no `continue-on-error`, so
 * making a reach gap fatal would redden main's own base-publish job on every
 * push and break the `coverage-base` artifact that every PR compares against.
 */

/**
 * The partition this ledger describes. Owned here so the reporter and the
 * tests agree on one spelling; it matches the `tooling` rule in
 * PARTITION_RULES (report-coverage-lib.mjs), whose prefix is `scripts/`.
 */
export const TOOLING_PARTITION = "tooling";

/**
 * @typedef {object} ToolingReachLedgerEntry
 * @property {string} path Desktop-relative path, e.g. "scripts/dev-launch.mjs".
 * @property {string} reason Why the node lane cannot execute this file.
 */

/** @type {readonly ToolingReachLedgerEntry[]} */
export const TOOLING_REACH_LEDGER = [
  {
    path: "scripts/run-typecheck-passes.mjs",
    reason:
      "Runs all five Desktop TypeScript projects at module scope and deliberately has no dry-run or main-module guard, so importing it from the node coverage lane would launch a full concurrent Desktop typecheck. test/run-typecheck-passes.test.ts instead subprocess-drives a byte-for-byte copy against throwaway projects and separately exercises the real inventory through the injectable typecheck-runner.mjs seam; the copied command proves its exit contract without crediting this live entrypoint path.",
  },
  {
    path: "scripts/build-main-dev.mjs",
    reason:
      "A `build:main` invocation. Every statement is a call into the bundler with fixed arguments; executing it from a test would run a real main-process build for no assertion.",
  },
  {
    path: "scripts/rehearsal-verify.ts",
    reason:
      "The rehearsal entrypoint: reads a live rehearsal store and shells out. Its check logic is already extracted to scripts/rehearsal-verify-checks.ts and covered by test/rehearsal-verify-checks.test.ts; what remains is store I/O and process exit.",
  },
  {
    path: "scripts/assert-e2e-results.mjs",
    reason:
      "Gates the REQUIRED desktop-e2e check and is fail-closed by design. Its behaviour is already covered end-to-end: scripts/lint/desktop-e2e-exit-code-workflow-source.test.ts subprocess-drives this exact script across the clean, failing, missing, truncated, changed-contract, runner-error and nothing-ran fixtures. That suite runs in the repo-root vitest lane, so it does not mark the file executed in the desktop c8 lane — but writing a second desktop-lane copy of the same assertions would duplicate a test to move a reach counter rather than cover a risk.",
  },

  // ISS-5303 — drained entrypoint shells. Each of these had its decision logic
  // extracted into a sibling `-lib` module that IS executed and tested; what
  // remains is a shell that does its whole job at module scope (spawn, download,
  // delete, or rasterize), so importing it from a test would perform that job.
  // Where the shell cannot be driven as a subprocess either, the extraction's
  // wiring is pinned with the sanctioned ts.createSourceFile AST route so a
  // re-added local copy of a helper cannot silently shadow the import.
  {
    path: "scripts/autonomy-calibration.ts",
    reason:
      "Has an unguarded module-level `await main()`, so importing it RUNS the calibration: it snapshots a live agent store and shells out. The pure scoring engine (scoreSession, ancestorAutonomy, groupBursts, sortedTimes) is extracted to scripts/autonomy-calibration-lib.ts, which is executed and covered by test/autonomy-calibration-lib.test.ts; the shell keeps only main(), snapshotStore and loadSessionInputs.",
  },
  {
    path: "scripts/ensure-electron-binary.mjs",
    reason:
      "Downloads and unpacks a ~100 MB Electron archive at module scope, with no CLI seam to stop short of the download, so neither importing nor subprocess-driving it is acceptable in a test. Its platform table, Rosetta probe and arch resolution are extracted to scripts/ensure-electron-binary-lib.mjs, executed and covered by test/ensure-electron-binary-lib.test.ts; the import wiring is pinned by AST assertion.",
  },
  {
    path: "scripts/generate-auth-handoff-assets.mjs",
    reason:
      "Writes src/shared/auth-handoff-assets.generated.ts at module scope with no dry-run or output-path seam. src/main/auth/desktop-handoff-page.ts imports that generated file, so rewriting it while the node lane runs would race the suites that load it. Theme extraction, the missing-theme throw, data-URL encoding and module rendering are extracted to scripts/generate-auth-handoff-assets-lib.mjs and executed by test/generate-auth-handoff-assets-lib.test.ts; that suite also subprocess-drives a byte-copy of this entrypoint inside a temp tree, which credits the copy, not this path.",
  },
  {
    path: "scripts/generate-docs-bundle-manifest.mjs",
    reason:
      "Resolves the docs root off import.meta.url and rewrites the generated docs bundle in place. Several src/ modules that run concurrently in the node lane import that generated output, so regenerating it mid-run would race them. test/docs-bundle-manifest-lib.test.ts therefore subprocess-drives a byte-copy of this entrypoint inside a temp monorepo-shaped tree — which proves equivalence and helper provenance but credits the copy, not this path. All eleven extracted helpers live in scripts/generate-docs-bundle-manifest-lib.mjs and are executed.",
  },
  {
    path: "scripts/generate-icons.cjs",
    reason:
      "Reads the tray SVG and rasterizes PNG icon assets through `sharp` at module scope, writing into resources/; there is no CLI seam that stops before the write. The pure SVG builder and path extraction are in scripts/generate-icons-lib.cjs, executed and covered by test/generate-icons-lib.test.ts against the real tray SVG at every size the entrypoint uses.",
  },
  {
    path: "scripts/measure-claude-code-candidate-scan.mts",
    reason:
      "A `.mts` file, and c8 cannot credit `.mts`: its default `extension` list (@istanbuljs/schema default-extension) is .js, .cjs, .mjs, .ts, .tsx and .jsx, and test:node:coverage sets no override, so even a test that ran this file would leave it unreached. It also ends in an unguarded module-level `await main()` that builds the full ISS-7352-scale fixture (32,930 cost-event rows plus 45,000 tool-result rows) and times it, so importing it runs the whole measurement. It is ISS-11323's hand-run evidence harness. The query it times, loadClaudeCodeTelemetryCandidates, lives in src/main/otel/claude-code-telemetry-candidates.ts and is covered there.",
  },
  {
    path: "scripts/reset-dashboard-db.mjs",
    reason:
      "Destructively deletes the local Agent Dashboard database at module scope; its only guard is a refusal when the app is running. Driving it from a test would delete the operator's real store, so it is deliberately never executed. Path selection and removal are extracted to scripts/reset-dashboard-db-lib.mjs, executed and covered against mkdtemp fixtures, with the import wiring pinned by AST assertion.",
  },
  {
    path: "scripts/run-electron-builder.mjs",
    reason:
      "Spawns a full electron-builder packaging run at module scope. The fail-closed macOS signing-secret classification and the ISS-10381 transient-signing-failure allowlist are both extracted to scripts/run-electron-builder-lib.mjs and executed — the first exhaustively over all 32 subsets of the five signing variables so that a partially-configured environment can never classify as signable, the second over the retryable and non-retryable failure rows. test/run-electron-builder-lib.test.ts additionally subprocess-drives a byte-for-byte copy of this entrypoint with electron-builder stubbed to pin the one-retry bound and its gate; that credits the copy, not this path.",
  },
  {
    path: "scripts/stage-packaging-app.mjs",
    reason:
      "Spawns `pnpm pack` and `tar` at module scope to materialize the packaging stage tree, so it cannot be imported or safely driven. Its four pure helpers, including the assertNoUnresolvedWorkspaceSpecs packaging safety guard, are extracted to scripts/stage-packaging-deps-lib.mjs and executed; an AST wiring assertion pins the single classification call site and its third argument, derived from the DESKTOP_RUNTIME_CLOSURE single source of truth.",
  },
  {
    path: "scripts/vibe-profile/safe-storage-encrypt.mjs",
    reason:
      "An Electron main-process entry, launched only by scripts/vibe-profile/sign-in.ts through the Electron binary. It calls `app.setName` and `app.whenReady` at module scope, and under plain Node the `electron` import resolves to the binary's path string, so importing it from the node lane throws before any line runs. Driving it for real needs an Electron process with a working OS keyring for safeStorage, which the c8 node lane does not instrument.",
  },
];

/**
 * Reconcile the declared ledger against what a run actually measured.
 *
 * `unledgeredUnreached` is the number that matters: a `scripts/` file that no
 * test executed and that nobody declared. It is the silent gap PRD-618 rule 4
 * exists to prevent, and it should always be empty.
 *
 * Staleness has two shapes and both are reported, because an exclusion that
 * outlives its justification is just an undocumented gap wearing a reason:
 *   - `missingFromSource` — the file is gone (deleted or renamed).
 *   - `actuallyExecuted`  — a test now reaches it, so the entry is obsolete.
 *
 * The ledger is passed in rather than read from module scope so the reconciler
 * can be driven with synthetic inputs. That keeps its tests independent of the
 * real tree: adding a script to apps/desktop/scripts/ must never redden a unit
 * test that is about reconciliation logic.
 *
 * @param {readonly ToolingReachLedgerEntry[]} ledger
 * @param {readonly string[]} sourceFiles Tooling-partition source paths.
 * @param {readonly string[]} executedFiles Paths the run actually executed.
 * @returns {{
 *   unledgeredUnreached: string[],
 *   staleLedgered: { path: string, kind: "missingFromSource" | "actuallyExecuted" }[],
 *   ledgeredUnreached: string[],
 *   reconciled: boolean,
 *   counts: { sourceFiles: number, executedFiles: number, ledgered: number, unreached: number },
 * }}
 */
export function diffToolingReach(ledger, sourceFiles, executedFiles) {
  const sourceSet = new Set(sourceFiles);
  const executedSet = new Set(executedFiles);
  const ledgerPaths = ledger.map((entry) => entry.path);
  const ledgerSet = new Set(ledgerPaths);

  const unreached = [...sourceSet].filter((path) => !executedSet.has(path));

  const unledgeredUnreached = unreached
    .filter((path) => !ledgerSet.has(path))
    .sort();

  const ledgeredUnreached = unreached
    .filter((path) => ledgerSet.has(path))
    .sort();

  /** @type {{ path: string, kind: "missingFromSource" | "actuallyExecuted" }[]} */
  const staleLedgered = [];
  for (const path of ledgerPaths) {
    if (!sourceSet.has(path)) {
      staleLedgered.push({ path, kind: "missingFromSource" });
      continue;
    }
    if (executedSet.has(path)) {
      staleLedgered.push({ path, kind: "actuallyExecuted" });
    }
  }
  staleLedgered.sort((a, b) => a.path.localeCompare(b.path));

  return {
    unledgeredUnreached,
    staleLedgered,
    ledgeredUnreached,
    reconciled: unledgeredUnreached.length === 0 && staleLedgered.length === 0,
    counts: {
      sourceFiles: sourceSet.size,
      executedFiles: [...executedSet].filter((path) => sourceSet.has(path))
        .length,
      ledgered: ledgerSet.size,
      unreached: unreached.length,
    },
  };
}

/**
 * Render the reconciliation as the console diagnostic the coverage lane prints.
 * Returns an empty array when everything reconciles, so the caller can stay
 * quiet on the happy path.
 *
 * @param {ReturnType<typeof diffToolingReach>} diff
 * @returns {string[]}
 */
export function formatToolingReachGap(diff) {
  const lines = [];
  for (const path of diff.unledgeredUnreached) {
    lines.push(
      `[tooling-reach] ${path} is not executed by any node-lane test and has no ledger entry — add a test, or declare it in scripts/tooling-reach-ledger.mjs with a file-specific reason (never a percentage).`
    );
  }
  for (const entry of diff.staleLedgered) {
    const detail =
      entry.kind === "missingFromSource"
        ? "no longer exists in the tooling source universe"
        : "IS executed now, so the exclusion is obsolete";
    lines.push(
      `[tooling-reach] stale ledger entry ${entry.path}: ${detail} — remove it from scripts/tooling-reach-ledger.mjs.`
    );
  }
  return lines;
}
