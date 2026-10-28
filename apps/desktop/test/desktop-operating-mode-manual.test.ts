import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { HARNESS_HOME_ENV_KEYS } from "./helpers/isolated-harness-homes.js";
import {
  cleanupCommand,
  cleanupDesktopOperatingModeRun,
  createDesktopOperatingModeRun,
  validateCleanupTarget,
  validateIsolatedHarnessHomes,
} from "./manual/desktop-operating-mode-root.js";

const CLEANUP_COMMAND_RE = /--cleanup '/;
const SENTINEL_FAILURE_RE = /sentinel|ENOENT/;
const UNOWNED_ROOT_RE = /not an owned harness root/;
const HOME_ISOLATION_FAILURE_RE = /collector home isolation failed/;

describe("ISS-10574 disposable manual harness root", () => {
  test("creates all collector homes and cleans only its exact sentinel root", () => {
    const run = createDesktopOperatingModeRun();
    try {
      assert.equal(validateCleanupTarget(run.root, run.runId), run.root);
      for (const key of HARNESS_HOME_ENV_KEYS) {
        assert.ok(run.homes[key]);
        assert.ok(fs.existsSync(run.homes[key]));
        assert.equal(
          path.relative(run.root, run.homes[key]).startsWith(".."),
          false
        );
      }
      assert.match(cleanupCommand(run.root, run.runId), CLEANUP_COMMAND_RE);
    } finally {
      cleanupDesktopOperatingModeRun(run.root, run.runId);
    }
    assert.equal(fs.existsSync(run.root), false);
  });

  test("refuses a sentinel-less sibling and the temp root", () => {
    const sibling = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-10574-unowned-")
    );
    try {
      assert.throws(
        () => validateCleanupTarget(sibling, "not-owned"),
        SENTINEL_FAILURE_RE
      );
      assert.throws(
        () => validateCleanupTarget(os.tmpdir(), "not-owned"),
        UNOWNED_ROOT_RE
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("refuses a symlink even when it points at an owned root", () => {
    const run = createDesktopOperatingModeRun();
    const link = path.join(os.tmpdir(), `iss-10574-link-${process.pid}`);
    try {
      fs.symlinkSync(run.root, link);
      assert.throws(
        () => validateCleanupTarget(link, run.runId),
        UNOWNED_ROOT_RE
      );
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      cleanupDesktopOperatingModeRun(run.root, run.runId);
    }
  });

  test("refuses a forged self-naming sentinel without the run id", () => {
    const run = createDesktopOperatingModeRun();
    try {
      assert.throws(
        () => validateCleanupTarget(run.root, "forged-run-id"),
        SENTINEL_FAILURE_RE
      );
    } finally {
      cleanupDesktopOperatingModeRun(run.root, run.runId);
    }
  });

  test("refuses blank, missing, and outside-root collector homes", () => {
    const run = createDesktopOperatingModeRun();
    const key = HARNESS_HOME_ENV_KEYS[0];
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-10574-outside-")
    );
    try {
      assert.ok(key);
      assert.throws(
        () =>
          validateIsolatedHarnessHomes(run.root, { ...run.homes, [key]: "" }),
        HOME_ISOLATION_FAILURE_RE
      );
      const missing = { ...run.homes };
      delete missing[key];
      assert.throws(
        () => validateIsolatedHarnessHomes(run.root, missing),
        HOME_ISOLATION_FAILURE_RE
      );
      assert.throws(
        () =>
          validateIsolatedHarnessHomes(run.root, {
            ...run.homes,
            [key]: outside,
          }),
        HOME_ISOLATION_FAILURE_RE
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      cleanupDesktopOperatingModeRun(run.root, run.runId);
    }
  });
});
