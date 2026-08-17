import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type ArtifactRefRecord,
  canonicalKeyForRef,
} from "../src/main/collectors/parsing/artifact-ref-record.js";

const NOW = "2024-01-01T12:00:00.000Z";

function ref(
  overrides: Pick<ArtifactRefRecord, "targetKind" | "targetIdentity"> &
    Partial<ArtifactRefRecord>
): ArtifactRefRecord {
  return {
    relation: "referenced",
    method: "test",
    evidence: "{}",
    observedAt: NOW,
    confidence: "url_match",
    extractorVersion: 1,
    isPrimary: false,
    ...overrides,
  };
}

describe("canonicalKeyForRef", () => {
  test("keys a pull request by repository and number", () => {
    assert.equal(
      canonicalKeyForRef(
        ref({
          targetKind: "pull_request",
          targetIdentity: "closedloop-ai/symphony-alpha#99",
          repoFullName: "closedloop-ai/symphony-alpha",
          prNumber: 99,
        })
      ),
      "closedloop-ai/symphony-alpha#99"
    );
  });

  test("keys a branch by optional repository and branch name", () => {
    assert.equal(
      canonicalKeyForRef(
        ref({
          targetKind: "branch",
          targetIdentity: "main",
          repoFullName: "closedloop-ai/symphony-alpha",
          branchName: "main",
        })
      ),
      "closedloop-ai/symphony-alpha:main"
    );
    assert.equal(
      canonicalKeyForRef(
        ref({
          targetKind: "branch",
          targetIdentity: "feat/x",
          branchName: "feat/x",
        })
      ),
      ":feat/x"
    );
  });

  test("keys commits by SHA and ClosedLoop artifacts by slug", () => {
    assert.equal(
      canonicalKeyForRef(
        ref({
          targetKind: "commit",
          targetIdentity: "abc1234",
          sha: "abc1234",
        })
      ),
      "abc1234"
    );
    assert.equal(
      canonicalKeyForRef(
        ref({
          targetKind: "closedloop_artifact",
          targetIdentity: "FEA-1",
          slug: "FEA-1",
        })
      ),
      "FEA-1"
    );
  });
});
