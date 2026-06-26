import assert from "node:assert/strict";
import { test } from "node:test";
import { FORCE_INTERACTIVE_OPERATIONS } from "../src/main/approval-policy.js";
import {
  buildUpdateAndRestartDisabledResult,
  canApplyPackagedUpdate,
  resolvePackagedUpdateCheckResult,
  shouldHonorAlwaysAllowRule,
} from "../src/main/update-and-restart-helpers.js";

test("disabled update_and_restart approval result returns 501 feature_disabled", () => {
  assert.deepEqual(buildUpdateAndRestartDisabledResult(), {
    allow: false,
    statusCode: 501,
    payload: {
      error: "feature_disabled",
      feature: "update_and_restart",
    },
  });
});

test("force-interactive operations ignore always-allow rules", () => {
  assert.equal(
    shouldHonorAlwaysAllowRule(
      "update_and_restart",
      FORCE_INTERACTIVE_OPERATIONS as ReadonlySet<string>
    ),
    false
  );
  assert.equal(
    shouldHonorAlwaysAllowRule(
      "health_check",
      FORCE_INTERACTIVE_OPERATIONS as ReadonlySet<string>
    ),
    true
  );
});

test("packaged update can only apply after the payload is downloaded", () => {
  assert.equal(
    canApplyPackagedUpdate("1.0.0", {
      status: "available",
      available: true,
      downloaded: false,
      version: "1.0.1",
    }),
    false
  );
  assert.equal(
    canApplyPackagedUpdate("1.0.0", {
      status: "downloaded",
      available: true,
      downloaded: true,
      version: "1.0.1",
    }),
    true
  );
});

test("packaged update gateway check reports true only when the download is ready", () => {
  assert.deepEqual(
    resolvePackagedUpdateCheckResult(
      "1.0.0",
      {
        status: "available",
        available: true,
        downloaded: false,
        version: "1.0.1",
      },
      "1.0.1"
    ),
    {
      updateAvailable: false,
      version: "1.0.1",
    }
  );
  assert.deepEqual(
    resolvePackagedUpdateCheckResult(
      "1.0.0",
      {
        status: "downloaded",
        available: true,
        downloaded: true,
        version: "1.0.1",
      },
      "1.0.1"
    ),
    {
      updateAvailable: true,
      version: "1.0.1",
    }
  );
});
