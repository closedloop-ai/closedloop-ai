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
  "desktop-packaging-validation.yml"
);

const COMMENT_LINE_PATTERN = /^\s*#/;
const PENDING_STATUS_PATTERN = /state=pending/;
const FINAL_STATUS_PATTERN = /state=\$\{STATE\}/;
const STATUS_ENDPOINT_PATTERN =
  /repos\/\$\{\{ github\.repository \}\}\/statuses\/\$\{\{ github\.sha \}\}/;
const PACKAGE_COMMAND_PATTERN = /pnpm turbo package:turbo --filter=desktop/;
const SKIP_SIGNING_PATTERN = /CSC_IDENTITY_AUTO_DISCOVERY: "false"/;
const APPLE_SECRET_PATTERN = /APPLE_/;
const CSC_LINK_PATTERN = /CSC_LINK/;
const CSC_KEY_PASSWORD_PATTERN = /CSC_KEY_PASSWORD/;
const GH_RELEASE_PATTERN = /gh release/;
const DESKTOP_LATEST_PATTERN = /desktop-latest/;
// Other publish mechanisms FR-5 must also exclude: third-party release actions,
// the GitHub Releases REST API, release-asset uploads, and electron-builder's own
// publish flags (which would write latest-mac.yml to the configured feed).
const PUBLISH_ACTION_PATTERN =
  /softprops\/action-gh-release|ncipollo\/release-action|upload-release-asset/;
const RELEASES_API_PATTERN = /\/releases\b/;
const ELECTRON_PUBLISH_PATTERN = /--publish\b|EP_PUBLISH/;
const SLACK_ACTION_PATTERN = /symphony-slack-notify/;
const NOT_RELEASABLE_PATTERN = /main is not releasable/;
const REPORT_STEP_NAME = "Report packaging status";
const ALWAYS_GATED_PATTERN = /^always\(\)/;
const FAILURE_BRANCH_PATTERN = /STATE="failure"/;

const WORKFLOW_SOURCE = fs.readFileSync(WORKFLOW_PATH, "utf8");
// Executable lines only (drops `#` comment lines, including the file header that
// legitimately mentions `gh release` / `desktop-latest` when explaining the FR-5
// prohibition). The FR-5 guard asserts no real publish *operation* exists.
const WORKFLOW_EXECUTABLE = WORKFLOW_SOURCE.split("\n")
  .filter((line) => !COMMENT_LINE_PATTERN.test(line))
  .join("\n");
type WorkflowStep = { name?: string; if?: string };
const workflow = parse(WORKFLOW_SOURCE) as {
  on?: { push?: { branches?: string[]; paths?: string[] } };
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs?: Record<string, { "runs-on"?: string; steps?: WorkflowStep[] }>;
};

describe("desktop packaging validation workflow", () => {
  test("triggers only on push to main (never workflow_dispatch or pull_request)", () => {
    const on = workflow.on as Record<string, unknown> | undefined;
    assert.ok(on, "workflow must declare triggers");
    assert.deepEqual(Object.keys(on), ["push"]);
    assert.deepEqual(workflow.on?.push?.branches, ["main"]);
  });

  test("has no path filter so every main SHA gets a validation verdict", () => {
    assert.equal(
      workflow.on?.push?.paths,
      undefined,
      "Release Desktop gates on the exact current main SHA, so every main push must produce a desktop-packaging/validated status"
    );
  });

  test("grants statuses:write and posts the desktop-packaging/validated status (AC-2)", () => {
    assert.equal(workflow.permissions?.statuses, "write");
    assert.equal(workflow.permissions?.contents, "read");
    assert.equal(
      workflow.env?.PACKAGING_STATUS_CONTEXT,
      "desktop-packaging/validated"
    );
    // pending at start + a final success/failure verdict on the merge SHA.
    assert.match(WORKFLOW_SOURCE, PENDING_STATUS_PATTERN);
    assert.match(WORKFLOW_SOURCE, FINAL_STATUS_PATTERN);
    assert.match(WORKFLOW_SOURCE, STATUS_ENDPOINT_PATTERN);
  });

  test("posts a failure status on a red run — report step is always()-gated (AC-2)", () => {
    // The guarantee that a FAILED packaging run still records `failure` (rather
    // than skipping silently) is the `if: always()` gate on the report step plus
    // the STATE="failure" branch. Dropping `always()` would silently stop failure
    // reporting and break the downstream FEA-1936/FEA-1941 consumers while the
    // string-presence assertions above stayed green — so pin it structurally.
    const steps = workflow.jobs?.["validate-packaging"]?.steps ?? [];
    const reportStep = steps.find((step) => step.name === REPORT_STEP_NAME);
    assert.ok(reportStep, `workflow must have a "${REPORT_STEP_NAME}" step`);
    assert.match(reportStep.if ?? "", ALWAYS_GATED_PATTERN);
    assert.match(WORKFLOW_SOURCE, FAILURE_BRANCH_PATTERN);
  });

  test("runs the full packaging path on macOS", () => {
    assert.equal(
      workflow.jobs?.["validate-packaging"]?.["runs-on"],
      "macos-latest"
    );
    assert.match(WORKFLOW_SOURCE, PACKAGE_COMMAND_PATTERN);
  });

  test("is an unsigned validation build — never wires Apple signing secrets", () => {
    // Signing/notarization stays release-only (PRD-470 D-001); the validation run
    // must stay deterministic and free of org signing secrets.
    assert.match(WORKFLOW_EXECUTABLE, SKIP_SIGNING_PATTERN);
    assert.doesNotMatch(WORKFLOW_EXECUTABLE, APPLE_SECRET_PATTERN);
    assert.doesNotMatch(WORKFLOW_EXECUTABLE, CSC_LINK_PATTERN);
    assert.doesNotMatch(WORKFLOW_EXECUTABLE, CSC_KEY_PASSWORD_PATTERN);
  });

  test("never publishes to the desktop-latest updater feed (FR-5 / AC-3)", () => {
    // FR-5: per-merge validation must never touch the customer updater channel.
    assert.doesNotMatch(
      WORKFLOW_EXECUTABLE,
      GH_RELEASE_PATTERN,
      "validation workflow must not create/edit/upload any GitHub release"
    );
    assert.doesNotMatch(
      WORKFLOW_EXECUTABLE,
      DESKTOP_LATEST_PATTERN,
      "validation workflow must not touch the desktop-latest feed"
    );
    // The denylist above only catches `gh release` / `desktop-latest`; also reject
    // the other ways a workflow can publish a customer build.
    assert.doesNotMatch(
      WORKFLOW_EXECUTABLE,
      PUBLISH_ACTION_PATTERN,
      "validation workflow must not use a release-publishing action"
    );
    assert.doesNotMatch(
      WORKFLOW_EXECUTABLE,
      RELEASES_API_PATTERN,
      "validation workflow must not call the GitHub Releases API"
    );
    assert.doesNotMatch(
      WORKFLOW_EXECUTABLE,
      ELECTRON_PUBLISH_PATTERN,
      "validation workflow must not let electron-builder publish (no --publish / EP_PUBLISH)"
    );
  });

  test("surfaces a red run via Slack as 'main is not releasable' (AC-1)", () => {
    assert.match(WORKFLOW_SOURCE, SLACK_ACTION_PATTERN);
    assert.match(WORKFLOW_SOURCE, NOT_RELEASABLE_PATTERN);
  });
});
