/**
 * @file fea1899-identity-key.test.ts
 * @description FEA-1899 (AC-4): unit tests for the canonical artifact dedup key
 * and its deterministic surrogate id. Both functions are pure (no I/O), so these
 * tests assert exact key formats, scope precedence (repoFullName over gitDir),
 * null/empty handling, and the md5-derived 16-char-hex id contract that the SQL
 * migration backfill (`left(md5(identity_key), 16)`) must match.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
  identityScope,
} from "../src/main/enrichment/identity-key.js";

const HEX_16_RE = /^[0-9a-f]{16}$/;

test("FEA-1899: commit key uses repoFullName scope and sha", () => {
  const key = computeIdentityKey({
    kind: ArtifactKind.Commit,
    repoFullName: "closedloop-ai/symphony-alpha",
    sha: "abc123",
  });
  assert.equal(key, "commit:closedloop-ai/symphony-alpha:abc123");
});

test("FEA-1899: branch key uses repoFullName scope and branchName", () => {
  const key = computeIdentityKey({
    kind: ArtifactKind.Branch,
    repoFullName: "closedloop-ai/symphony-alpha",
    branchName: "feat/fea-1899",
  });
  assert.equal(key, "branch:closedloop-ai/symphony-alpha:feat/fea-1899");
});

test("FEA-1899: pull_request key uses the 'pr' prefix and pr number", () => {
  const key = computeIdentityKey({
    kind: ArtifactKind.PullRequest,
    repoFullName: "closedloop-ai/symphony-alpha",
    prNumber: 1644,
  });
  assert.equal(key, "pr:closedloop-ai/symphony-alpha:1644");
});

test("FEA-1899: closedloop_artifact key is repo-agnostic — slug alone, no scope", () => {
  const key = computeIdentityKey({
    kind: ArtifactKind.ClosedloopArtifact,
    slug: "FEA-1899",
    // repo fields are deliberately set to prove they are ignored for cl docs.
    repoFullName: "closedloop-ai/symphony-alpha",
    gitDir: "/home/u/ws/symphony-alpha/.git",
  });
  assert.equal(key, "cldoc:FEA-1899");
});

test("FEA-1899: gitDir is the scope fallback when repoFullName is absent", () => {
  const key = computeIdentityKey({
    kind: ArtifactKind.Commit,
    gitDir: "/home/u/ws/symphony-alpha/.git",
    sha: "deadbeef",
  });
  assert.equal(key, "commit:/home/u/ws/symphony-alpha/.git:deadbeef");
});

test("FEA-1899: repoFullName wins over gitDir when both are present", () => {
  const key = computeIdentityKey({
    kind: ArtifactKind.Branch,
    repoFullName: "owner/repo",
    gitDir: "/home/u/ws/repo/.git",
    branchName: "main",
  });
  assert.equal(key, "branch:owner/repo:main");
});

test("FEA-1899: identityScope precedence — repoFullName, then gitDir, then empty", () => {
  assert.equal(identityScope("owner/repo", "/git/dir"), "owner/repo");
  assert.equal(identityScope(null, "/git/dir"), "/git/dir");
  assert.equal(identityScope(undefined, "/git/dir"), "/git/dir");
  assert.equal(identityScope(null, null), "");
  assert.equal(identityScope(undefined, undefined), "");
});

test("FEA-1899: missing scope collapses to an empty segment", () => {
  const key = computeIdentityKey({ kind: ArtifactKind.Commit, sha: "abc" });
  assert.equal(key, "commit::abc");
});

test("FEA-1899: null/undefined natural ids collapse to an empty trailing segment", () => {
  assert.equal(
    computeIdentityKey({ kind: ArtifactKind.Commit, repoFullName: "o/r" }),
    "commit:o/r:"
  );
  assert.equal(
    computeIdentityKey({
      kind: ArtifactKind.Commit,
      repoFullName: "o/r",
      sha: null,
    }),
    "commit:o/r:"
  );
  assert.equal(
    computeIdentityKey({ kind: ArtifactKind.Branch, repoFullName: "o/r" }),
    "branch:o/r:"
  );
  assert.equal(
    computeIdentityKey({ kind: ArtifactKind.PullRequest, repoFullName: "o/r" }),
    "pr:o/r:"
  );
  assert.equal(
    computeIdentityKey({ kind: ArtifactKind.ClosedloopArtifact }),
    "cldoc:"
  );
});

test("FEA-1899: artifactIdFromIdentityKey is the first 16 hex chars of md5", () => {
  const key = "commit:owner/repo:abc123";
  const id = artifactIdFromIdentityKey(key);
  const expected = createHash("md5").update(key).digest("hex").slice(0, 16);
  assert.equal(id, expected);
  assert.equal(id.length, 16);
  assert.match(id, HEX_16_RE);
});

test("FEA-1899: artifactIdFromIdentityKey is deterministic for identical input", () => {
  const key = "pr:owner/repo:42";
  assert.equal(artifactIdFromIdentityKey(key), artifactIdFromIdentityKey(key));
});

test("FEA-1899: computeIdentityKey is deterministic — same input, same key", () => {
  const input = {
    kind: ArtifactKind.PullRequest,
    repoFullName: "owner/repo",
    prNumber: 7,
  } as const;
  assert.equal(computeIdentityKey(input), computeIdentityKey(input));
});

test("FEA-1899: distinct identity keys yield distinct surrogate ids", () => {
  const a = artifactIdFromIdentityKey("commit:o/r:aaa");
  const b = artifactIdFromIdentityKey("commit:o/r:bbb");
  assert.notEqual(a, b);
});
