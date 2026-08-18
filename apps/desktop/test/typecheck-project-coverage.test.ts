/**
 * ISS-5142: the desktop test tree used to sit outside every typecheck project.
 *
 * `tsconfig.json` included only `src/**\/*.ts`, so `pnpm turbo typecheck --force`
 * reported every package successful while ~7,400 tests were never checked at
 * all. A fixture extraction that dropped an exported helper broke
 * `gateway-server.test.ts` at ESM load and a full forced typecheck stayed green;
 * only code review caught it.
 *
 * `tsconfig.tests.json` and `tsconfig.e2e.json` close that hole. This guard
 * keeps them closed. It exists because the gap is silent by construction: if the
 * coverage regresses, nothing fails — the gate just quietly stops looking, which
 * is exactly the failure mode ISS-5142 was filed for.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { TYPECHECK_PROJECTS } from "../scripts/typecheck-projects.mjs";

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

/**
 * The deferred-suite list `tsconfig.tests.json` carried when the test tree was
 * first brought under typecheck, pinned BY PATH rather than by count.
 *
 * The list is SHRINK-ONLY, and a count ceiling cannot enforce that: swapping a
 * green suite out for a newly-excluded one keeps the total identical, so a
 * `length <= N` assertion stays green while coverage regresses. Pinning the
 * baseline set and asserting the live list is a SUBSET of it makes the only
 * legal edit a deletion — a path that is not already on this list can never be
 * deferred, so a new suite is covered by the `test/**\/*.ts` include from the
 * day it is written and excluding it instead of fixing it re-opens ISS-5142.
 *
 * Bringing a suite back to green means deleting its entry from
 * `tsconfig.tests.json`. Leave this baseline alone: it is the historical high
 * water mark, and shrinking it too would erase the evidence of what was paid
 * down. Never add to it.
 */
const DEFERRED_SUITE_BASELINE: readonly string[] = [
  "test/app-menu-labs.test.ts",
  "test/artifact-ref-extractor.test.ts",
  "test/attribution-importer.test.ts",
  "test/audit-service.test.ts",
  "test/authorized-command-key-store.test.ts",
  "test/batch-event-inserts.test.ts",
  "test/billing-mode-read-path-parity.test.ts",
  "test/boot-recovery.test.ts",
  "test/bootstrap-crash-handlers.test.ts",
  "test/branch-cost-evidence.test.ts",
  "test/branch-reads-contract.test.ts",
  "test/chat-session.test.ts",
  "test/claude-subagent-row-dedup.test.ts",
  "test/cloud-command-executor.test.ts",
  "test/collection-mode.test.ts",
  "test/command-key-notification-boundary.test.ts",
  "test/command-key-reconciler.test.ts",
  "test/component-invocations-command-key-identity.test.ts",
  "test/component-invocations-idempotent-insert.test.ts",
  "test/component-invocations-materialization.test.ts",
  "test/component-invocations-skill-command-shadow.test.ts",
  "test/cost-reconciliation-service.test.ts",
  "test/dashboard-queries-contract.test.ts",
  "test/data-revision-rebuild.test.ts",
  "test/data-revision-targeted-resync.test.ts",
  "test/desktop-analytics-http-lane.test.ts",
  "test/desktop-cloud-github-nudge.test.ts",
  "test/desktop-identity-client.test.ts",
  "test/desktop-telemetry-http-client.test.ts",
  "test/feature-flags-shared-ui.test.ts",
  "test/gateway-auth.test.ts",
  "test/gateway-dispatch-ipc.test.ts",
  "test/gateway-recovery.test.ts",
  "test/git-action-op.test.ts",
  "test/import-revision-seal-orphan-heal.test.ts",
  "test/ingest-orchestrator.test.ts",
  "test/ipc-sender-gates.test.ts",
  "test/keyboard-activation.test.ts",
  "test/local-session-pull-requests.test.ts",
  "test/local-transcript-path-resolver.test.ts",
  "test/loop-http.test.ts",
  "test/maintenance-write-txs.test.ts",
  "test/model-pricing-sqlite.test.ts",
  "test/org-sync-policy.test.ts",
  "test/owner-facet-session-population.test.ts",
  "test/reconciliation-cause-hint.test.ts",
  "test/required-plugin-installer-runtime-ready.test.ts",
  "test/required-plugin-installer.test.ts",
  "test/scheduled-review-dispatch.test.ts",
  "test/scheduled-tasks-ipc.test.ts",
  "test/scheduler-service.test.ts",
  "test/session-trace-branch-resolution.test.ts",
  "test/shared-agent-sessions-api.test.ts",
  "test/shared-agent-sessions-sort.test.ts",
  "test/shared-branch-trace.test.ts",
  "test/shared-branches-api.test.ts",
  "test/shared-branches-associated-pr.test.ts",
  "test/shared-trace-comments-store.test.ts",
  "test/spawn-hardening.test.ts",
  "test/spawn-retry.test.ts",
  "test/sqlite-conversion-golden.test.ts",
  "test/store-integrity-probe.test.ts",
  "test/symphony-loop-evaluate-plan.test.ts",
  "test/symphony-loop-evaluate-prd.test.ts",
  "test/symphony-loop-execute.test.ts",
  "test/symphony-loop-finalize-additional-repos.test.ts",
  "test/symphony-loop-handle-process-completion.test.ts",
  "test/symphony-loop-shared-contract.test.ts",
  "test/terminal-chat.test.ts",
  "test/tool-call-detail-import.test.ts",
  "test/trace-comment-parent-session-cloud-post.test.ts",
  "test/wal-probe-health-monitored.test.ts",
  "test/work-item-occurrences.test.ts",
];

const TESTS_PROJECT_INCLUDE = "test/**/*.ts";
const E2E_PROJECT_INCLUDE = "test/e2e/**/*.ts";
const E2E_EXCLUDE_ENTRY = "test/e2e";

const TESTS_PROJECT_CONFIG = "tsconfig.tests.json";
const E2E_PROJECT_CONFIG = "tsconfig.e2e.json";
const RUNS_PROJECT_RUNNER_RE = /\brun-typecheck-passes\.mjs\b/;

function readJsonc(relativePath: string): Record<string, unknown> {
  const absolutePath = path.join(desktopDir, relativePath);
  const raw = readFileSync(absolutePath, "utf8");
  // tsconfigs carry `//` comments, so `JSON.parse` cannot read them. The
  // TypeScript compiler's own JSONC reader is the same parser `tsc -p` uses.
  const parsed = ts.parseConfigFileTextToJson(absolutePath, raw);
  if (parsed.error) {
    throw new Error(`${relativePath} is not parseable as a tsconfig`);
  }
  const config: unknown = parsed.config;
  if (!(config && typeof config === "object")) {
    throw new Error(`${relativePath} did not parse to an object`);
  }
  return config as Record<string, unknown>;
}

function readStringArray(
  config: Record<string, unknown>,
  key: string,
  label: string
): string[] {
  const value = config[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label} has no \`${key}\` array`);
  }
  if (value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} \`${key}\` holds a non-string entry`);
  }
  return value as string[];
}

/**
 * Entries deferred by `tsconfig.tests.json` that the ISS-5142 baseline never
 * contained. Non-empty means coverage went BACKWARDS, whatever the total is.
 */
function nonBaselineDeferrals(deferred: readonly string[]): string[] {
  const baseline = new Set(DEFERRED_SUITE_BASELINE);
  return deferred.filter((entry) => !baseline.has(entry));
}

describe("ISS-5142 desktop typecheck coverage", () => {
  // ISS-5375 re-expressed this as coverage of the runner's PROJECT INVENTORY
  // rather than a regex over the `typecheck` script string. The old assertion
  // matched `/\btypecheck:tests\b/` against that string, which pinned the serial
  // `&&` chain in place — the chain could not be parallelized without tripping a
  // guard that was never about serialization. The gap it protects is unchanged
  // and still silent by construction, so the guard is re-shaped, not dropped:
  // `run-typecheck-passes.mjs` executes exactly `TYPECHECK_PROJECTS`, so a
  // project missing from this array is a project the gate stops checking.
  test("the gate's project inventory still covers the tests and e2e projects", () => {
    const projects = new Map(
      TYPECHECK_PROJECTS.map((entry) => [entry.project, entry])
    );

    // A tsconfig no project entry names is not a gate — it is a file.
    assert.ok(
      projects.has(TESTS_PROJECT_CONFIG),
      `the typecheck runner must cover ${TESTS_PROJECT_CONFIG} or apps/desktop/test/** goes unchecked again`
    );
    assert.ok(
      projects.has(E2E_PROJECT_CONFIG),
      `the typecheck runner must cover ${E2E_PROJECT_CONFIG} or apps/desktop/test/e2e/** goes unchecked again`
    );

    // Two projects writing one .tsbuildinfo would make each invalidate the
    // other's incremental state, silently degrading the gate to a full re-check
    // or, worse, a stale one.
    const buildInfoFiles = TYPECHECK_PROJECTS.map(
      (entry) => entry.tsBuildInfoFile
    );
    assert.equal(
      new Set(buildInfoFiles).size,
      buildInfoFiles.length,
      "each typecheck project needs its own tsBuildInfoFile"
    );

    for (const entry of TYPECHECK_PROJECTS) {
      assert.ok(
        existsSync(path.join(desktopDir, entry.project)),
        `${entry.project} is listed in TYPECHECK_PROJECTS but does not exist`
      );
    }
  });

  // The inventory above is only a gate if the `typecheck` script actually runs
  // it. Three workflows invoke this pnpm script directly, bypassing turbo
  // (pr-test.yml's REQUIRED `desktop` job, desktop-test-validation.yml and
  // desktop-test-auto-revert.yml), so a script that stopped invoking the runner
  // would disable the gate on all three while every tsconfig stayed present.
  test("the typecheck script runs the project runner", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(desktopDir, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const scripts = manifest.scripts;
    assert.ok(scripts, "apps/desktop/package.json has no scripts block");

    const typecheck = scripts.typecheck;
    assert.ok(typecheck, "apps/desktop has no `typecheck` script");
    assert.match(
      typecheck,
      RUNS_PROJECT_RUNNER_RE,
      "`typecheck` must run scripts/run-typecheck-passes.mjs or no tsc project is checked at all"
    );
    assert.ok(
      existsSync(path.join(desktopDir, "scripts/run-typecheck-passes.mjs")),
      "the typecheck runner script is missing"
    );
  });

  test("the tests project still covers the whole test tree by default", () => {
    const config = readJsonc("tsconfig.tests.json");
    const include = readStringArray(config, "include", "tsconfig.tests.json");

    // Narrowing the include is the regression this guard exists to catch: it
    // would leave new suites unchecked from the day they are written, which is
    // the original ISS-5142 gap wearing a different hat.
    assert.deepEqual(
      include,
      [TESTS_PROJECT_INCLUDE],
      `tsconfig.tests.json must include exactly ["${TESTS_PROJECT_INCLUDE}"] so new suites are covered by default`
    );
  });

  test("the deferred-suite list is shrink-only and free of stale entries", () => {
    const config = readJsonc("tsconfig.tests.json");
    const exclude = readStringArray(config, "exclude", "tsconfig.tests.json");

    assert.ok(
      exclude.includes(E2E_EXCLUDE_ENTRY),
      `tsconfig.tests.json must exclude "${E2E_EXCLUDE_ENTRY}" — it has its own project`
    );

    const deferred = exclude.filter((entry) => entry !== E2E_EXCLUDE_ENTRY);

    // Subset, not a count. A ceiling passes when one path is swapped for
    // another, which is a coverage regression wearing a constant total.
    const added = nonBaselineDeferrals(deferred);
    assert.deepEqual(
      added,
      [],
      `tsconfig.tests.json defers suites that were not in the ISS-5142 baseline: ${added.join(", ")}. The list is shrink-only — fix the suite's type errors instead of adding it here.`
    );

    // A duplicated entry would let the set shrink while the file grows, and is
    // an unauditable no-op either way.
    const duplicated = deferred.filter(
      (entry, index) => deferred.indexOf(entry) !== index
    );
    assert.deepEqual(
      duplicated,
      [],
      `tsconfig.tests.json lists the same deferred suite more than once: ${duplicated.join(", ")}.`
    );

    // A renamed or deleted suite leaves a dead entry behind, and a dead entry is
    // an exclusion nobody can audit. Deleting it is free; leaving it rots.
    const stale = deferred.filter(
      (entry) => !existsSync(path.join(desktopDir, entry))
    );
    assert.deepEqual(
      stale,
      [],
      `tsconfig.tests.json defers suites that no longer exist: ${stale.join(", ")}. Delete the stale entries.`
    );
  });

  test("the shrink-only check rejects a same-count suite swap", () => {
    // The failure a count ceiling could not see: un-defer one baseline suite,
    // defer a fresh one in its place, total unchanged. Driven with synthetic
    // input because the real config is (correctly) green, so only a fabricated
    // regression can prove the predicate actually decides anything.
    const swapped = [
      ...DEFERRED_SUITE_BASELINE.slice(1),
      "test/newly-written-suite.test.ts",
    ];
    assert.equal(swapped.length, DEFERRED_SUITE_BASELINE.length);
    assert.deepEqual(nonBaselineDeferrals(swapped), [
      "test/newly-written-suite.test.ts",
    ]);

    // ...and stays green on the only legal edit, a deletion.
    assert.deepEqual(
      nonBaselineDeferrals(DEFERRED_SUITE_BASELINE.slice(1)),
      []
    );
  });

  test("the e2e project covers test/e2e with no deferred suites", () => {
    const config = readJsonc("tsconfig.e2e.json");
    const include = readStringArray(config, "include", "tsconfig.e2e.json");

    assert.deepEqual(
      include,
      [E2E_PROJECT_INCLUDE],
      `tsconfig.e2e.json must include exactly ["${E2E_PROJECT_INCLUDE}"]`
    );

    // test/e2e was brought to green in the same change, so unlike the node-side
    // project it carries no debt list. Keep it that way.
    assert.equal(
      config.exclude,
      undefined,
      "tsconfig.e2e.json must not defer any spec — it was landed fully green"
    );
  });
});
