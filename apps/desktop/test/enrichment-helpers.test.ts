/**
 * @file enrichment-helpers.test.ts
 * @description FEA-1899 Desktop KLOC Attribution Engine — the pure enrichment
 * helper that survives: repo-name normalization (git-exec). No I/O;
 * exact-value assertions.
 *
 * PLN-1535 M5 removed the commit-stat-summing and LOC-rollup cases along with
 * `git-enrichment.ts` / `rollup.ts`. ISS-5703 then removed the shortstat/SHA
 * subsystem itself (`gitShowShortstat`, `gitDiffThreeDotShortstat`,
 * `catFileType`, `isAncestor` and the `parseShortstat` / `validateSha` helpers
 * behind them) once nothing called it; `normalizeRepoFullName` stays because
 * repo-identity capture still uses it.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeRepoFullName } from "../src/main/enrichment/git-exec.js";

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
