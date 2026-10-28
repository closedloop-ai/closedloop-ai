/**
 * @file artifact-ref-mcp-shell.test.ts
 * @description ISS-8268 — shell-through-MCP command recognition. Sessions whose
 * `git push` / `gh pr create` runs through an MCP shell tool must emit the same
 * command-grade refs as the builtin Bash path; a non-shell MCP tool whose input
 * merely mentions a command in prose must not. Own file (not appended to
 * artifact-ref-extractor.test.ts) because that suite is a shrink-only
 * grandfathered file.
 */
import assert from "node:assert/strict";
import { ArtifactRefMethod } from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

describe("ISS-8268: shell-through-MCP command recognition", () => {
  test("MCP-shell git push emits the created git_push branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__lc__bash",
          timestamp: NOW,
          input: {
            command: "git push -u origin fix/iss-8268-mcp-shell",
            cwd: "/repo",
            timeout: 120,
          },
        },
      ],
    });
    const ref = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(ref, "MCP-shell push must emit push evidence");
    assert.equal(ref?.branchName, "fix/iss-8268-mcp-shell");
    assert.equal(ref?.relation, "created");
  });

  test("MCP-shell gh pr create emits the created PR ref with its head branch", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__lc__bash",
          timestamp: NOW,
          input: { command: "gh pr create --fill" },
          output:
            "Warning: 3 commits on branch 'fix/iss-8268-mcp-shell'\nhttps://github.com/closedloop-ai/closedloop-ai/pull/6123\n",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const pr = refs.find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.ok(pr, "MCP-shell gh pr create must emit a created PR ref");
    assert.equal(pr?.prNumber, 6123);
    const branch = refs.find(
      (r) => r.targetKind === "branch" && r.method === "gh_pr_create"
    );
    assert.equal(branch?.branchName, "fix/iss-8268-mcp-shell");
  });

  test("failed MCP-shell push emits no push evidence", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__lc__bash",
          timestamp: NOW,
          input: { command: "git push origin fix/iss-8268-failed" },
          isError: true,
        },
      ],
    });
    const ref = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.equal(
      ref,
      undefined,
      "a failed MCP-shell push is not push evidence"
    );
  });

  test("a non-shell MCP tool mentioning git push in prose emits no command ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__acme__search",
          timestamp: NOW,
          input: {
            query: "I pushed fix/iss-8268-prose-only — why did git push fail?",
          },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    assert.equal(
      refs.find((r) => r.method === "git_push"),
      undefined,
      "a prose mention inside a non-shell MCP input is not push evidence"
    );
    const prose = refs.find(
      (r) => r.method === ArtifactRefMethod.BranchMentionInProse
    );
    assert.equal(prose?.branchName, "fix/iss-8268-prose-only");
  });

  test("an MCP command field running a non-git command emits no refs", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__acme__terminal",
          timestamp: NOW,
          input: { command: "kubectl get pods --namespace prod" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch" || r.targetKind === "pull_request"
    );
    assert.deepEqual(refs, []);
  });

  test("a separator-bundled argv element cannot inject a phantom push ref", () => {
    // PR #6160 review: argv is execve-style, so `--glob=foo;git` is ONE literal
    // argument — the join must not read its tail as a `git push` command.
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__lc__bash",
          timestamp: NOW,
          input: {
            command: ["rg", "--glob=foo;git", "push", "origin", "fix/injected"],
          },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
    assert.deepEqual(refs, []);
  });

  test("Codex-convention MCP shell (mcpServer, argv command) emits the push ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "lc_bash",
          mcpServer: "lemoncrow",
          timestamp: NOW,
          input: {
            command: ["git", "push", "origin", "feat/iss-8268-codex-argv"],
          },
        },
      ],
    });
    const ref = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(ref, "argv-shaped MCP-shell push must emit push evidence");
    assert.equal(ref?.branchName, "feat/iss-8268-codex-argv");
  });
});
