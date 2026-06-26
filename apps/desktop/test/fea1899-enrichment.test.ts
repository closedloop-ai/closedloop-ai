import assert from "node:assert/strict";
import { test } from "node:test";
import { sumCommitStats } from "../src/main/enrichment/git-enrichment.js";
import {
  normalizeRepoFullName,
  parseShortstat,
  validateSha,
} from "../src/main/enrichment/git-exec.js";
import { pickBestLoc } from "../src/main/enrichment/rollup.js";
import type { LocStats } from "../src/main/enrichment/types.js";

// ---------------------------------------------------------------------------
// validateSha
// ---------------------------------------------------------------------------

test("validateSha: accepts 7-char short SHA", () => {
  assert.equal(validateSha("abc1234"), true);
});

test("validateSha: accepts 40-char full SHA", () => {
  assert.equal(validateSha("a".repeat(40)), true);
});

test("validateSha: accepts mixed hex digits", () => {
  assert.equal(validateSha("0123456789abcdef0123456789abcdef01234567"), true);
});

test("validateSha: rejects 6-char SHA (too short)", () => {
  assert.equal(validateSha("abc123"), false);
});

test("validateSha: rejects 41-char SHA (too long)", () => {
  assert.equal(validateSha("a".repeat(41)), false);
});

test("validateSha: rejects uppercase hex", () => {
  assert.equal(validateSha("ABCDEF1234567"), false);
});

test("validateSha: rejects non-hex characters", () => {
  assert.equal(validateSha("zzzzzzzzzzzzzz"), false);
});

test("validateSha: rejects empty string", () => {
  assert.equal(validateSha(""), false);
});

test("validateSha: rejects SHA with leading dash", () => {
  assert.equal(validateSha("-abc1234"), false);
});

// ---------------------------------------------------------------------------
// parseShortstat
// ---------------------------------------------------------------------------

test("parseShortstat: standard with insertions and deletions", () => {
  assert.deepEqual(
    parseShortstat(" 3 files changed, 10 insertions(+), 5 deletions(-)"),
    { filesChanged: 3, linesAdded: 10, linesRemoved: 5 }
  );
});

test("parseShortstat: insertions only (no deletions)", () => {
  assert.deepEqual(parseShortstat(" 1 file changed, 4 insertions(+)"), {
    filesChanged: 1,
    linesAdded: 4,
    linesRemoved: 0,
  });
});

test("parseShortstat: deletions only (no insertions)", () => {
  assert.deepEqual(parseShortstat(" 2 files changed, 3 deletions(-)"), {
    filesChanged: 2,
    linesAdded: 0,
    linesRemoved: 3,
  });
});

test("parseShortstat: single file changed with counts", () => {
  assert.deepEqual(
    parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)"),
    { filesChanged: 1, linesAdded: 1, linesRemoved: 1 }
  );
});

test("parseShortstat: returns null for empty string", () => {
  assert.equal(parseShortstat(""), null);
});

test("parseShortstat: returns null for unrelated output", () => {
  assert.equal(parseShortstat("nothing here"), null);
});

test("parseShortstat: handles output with trailing newline", () => {
  assert.deepEqual(
    parseShortstat(" 5 files changed, 20 insertions(+), 2 deletions(-)\n"),
    { filesChanged: 5, linesAdded: 20, linesRemoved: 2 }
  );
});

test("parseShortstat: large numbers", () => {
  assert.deepEqual(
    parseShortstat(" 100 files changed, 9999 insertions(+), 8888 deletions(-)"),
    { filesChanged: 100, linesAdded: 9999, linesRemoved: 8888 }
  );
});

// ---------------------------------------------------------------------------
// normalizeRepoFullName
// ---------------------------------------------------------------------------

test("normalizeRepoFullName: SSH URL with .git suffix", () => {
  assert.equal(
    normalizeRepoFullName("git@github.com:org/repo.git"),
    "org/repo"
  );
});

test("normalizeRepoFullName: SSH URL without .git suffix", () => {
  assert.equal(normalizeRepoFullName("git@github.com:org/repo"), "org/repo");
});

test("normalizeRepoFullName: HTTPS URL with .git suffix", () => {
  assert.equal(
    normalizeRepoFullName("https://github.com/org/repo.git"),
    "org/repo"
  );
});

test("normalizeRepoFullName: HTTPS URL without .git suffix", () => {
  assert.equal(
    normalizeRepoFullName("https://github.com/org/repo"),
    "org/repo"
  );
});

test("normalizeRepoFullName: lowercases the result", () => {
  assert.equal(
    normalizeRepoFullName("git@github.com:OrgName/RepoName.git"),
    "orgname/reponame"
  );
});

test("normalizeRepoFullName: SSH URL with port-style colon separator", () => {
  assert.equal(
    normalizeRepoFullName("ssh://git@github.com/org/repo.git"),
    "org/repo"
  );
});

test("normalizeRepoFullName: returns null for non-URL non-SSH string", () => {
  // No colon/slash pattern that could match owner/repo
  assert.equal(normalizeRepoFullName("notaurl"), null);
});

test("normalizeRepoFullName: returns null for GitLab HTTPS remote", () => {
  assert.equal(normalizeRepoFullName("https://gitlab.com/org/repo.git"), null);
});

test("normalizeRepoFullName: returns null for Bitbucket HTTPS remote", () => {
  assert.equal(
    normalizeRepoFullName("https://bitbucket.org/org/repo.git"),
    null
  );
});

test("normalizeRepoFullName: returns null for self-hosted SSH remote", () => {
  assert.equal(normalizeRepoFullName("git@git.example.com:org/repo.git"), null);
});

test("normalizeRepoFullName: returns null for GitHub Enterprise host", () => {
  assert.equal(
    normalizeRepoFullName("https://github.example.com/org/repo.git"),
    null
  );
});

// ---------------------------------------------------------------------------
// pickBestLoc
// ---------------------------------------------------------------------------

const GIT_LOC: LocStats = { linesAdded: 10, linesRemoved: 5, filesChanged: 3 };
const AGENT_LOC: LocStats = {
  linesAdded: 20,
  linesRemoved: 8,
  filesChanged: 4,
};

test("pickBestLoc: prefers git over agent when both present", () => {
  assert.deepEqual(pickBestLoc(GIT_LOC, AGENT_LOC), {
    loc: GIT_LOC,
    source: "git",
  });
});

test("pickBestLoc: falls back to agent when git is null", () => {
  assert.deepEqual(pickBestLoc(null, AGENT_LOC), {
    loc: AGENT_LOC,
    source: "agent",
  });
});

test("pickBestLoc: returns null source when both are null", () => {
  assert.deepEqual(pickBestLoc(null, null), { loc: null, source: null });
});

test("pickBestLoc: uses git when agent is null", () => {
  assert.deepEqual(pickBestLoc(GIT_LOC, null), {
    loc: GIT_LOC,
    source: "git",
  });
});

// ---------------------------------------------------------------------------
// sumCommitStats
// ---------------------------------------------------------------------------

test("sumCommitStats: aggregates multiple stats", () => {
  const result = sumCommitStats([
    { linesAdded: 10, linesRemoved: 5, filesChanged: 2 },
    { linesAdded: 20, linesRemoved: 3, filesChanged: 1 },
  ]);
  assert.deepEqual(result, {
    linesAdded: 30,
    linesRemoved: 8,
    filesChanged: 3,
  });
});

test("sumCommitStats: ignores null entries", () => {
  const result = sumCommitStats([
    { linesAdded: 10, linesRemoved: 5, filesChanged: 2 },
    null,
    { linesAdded: 5, linesRemoved: 0, filesChanged: 1 },
  ]);
  assert.deepEqual(result, {
    linesAdded: 15,
    linesRemoved: 5,
    filesChanged: 3,
  });
});

test("sumCommitStats: returns null for empty array", () => {
  assert.equal(sumCommitStats([]), null);
});

test("sumCommitStats: returns null when all entries are null", () => {
  assert.equal(sumCommitStats([null, null, null]), null);
});

test("sumCommitStats: single non-null entry", () => {
  const stat: LocStats = { linesAdded: 7, linesRemoved: 2, filesChanged: 1 };
  assert.deepEqual(sumCommitStats([stat]), stat);
});
