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
import {
  isPendingTrustedTranscriptPath,
  resolveTrustedClaudeTranscriptPath,
  setMaterializedOpencodeTranscriptRoot,
} from "../src/main/transcript-sync/trusted-transcript-path.js";

describe("resolveTrustedClaudeTranscriptPath", () => {
  let root: string;
  let claudeHome: string;
  let projectsRoot: string;
  let codexHome: string;
  let codexSessionsRoot: string;
  let codexArchivedRoot: string;
  let outsideDir: string;
  let prevClaudeHome: string | undefined;
  let prevCodexHome: string | undefined;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "trusted-transcript-"));
    claudeHome = path.join(root, ".claude");
    projectsRoot = path.join(claudeHome, "projects");
    codexHome = path.join(root, ".codex");
    codexSessionsRoot = path.join(codexHome, "sessions");
    codexArchivedRoot = path.join(codexHome, "archived_sessions");
    outsideDir = path.join(root, "outside");
    mkdirSync(path.join(projectsRoot, "some-project"), { recursive: true });
    // Codex nests by date; mirror a realistic sessions/YYYY/MM/DD layout.
    mkdirSync(path.join(codexSessionsRoot, "2026", "07", "17"), {
      recursive: true,
    });
    mkdirSync(codexArchivedRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    prevClaudeHome = process.env.CLAUDE_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CODEX_HOME = codexHome;
  });

  after(() => {
    if (prevClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = prevClaudeHome;
    }
    if (prevCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevCodexHome;
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

  test("accepts a real Codex rollout .jsonl inside the sessions root", () => {
    // Codex sessions are cloud-parseable, so a Codex rollout file whose cloud
    // read fails must be accepted for the local fallback (the Claude-only guard
    // would have refused it and always shown the cloud error).
    const fp = path.join(
      codexSessionsRoot,
      "2026",
      "07",
      "17",
      "rollout-2026-07-17T00-00-00-00000000-0000-0000-0000-000000000000.jsonl"
    );
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });

  test("accepts a real Codex rollout .jsonl inside the archived-sessions root", () => {
    const fp = path.join(codexArchivedRoot, "archived.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });

  test("rejects a .jsonl symlink under a Codex root escaping to an out-of-root secret", () => {
    const secret = path.join(outsideDir, "codex-id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    const link = path.join(codexSessionsRoot, "leak.jsonl");
    symlinkSync(secret, link);
    assert.equal(resolveTrustedClaudeTranscriptPath(link), null);
  });

  test("anchors on the real projects root when the root itself is symlinked", () => {
    // realpath the ROOT too: if ~/.claude/projects is itself a symlink, a real
    // transcript under its target must still be accepted.
    const realProjects = realpathSync(projectsRoot);
    const fp = path.join(realProjects, "some-project", "canonical.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });

  // FEA-3464: Claude Code fires the transcript hook at SessionStart / the first
  // UserPromptSubmit BEFORE the `<uuid>.jsonl` is flushed, so the anchor's ENOENT
  // path rejects a benign race. `isPendingTrustedTranscriptPath` separates that
  // race (skip silently / retry) from a genuinely out-of-root path (log + reject)
  // WITHOUT loosening the anchor — a pending path is never uploaded.
  test("treats a not-yet-created .jsonl under the projects root as pending", () => {
    const fp = path.join(projectsRoot, "some-project", "not-yet.jsonl");
    // Precondition: the anchor rejects it (file absent) — this is the race.
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), null);
    assert.equal(isPendingTrustedTranscriptPath(fp), true);
  });

  test("treats a not-yet-created Codex rollout under the sessions root as pending", () => {
    const fp = path.join(
      codexSessionsRoot,
      "2026",
      "07",
      "17",
      "rollout-not-yet.jsonl"
    );
    assert.equal(isPendingTrustedTranscriptPath(fp), true);
  });

  test("does NOT treat a not-yet-created path outside every root as pending", () => {
    const fp = path.join(outsideDir, "ghost.jsonl");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), null);
    assert.equal(isPendingTrustedTranscriptPath(fp), false);
  });

  test("does NOT treat an already-flushed trusted file as pending", () => {
    const fp = path.join(projectsRoot, "some-project", "already.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(isPendingTrustedTranscriptPath(fp), false);
  });

  test("does NOT treat an existing escaping symlink as pending (exfil guard)", () => {
    // A symlink that exists but escapes the root is a REAL rejection, not a
    // not-yet-created race: it must be logged, never silently skipped/retried.
    const secret = path.join(outsideDir, "pending-id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    const link = path.join(projectsRoot, "some-project", "pending-leak.jsonl");
    symlinkSync(secret, link);
    assert.equal(resolveTrustedClaudeTranscriptPath(link), null);
    assert.equal(isPendingTrustedTranscriptPath(link), false);
  });

  test("does NOT treat a non-.jsonl absent candidate as pending", () => {
    const fp = path.join(projectsRoot, "some-project", "not-yet.txt");
    assert.equal(isPendingTrustedTranscriptPath(fp), false);
  });
});

// FEA-3932: the materialized OpenCode root is registered at service construction
// (a runtime state-dir path) and vetted with the SAME realpath + `.jsonl` +
// isFile + containment guard as the Claude/Codex roots — never a string-prefix
// check. A symlink escaping the materialized root is still rejected.
describe("resolveTrustedClaudeTranscriptPath with materialized OpenCode root", () => {
  let root: string;
  let materializedRoot: string;
  let outsideDir: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "trusted-opencode-"));
    materializedRoot = path.join(root, "transcript-materialized", "opencode");
    outsideDir = path.join(root, "outside");
    mkdirSync(path.join(materializedRoot, "opencode-1"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    setMaterializedOpencodeTranscriptRoot(materializedRoot);
  });

  after(() => {
    // Clear the module-level root so later suites see the default (Claude/Codex).
    setMaterializedOpencodeTranscriptRoot(null);
  });

  test("accepts a real .jsonl under the materialized OpenCode root", () => {
    const fp = path.join(materializedRoot, "opencode-1", "main.jsonl");
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });

  test("accepts a subagent .jsonl under the materialized OpenCode root", () => {
    const fp = path.join(
      materializedRoot,
      "opencode-1",
      "subagent:child.jsonl"
    );
    writeFileSync(fp, "{}\n");
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), realpathSync(fp));
  });

  test("rejects a .jsonl symlink under the materialized root escaping to a secret", () => {
    const secret = path.join(outsideDir, "opencode-id_rsa");
    writeFileSync(secret, "PRIVATE KEY");
    const link = path.join(materializedRoot, "opencode-1", "leak.jsonl");
    symlinkSync(secret, link);
    assert.equal(resolveTrustedClaudeTranscriptPath(link), null);
  });

  test("rejects a materialized-root path once the root is cleared", () => {
    const fp = path.join(materializedRoot, "opencode-1", "cleared.jsonl");
    writeFileSync(fp, "{}\n");
    setMaterializedOpencodeTranscriptRoot(null);
    assert.equal(resolveTrustedClaudeTranscriptPath(fp), null);
    // Restore for any remaining assertions in this block.
    setMaterializedOpencodeTranscriptRoot(materializedRoot);
  });
});
