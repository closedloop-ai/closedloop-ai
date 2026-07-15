import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveOpenablePlanFilePath } from "../src/main/plans/safe-plan-file.js";

// OPEN_PATH_UNVALIDATED guardrail. `desktop:db:open-plan` hands a store-derived
// path to `shell.openPath`, which delegates to the OS file association — so a
// `.command`/`.app`/script row would be executed. resolveOpenablePlanFilePath
// must only return paths that are real files inside the agent homes
// (~/.claude, ~/.cursor) carrying a non-executable, allowlisted extension.
describe("resolveOpenablePlanFilePath", () => {
  let claudeHome: string;
  let cursorHome: string;
  let outsideDir: string;
  let prevClaudeHome: string | undefined;
  let prevCursorHome: string | undefined;

  before(() => {
    const root = mkdtempSync(path.join(tmpdir(), "safe-plan-file-"));
    claudeHome = path.join(root, ".claude");
    cursorHome = path.join(root, ".cursor");
    outsideDir = path.join(root, "outside");
    mkdirSync(path.join(claudeHome, "plans"), { recursive: true });
    mkdirSync(path.join(cursorHome, "projects"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    prevClaudeHome = process.env.CLAUDE_HOME;
    prevCursorHome = process.env.CURSOR_HOME;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CURSOR_HOME = cursorHome;
  });

  after(() => {
    if (prevClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = prevClaudeHome;
    }
    if (prevCursorHome === undefined) {
      delete process.env.CURSOR_HOME;
    } else {
      process.env.CURSOR_HOME = prevCursorHome;
    }
  });

  test("accepts a markdown plan inside the Claude home", () => {
    const fp = path.join(claudeHome, "plans", "my-plan.md");
    writeFileSync(fp, "# plan");
    assert.equal(resolveOpenablePlanFilePath(fp), realpathSync(fp));
  });

  test("accepts a jsonl transcript inside the Cursor home", () => {
    const fp = path.join(cursorHome, "projects", "session.jsonl");
    writeFileSync(fp, "{}");
    assert.equal(resolveOpenablePlanFilePath(fp), realpathSync(fp));
  });

  test("rejects an executable extension even inside an allowed root", () => {
    const fp = path.join(claudeHome, "plans", "evil.command");
    writeFileSync(fp, "#!/bin/sh\nopen -a Calculator\n");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
  });

  test("rejects a path outside the allowed roots", () => {
    const fp = path.join(outsideDir, "loot.md");
    writeFileSync(fp, "# nope");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
  });

  test("rejects a traversal escape out of an allowed root", () => {
    const fp = path.join(claudeHome, "plans", "..", "..", "outside", "loot.md");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
  });

  test("accepts a file under a caller-supplied extra root", () => {
    const fp = path.join(outsideDir, "extra.md");
    writeFileSync(fp, "# extra");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
    assert.equal(
      resolveOpenablePlanFilePath(fp, [outsideDir]),
      realpathSync(fp)
    );
  });

  test("rejects a non-existent file", () => {
    assert.equal(
      resolveOpenablePlanFilePath(path.join(claudeHome, "plans", "ghost.md")),
      null
    );
  });
});
