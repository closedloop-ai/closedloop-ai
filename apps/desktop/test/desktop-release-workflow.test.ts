import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { parse } from "yaml";

// cwd for the desktop test suite is apps/desktop.
const WORKFLOW_PATH = path.resolve(
  "..",
  "..",
  ".github",
  "workflows",
  "desktop-release.yml"
);

const COMMENT_LINE_PATTERN = /^\s*#/;
const FROZEN_LOCKFILE_PATTERN = /pnpm install --frozen-lockfile/;
// Any rebuild path that would let the install resolve fresh/unpinned deps and
// drift the closure away from the validated SHA's lockfile (FR-3).
const UNPINNED_INSTALL_PATTERN =
  /--no-frozen-lockfile|--fix-lockfile|pnpm (add|update|up|upgrade)\b/;

const WORKFLOW_SOURCE = fs.readFileSync(WORKFLOW_PATH, "utf8");
// Executable lines only (drops `#` comment lines that may legitimately mention a
// guarded pattern when explaining an invariant).
const WORKFLOW_EXECUTABLE = WORKFLOW_SOURCE.split("\n")
  .filter((line) => !COMMENT_LINE_PATTERN.test(line))
  .join("\n");

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type WorkflowJob = {
  name?: string;
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
};
type WorkflowDispatchTrigger = {
  inputs?: Record<string, { required?: boolean; type?: string }>;
};
const workflow = parse(WORKFLOW_SOURCE) as {
  on?: { workflow_dispatch?: WorkflowDispatchTrigger | null } & Record<
    string,
    unknown
  >;
  jobs?: Record<string, WorkflowJob>;
};

const releaseJob = workflow.jobs?.release;
const steps = releaseJob?.steps ?? [];

function stepIndex(predicate: (step: WorkflowStep) => boolean): number {
  return steps.findIndex(predicate);
}

const PREFLIGHT_RUN_PATTERN =
  /pnpm exec tsx scripts\/deploy\/desktop-release-preflight\.ts/;
const READ_VERSION_RUN_PATTERN = /read-desktop-version\.ts/;
const PACKAGE_RUN_PATTERN = /pnpm turbo package:turbo --filter=desktop/;
const INSTALL_RUN_PATTERN = /pnpm install\b/;
const MAIN_REF_GUARD_PATTERN = /Release Desktop must be manually dispatched/;
const EXIT_FAILURE_PATTERN = /exit 1/;
// FEA-2135: the release builds/targets the version's canonical commit — the
// desktop-v* tag commit resolved by read-desktop-version.ts (RELEASE_SHA), which
// precheck exposes as needs.precheck.outputs.release_sha for the release
// checkout. This keeps build == validated == target == tag commit (FEA-1936),
// even when github.sha is a later non-desktop commit.
const RELEASE_TARGET_PATTERN =
  /--target "\$\{\{ steps\.release_metadata\.outputs\.RELEASE_SHA \}\}"/;
const RELEASE_SHA_REF_PATTERN =
  /^\$\{\{ needs\.precheck\.outputs\.release_sha \}\}$/;
// The literal GitHub Actions expressions compared against the workflow's parsed
// `env.TARGET_SHA` / `with.ref` values. The leading `$` is split from `{{` so no
// single string literal contains `${` (which the noTemplateCurlyInString lint
// rule flags as a likely JS-interpolation mistake — here it is an intentional
// Actions expression).
const ACTIONS_OPEN = `${"$"}{{ `;
const RELEASE_SHA_EXPRESSION = `${ACTIONS_OPEN}steps.release_metadata.outputs.RELEASE_SHA }}`;
const PRECHECK_RELEASE_SHA_REF = `${ACTIONS_OPEN}needs.precheck.outputs.release_sha }}`;
// Every build/package step gates itself on the preflight status output; this is
// the marker that identifies a preflight-gated step.
const PREFLIGHT_GATE_PATTERN = /steps\.preflight\.outputs\.status/;
const RELEASE_CREATE_STEP_NAME = "Create Versioned Desktop Release";

describe("desktop release workflow — deterministic rebuild (FEA-1936 FR-3 / FR-4)", () => {
  test("is a manual dispatch gated to the main branch", () => {
    const on = workflow.on ?? {};
    assert.deepEqual(Object.keys(on), ["workflow_dispatch"]);
    // The guard must actually FAIL the run on a non-main ref — assert the guard
    // step both carries the message and exits non-zero, not just logs.
    const guard = steps.find((step) =>
      MAIN_REF_GUARD_PATTERN.test(step.run ?? "")
    );
    assert.ok(guard, "release job must have the main-ref guard step");
    assert.match(guard.run ?? "", EXIT_FAILURE_PATTERN);
  });

  test("rebuilds from the exact target SHA, never a floating ref (FR-3)", () => {
    const checkout = steps.find((step) =>
      (step.uses ?? "").startsWith("actions/checkout")
    );
    assert.ok(checkout, "release job must check out the repository");
    // Pinning to the resolved tag commit (needs.precheck.outputs.release_sha) is
    // what makes the rebuild deterministic AND validated — a floating
    // `main`/ref_name, or even github.sha when it is a later non-desktop commit,
    // would let the built tree differ from the validated, tagged commit (FEA-2135
    // + FEA-1936 FR-3).
    assert.match(checkout.with?.ref ?? "", RELEASE_SHA_REF_PATTERN);
    // The version read runs against the same checked-out tag commit.
    const readVersion = steps.find((step) =>
      READ_VERSION_RUN_PATTERN.test(step.run ?? "")
    );
    assert.ok(readVersion, "release job must read the desktop version");
    assert.equal(readVersion.env?.TARGET_SHA, PRECHECK_RELEASE_SHA_REF);
  });

  test("installs with a frozen lockfile and no unpinned rebuild path (FR-3 / AC-2)", () => {
    assert.match(WORKFLOW_EXECUTABLE, FROZEN_LOCKFILE_PATTERN);
    assert.doesNotMatch(
      WORKFLOW_EXECUTABLE,
      UNPINNED_INSTALL_PATTERN,
      "release must not introduce an unpinned/lockfile-mutating install"
    );
    // Exactly one dependency install, and it is the frozen one.
    const installSteps = steps.filter((step) =>
      INSTALL_RUN_PATTERN.test(step.run ?? "")
    );
    assert.equal(installSteps.length, 1);
    assert.match(installSteps[0]?.run ?? "", FROZEN_LOCKFILE_PATTERN);
  });

  test("runs the preflight gate before EVERY build/package step (FR-4)", () => {
    const preflightIdx = stepIndex((step) =>
      PREFLIGHT_RUN_PATTERN.test(step.run ?? "")
    );
    const packageIdx = stepIndex((step) =>
      PACKAGE_RUN_PATTERN.test(step.run ?? "")
    );
    assert.ok(preflightIdx >= 0, "release job must run the preflight script");
    assert.ok(packageIdx >= 0, "release job must run the package step");

    // "an unvalidated SHA never builds" requires the gate to precede ALL the
    // preflight-gated steps (verify-electron / lint / typecheck / test /
    // package), not just package — otherwise a reordering could let one run on
    // an unvalidated SHA. Every step gated on the preflight output (and the
    // package step itself) must come after the preflight step.
    const gatedIndexes = steps
      .map((step, index) => ({ step, index }))
      .filter(
        ({ step }) =>
          PREFLIGHT_GATE_PATTERN.test(step.if ?? "") ||
          PACKAGE_RUN_PATTERN.test(step.run ?? "")
      )
      .map(({ index }) => index);
    assert.ok(
      gatedIndexes.length >= 2,
      "expected multiple preflight-gated steps"
    );
    for (const index of gatedIndexes) {
      assert.ok(
        preflightIdx < index,
        `preflight (step ${preflightIdx}) must run before gated step ${index}`
      );
    }
  });

  test("the preflight step is hard-failing — not continue-on-error (FR-4)", () => {
    // FailUnvalidatedPackaging exits non-zero; a continue-on-error here would let
    // an unvalidated SHA flow into the build/release steps anyway.
    const preflight = steps.find((step) =>
      PREFLIGHT_RUN_PATTERN.test(step.run ?? "")
    ) as (WorkflowStep & { "continue-on-error"?: boolean }) | undefined;
    assert.ok(preflight, "release job must run the preflight script");
    assert.notEqual(preflight["continue-on-error"], true);
    assert.equal(preflight.id, "preflight");
    // The gate reads the commit status of the version's canonical commit
    // (RELEASE_SHA = the tag commit being built), so build == validated == target.
    // Assert THIS step's env directly — a whole-WORKFLOW_SOURCE match would also
    // be satisfied by the precheck job's TARGET_SHA (FEA-1941), so dropping it
    // here would slip through.
    assert.equal(preflight.env?.TARGET_SHA, RELEASE_SHA_EXPRESSION);
  });

  test("grants statuses:read so the gate can read the validated commit status (FR-4)", () => {
    assert.equal(releaseJob?.permissions?.statuses, "read");
    // Existing release scopes must remain intact (explicit block → others none).
    assert.equal(releaseJob?.permissions?.contents, "write");
  });

  test("creates the versioned release targeting the exact validated SHA (AC-2)", () => {
    // Scope the assertion to the release-creation step's own `run` — a whole-file
    // match would also be satisfied by the identical `--target` literal in the
    // updater-feed promotion step, so a regression of THIS step's target to a
    // floating ref would slip through.
    const releaseStep = steps.find(
      (step) => step.name === RELEASE_CREATE_STEP_NAME
    );
    assert.ok(
      releaseStep,
      `release job must have a "${RELEASE_CREATE_STEP_NAME}" step`
    );
    assert.match(releaseStep.run ?? "", RELEASE_TARGET_PATTERN);
  });
});

const PRECHECK_RUN_PATTERN =
  /pnpm exec tsx scripts\/deploy\/desktop-release-precheck\.ts/;
const SLACK_NOTIFY_ACTION_PATTERN = /\.github\/actions\/symphony-slack-notify/;
const REPO_WEBHOOK_PATTERN = /secrets\.SLACK_GITHUB_REPO_WEBHOOK_URL/;
const SLACK_POST_RUN_PATTERN = /pnpm exec tsx scripts\/deploy\/slack-post\.ts/;
const PROCEED_OUTPUT_PATTERN = /steps\.releasability\.outputs\.proceed/;
const RELEASE_PROCEED_GATE_PATTERN =
  /needs\.precheck\.outputs\.proceed == 'true'/;
const DRY_RUN_GATE_PATTERN = /inputs\.dry_run\s*!=\s*true/;

describe("desktop release workflow — Slack-triggered releasability pre-check (FEA-1941)", () => {
  const precheckJob = workflow.jobs?.precheck;
  const precheckSteps = precheckJob?.steps ?? [];

  test("accepts the optional Slack-context inputs (AC-1 / AC-6)", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    for (const key of [
      "slack_channel_id",
      "slack_thread_ts",
      "slack_requester_id",
      "dry_run",
    ]) {
      assert.ok(
        Object.hasOwn(inputs, key),
        `workflow_dispatch must declare the "${key}" input`
      );
    }
    // Optional so a bare manual dispatch (no bot) still runs — AC-6.
    assert.notEqual(inputs.slack_channel_id?.required, true);
    assert.notEqual(inputs.slack_thread_ts?.required, true);
    assert.equal(inputs.dry_run?.type, "boolean");
  });

  test("has a cheap ubuntu precheck job that reads the validated status", () => {
    assert.ok(precheckJob, "workflow must define a precheck job");
    assert.equal(precheckJob["runs-on"], "ubuntu-latest");
    // The status read needs statuses:read; an explicit block defaults the rest
    // to none, so the read would 403 without it.
    assert.equal(precheckJob.permissions?.statuses, "read");
    const precheckStep = precheckSteps.find((step) =>
      PRECHECK_RUN_PATTERN.test(step.run ?? "")
    );
    assert.ok(precheckStep, "precheck job must run the precheck script");
    // Assert THIS step's parsed env, not a whole-source match — WORKFLOW_SOURCE
    // also contains the release job's TARGET_SHA, so a global match would pass
    // even if the precheck step's wiring regressed. The pre-check gates on the
    // version's canonical commit (RELEASE_SHA), matching the release preflight.
    assert.equal(precheckStep.env?.TARGET_SHA, RELEASE_SHA_EXPRESSION);
  });

  test("the precheck job emits a proceed output the release job gates on", () => {
    assert.match(precheckJob?.outputs?.proceed ?? "", PROCEED_OUTPUT_PATTERN);
    assert.equal(releaseJob?.needs, "precheck");
    assert.match(releaseJob?.if ?? "", RELEASE_PROCEED_GATE_PATTERN);
    // The dry_run clause is the only thing stopping a rehearsal from triggering
    // a real macOS build/sign/publish — assert it explicitly (the proceed
    // substring match above would pass even if this clause were dropped).
    assert.match(releaseJob?.if ?? "", DRY_RUN_GATE_PATTERN);
  });

  test("the preflight gate is still present in the release job (defense-in-depth, AC-6)", () => {
    // The pre-check is UX; FEA-1936's preflight remains the in-workflow hard
    // gate. A regression that drops it must fail here as well as the FR-4 suite.
    const preflight = steps.find((step) =>
      PREFLIGHT_RUN_PATTERN.test(step.run ?? "")
    );
    assert.ok(preflight, "release job must keep the preflight gate");
  });

  test("a mid-release failure reports loudly to the main channel (AC-5)", () => {
    const loudFailure = steps.find(
      (step) =>
        (step.if ?? "").includes("failure()") &&
        SLACK_NOTIFY_ACTION_PATTERN.test(step.uses ?? "")
    );
    assert.ok(
      loudFailure,
      "release job must post a failure() notification via symphony-slack-notify"
    );
    assert.match(loudFailure.with?.webhook_url ?? "", REPO_WEBHOOK_PATTERN);
  });

  test("release success is reported back into the originating thread (AC-2)", () => {
    const successPost = steps.find(
      (step) =>
        (step.if ?? "").includes("success()") &&
        (step.if ?? "").includes("inputs.slack_thread_ts") &&
        SLACK_POST_RUN_PATTERN.test(step.run ?? "")
    );
    assert.ok(
      successPost,
      "release job must post success into the Slack thread when present"
    );
  });
});
