/**
 * @file trusted-transcript-path.test.ts
 * @description FEA-2808. The transcript hook endpoint is unauthenticated
 * localhost, so its path drives a raw byte upload of whatever it resolves to.
 * resolveTrustedClaudeTranscriptPath must anchor on the REAL (realpath-resolved)
 * location, so a `.jsonl` symlink placed under ~/.claude/projects that points at
 * an out-of-root secret (e.g. ~/.ssh/id_rsa) is rejected — string-prefix
 * normalization alone would have accepted it. It returns the resolved real path
 * (never the original symlink) so the caller uploads the vetted target.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveTrustedClaudeTranscriptPath } from "../src/main/transcript-sync/trusted-transcript-path.js";

describe("resolveTrustedClaudeTranscriptPath", () => {
  let root: string;
  let claudeHome: string;
  let projectsRoot: string;
  let outsideDir: string;
  let prevClaudeHome: string | undefined;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "trusted-transcript-"));
    claudeHome = path.join(root, ".claude");
    projectsRoot = path.join(claudeHome, "projects");
    outsideDir = path.join(root, "outside");
    mkdirSync(path.join(projectsRoot, "some-project"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    prevClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = claudeHome;
  });

  after(() => {
    if (prevClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = prevClaudeHome;
    }
  });

  test("accepts a real .jsonl transcript inside the projects root", () => {
    const fp = path.join(projectsRoot, "some-project", "session.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });

  test("rejects a real file outside the projects root", () => {
    const fp = path.join(outsideDir, "session.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), null);
  });

  test("rejects a non-.jsonl file inside the projects root", () => {
    const fp = path.join(projectsRoot, "some-project", "notes.txt");
    writeFileSync(fp, "hello");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), null);
  });

  test("rejects a .jsonl symlink escaping the projects root (exfil guard)", () => {
    const secret = path.join(outsideDir, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    const link = path.join(projectsRoot, "some-project", "leak.jsonl");
    symlinkSync(secret, link);
    // The anchor must follow the symlink: its real target is out-of-root.
    assert.equal(resolveTrustedClaudeTranscriptPath(link), null);
  });

  test("resolves a symlink whose real target stays inside the root to that target", () => {
    const realFp = path.join(projectsRoot, "some-project", "real.jsonl");
    writeFileSync(realFp, "{}\n");
    const link = path.join(projectsRoot, "some-project", "alias.jsonl");
    symlinkSync(realFp, link);
    // Returns the resolved target, NOT the symlink — the caller uploads the
    // vetted path so the link can't be repointed between check and read.
    assert.equal(
      resolveTrustedClaudeTranscriptPath(link),
      realpathSync(realFp)
    );
  });

  test("rejects a nonexistent path", () => {
    const fp = path.join(projectsRoot, "some-project", "missing.jsonl");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), null);
  });

  test("rejects a directory even with a .jsonl suffix", () => {
    const dir = path.join(projectsRoot, "some-project", "dir.jsonl");
    mkdirSync(dir);
    assert.equal(resolveTrustedClaudeTranscriptPath(dir), null);
  });

  test("anchors on the real projects root when the root itself is symlinked", () => {
    // realpath the ROOT too: if ~/.claude/projects is itself a symlink, a real
    // transcript under its target must still be accepted.
    const realProjects = realpathSync(projectsRoot);
    const fp = path.join(realProjects, "some-project", "canonical.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });
});
