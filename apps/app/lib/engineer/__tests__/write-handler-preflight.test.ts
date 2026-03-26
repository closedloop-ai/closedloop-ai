/**
 * Tests for the shared checkLegacyProcessAndMigrate helper.
 *
 * This helper is used by write routes (upload, chat, deploy, etc.) to:
 *   1. If .closedloop-ai/work already exists -> "nothing-to-migrate".
 *   2. If only .claude/work exists AND a live process is running -> "live-process-blocking".
 *   3. If only .claude/work exists AND no live process -> migrate, return "migrated".
 *   4. If neither exists -> "nothing-to-migrate".
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLegacyProcessAndMigrate } from "@/lib/engineer/process-utils";

describe("checkLegacyProcessAndMigrate", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "write-preflight-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns nothing-to-migrate when .closedloop-ai/work already exists", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(join(newWorkDir, "state.json"), '{"status":"IN_PROGRESS"}');

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("nothing-to-migrate");
    expect(existsSync(newWorkDir)).toBe(true);
  });

  it("returns live-process-blocking when live process is running from .claude/work", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    // Write own PID (guaranteed to be alive)
    writeFileSync(join(oldWorkDir, "process.pid"), String(process.pid));

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
    // Old dir must NOT have been renamed
    expect(existsSync(oldWorkDir)).toBe(true);
    expect(existsSync(join(testDir, ".closedloop-ai", "work"))).toBe(false);
  });

  it("returns migrated when process is dead", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    writeFileSync(join(oldWorkDir, "process.pid"), "999999999");
    writeFileSync(join(oldWorkDir, "state.json"), '{"status":"STOPPED"}');

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("migrated");
    expect(existsSync(oldWorkDir)).toBe(false);
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    expect(existsSync(newWorkDir)).toBe(true);
    expect(existsSync(join(newWorkDir, "state.json"))).toBe(true);
  });

  it("returns nothing-to-migrate when no work directory exists", () => {
    const result = checkLegacyProcessAndMigrate(testDir);
    expect(result).toBe("nothing-to-migrate");
  });

  it("migrates when .claude/work exists with no PID file", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    writeFileSync(
      join(oldWorkDir, "launch-metadata.json"),
      '{"baseBranch":"main"}'
    );

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("migrated");
    expect(existsSync(oldWorkDir)).toBe(false);
    expect(
      existsSync(
        join(testDir, ".closedloop-ai", "work", "launch-metadata.json")
      )
    ).toBe(true);
  });

  it("returns live-process-blocking when legacy codex review PID is alive", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    // No process.pid, but codex review PID exists and is alive
    writeFileSync(
      join(oldWorkDir, "codex-review-codex.pid"),
      String(process.pid)
    );

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
    // Old dir NOT renamed
    expect(existsSync(oldWorkDir)).toBe(true);
    expect(existsSync(join(testDir, ".closedloop-ai", "work"))).toBe(false);
  });

  it("migrates when legacy codex review PID is dead", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    writeFileSync(join(oldWorkDir, "codex-review-claude.pid"), "999999999");
    writeFileSync(
      join(oldWorkDir, "codex-review-claude.json"),
      JSON.stringify({ status: "completed" })
    );

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("migrated");
    expect(existsSync(oldWorkDir)).toBe(false);
    expect(
      existsSync(
        join(testDir, ".closedloop-ai", "work", "codex-review-claude.json")
      )
    ).toBe(true);
  });
});

describe("transcript migration removes legacy copy", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "transcript-migrate-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("legacy transcript is deleted after copy to new path", () => {
    const { copyFileSync, unlinkSync } = require("node:fs");
    const oldWork = join(testDir, ".claude", "work");
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(newWork, { recursive: true });

    const legacyPath = join(oldWork, "chat-history.json");
    const newPath = join(newWork, "chat-history.json");
    writeFileSync(legacyPath, JSON.stringify({ messages: [{ role: "user" }] }));

    // Simulate the migration pattern used in chat routes
    if (!existsSync(newPath) && existsSync(legacyPath)) {
      copyFileSync(legacyPath, newPath);
      try {
        unlinkSync(legacyPath);
      } catch {
        /* best effort */
      }
    }

    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
  });
});
