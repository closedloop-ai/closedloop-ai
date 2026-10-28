import assert from "node:assert/strict";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import type { ArtifactRefRecord } from "../src/main/collectors/parsing/artifact-ref-record.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const REPO = "closedloop-ai/closedloop-ai";
const NOW = "2026-01-01T12:00:00.000Z";

describe("artifact PR number bounds (ISS-8338)", () => {
  test("prose PR mentions above the Prisma Int domain are ignored", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        `I replied to PR review comment #${PR_INT_MAX + 1}. PR #${PR_INT_MAX} is the valid one.`
      ),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [PR_INT_MAX]);
  });

  test("malformed prose PR literals are not truncated into valid numbers", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "PR #42.5, PR #43-foo, and PR #44/foo are malformed. PR #45 is valid."
      ),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [45]);
  });

  test("slash-separated prose PR lists keep each complete number", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "Prior remediation PR#110/#111; caching PRs #2062/#2073/#2074."
      ),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [110, 111, 2062, 2073, 2074]);
  });

  test("markdown-emphasized prose PR numbers are complete tokens", () => {
    const refs = extractArtifactRefs(
      sessionSaying("The fix shipped in PR **#2101** and review PR [#2102]."),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [2101, 2102]);
  });

  test("GitHub PR URLs above the Prisma Int domain are ignored", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            input: { command: "echo pr urls" },
            output: `See https://github.com/${REPO}/pull/${PR_INT_MAX + 1} and https://github.com/${REPO}/pull/42.`,
          },
        ],
      }),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [42]);
  });

  test("GitHub PR diff and patch URLs materialize the referenced PR", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            input: { command: "echo pr urls" },
            output: `See https://github.com/${REPO}/pull/41.diff and https://github.com/${REPO}/pull/42.patch?plain=1.`,
          },
        ],
      }),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [41, 42]);
  });

  test("malformed GitHub PR URLs are not truncated into valid numbers", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            input: { command: "echo pr urls" },
            output: `See https://github.com/${REPO}/pull/42.5, https://github.com/${REPO}/pull/43abc, https://github.com/${REPO}/pull/44-foo, and https://github.com/${REPO}/pull/45/files.`,
          },
        ],
      }),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [45]);
  });

  test("bare reviewed PR numbers above the Prisma Int domain are ignored", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            input: {
              command: `gh pr view ${PR_INT_MAX + 1} && gh pr view 42`,
            },
          },
        ],
      }),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [42]);
  });

  test("malformed reviewed PR number args are not truncated", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            input: {
              command:
                "gh pr view 42.5 && gh pr diff 43-foo && gh pr checkout 44/foo && gh pr view 45 --json number",
            },
          },
        ],
      }),
      NOW
    );

    assert.deepEqual(prNumbersOf(refs), [45]);
  });

  test("harness prLinks outside the Prisma Int domain are ignored", () => {
    const refs = extractArtifactRefs(
      makeSession({
        prLinks: [
          {
            number: String(PR_INT_MAX + 1),
            repo: REPO,
            url: `https://github.com/${REPO}/pull/${PR_INT_MAX + 1}`,
          },
          {
            number: "1.5",
            repo: REPO,
            url: `https://github.com/${REPO}/pull/1.5`,
          },
          {
            number: "0x2a",
            repo: REPO,
            url: `https://github.com/${REPO}/pull/0x2a`,
          },
          {
            number: "0",
            repo: REPO,
            url: `https://github.com/${REPO}/pull/0`,
          },
          {
            number: "42",
            repo: REPO,
            url: `https://github.com/${REPO}/pull/42`,
          },
        ],
      }),
      NOW
    );

    assert.deepEqual(
      refs
        .filter((ref) => ref.method === ArtifactRefMethod.HarnessPrLink)
        .map((ref) => ref.prNumber),
      [42]
    );
  });
});

describe("artifact prose branch bounds (ISS-8432)", () => {
  test("terminal-hyphen branch fragments are ignored", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "I pushed branch fix/iss-7864- before the complete branch fix/iss-7864-account-tab-signin-width."
      ),
      NOW
    );

    assert.deepEqual(branchNamesOf(refs), [
      "fix/iss-7864-account-tab-signin-width",
    ]);
  });
});

function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return baseSession({
    sessionId: "artifact-bounds-session",
    artifacts: { prs: [], issues: [], repo: REPO },
    ...overrides,
  });
}

function sessionSaying(text: string): NormalizedSession {
  return makeSession({
    messages: [{ role: "assistant", timestamp: null, text }],
  });
}

function prNumbersOf(refs: ArtifactRefRecord[]): number[] {
  return refs
    .filter((ref) => ref.targetKind === ArtifactRefTargetKind.PullRequest)
    .map((ref) => ref.prNumber ?? -1)
    .sort((a, b) => a - b);
}

function branchNamesOf(refs: ArtifactRefRecord[]): string[] {
  return refs
    .filter((ref) => ref.targetKind === ArtifactRefTargetKind.Branch)
    .map((ref) => ref.branchName ?? "")
    .sort();
}
