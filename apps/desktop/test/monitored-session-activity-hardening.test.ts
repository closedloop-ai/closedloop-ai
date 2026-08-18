import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import {
  MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION,
  type SyncedMonitoredSessionActivity,
} from "@repo/api/src/types/session-monitored-activity";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { GitHubMonitoredActivityTool } from "../src/main/collectors/parsing/monitored-session-github-mcp.js";
import {
  boundedNestedTextValues,
  toolUseHasCompleted,
} from "../src/main/collectors/parsing/monitored-session-source.js";
import {
  MONITORED_ACTIVITY_TEST_ACTION_AT as ACTION_AT,
  MONITORED_ACTIVITY_TEST_BRANCH as BRANCH,
  makeMonitoredActivityTestSession as makeSession,
  MONITORED_ACTIVITY_TEST_READ_AT as READ_AT,
  MONITORED_ACTIVITY_TEST_REPOSITORY as REPOSITORY,
} from "./support/monitored-session-activity-fixtures.js";

describe("ISS-6060 monitored Session activity hardening", () => {
  test("shares one concrete completion predicate across activity producers", () => {
    assert.equal(
      toolUseHasCompleted({ name: "Bash", timestamp: ACTION_AT }),
      false
    );
    assert.equal(
      toolUseHasCompleted({
        name: "Bash",
        timestamp: ACTION_AT,
        output: "",
      }),
      true
    );
    assert.equal(
      toolUseHasCompleted({
        name: "Bash",
        timestamp: ACTION_AT,
        resultTimestamp: ACTION_AT,
      }),
      true
    );
  });

  test("does not classify in-flight Git, gh, or GitHub MCP tools as successful", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            id: "in-flight-push",
            name: "Bash",
            timestamp: ACTION_AT,
            input: { command: `git push origin ${BRANCH}` },
          },
          {
            id: "in-flight-review",
            name: "Bash",
            timestamp: ACTION_AT,
            input: { command: "gh pr review 6060 --approve" },
          },
          {
            id: "in-flight-mcp-read",
            name: "mcp__github__pull_request_read",
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6060,
              method: "get",
            },
          },
          {
            id: "in-flight-mcp-write",
            name: "mcp__github__update_pull_request",
            timestamp: ACTION_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6060,
            },
          },
        ],
      })
    );

    assert.equal(refs.some(refHasMonitoredActivity), false);
  });

  test("rejects spoofed/conflicting GitHub provenance and create-PR without a head", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            id: "wrong-server",
            name: "mcp__github__pull_request_read",
            kind: "mcp",
            mcpServer: "gitlab",
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6061,
              method: "get",
            },
            output: { ok: true },
          },
          {
            id: "conflicting-methods",
            name: "mcp__github__pull_request_read",
            normalizedName: "github__update_pull_request",
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6062,
              method: "get",
            },
            output: { ok: true },
          },
          {
            id: "create-pr-without-head",
            name: `mcp__github__${GitHubMonitoredActivityTool.CreatePullRequest}`,
            timestamp: ACTION_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
            },
            output: `https://github.com/${REPOSITORY}/pull/6063`,
          },
        ],
      })
    );

    assert.equal(refs.some(refHasMonitoredActivity), false);
  });

  test("excludes multi-target, comment-id-only, passive, prose-only, and failed shapes", () => {
    const refs = extractArtifactRefs(
      makeSession({
        gitBranch: BRANCH,
        messages: [
          {
            role: "human",
            timestamp: READ_AT,
            text: "Please review #6060 and the active feature branch",
          },
        ],
        toolUses: [
          ...[
            "list_branches",
            "list_pull_requests",
            "search_pull_requests",
            "get_pull_request_comment",
          ].map((name, index) => ({
            id: `excluded-mcp-${index}`,
            name: `mcp__github__${name}`,
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6060,
              commentId: 42,
            },
            output: { ok: true },
          })),
          {
            id: "failed-push",
            name: "Bash",
            timestamp: ACTION_AT,
            input: { command: `git push origin ${BRANCH}` },
            output: "remote rejected",
            isError: true,
          },
          {
            id: "failed-review",
            name: "Bash",
            timestamp: ACTION_AT,
            input: { command: "gh pr review 6060 --approve" },
            output: "review rejected",
            isError: true,
          },
        ],
      })
    );

    assert.equal(refs.some(refHasMonitoredActivity), false);
  });

  test("caps aggregate Session evidence latest-first across distinct targets", () => {
    const eventCount =
      MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION + 1;
    const refs = extractArtifactRefs(
      makeSession({
        messages: Array.from({ length: eventCount }, (_, index) => ({
          role: "human" as const,
          timestamp: new Date(Date.parse(READ_AT) + index * 1000).toISOString(),
          text: `https://github.com/${REPOSITORY}/pull/${7000 + index}`,
        })),
      })
    );
    const retained = refs.filter(refHasMonitoredActivity);

    assert.equal(
      retained.length,
      MAX_SYNCED_MONITORED_SESSION_ACTIVITY_EVENTS_PER_SESSION
    );
    assert.equal(
      retained.some((ref) => ref.targetIdentity === `${REPOSITORY}#7000`),
      false,
      "the oldest target falls outside the Session-wide cap"
    );
    assert.equal(
      retained.some(
        (ref) => ref.targetIdentity === `${REPOSITORY}#${7000 + eventCount - 1}`
      ),
      true
    );
    assert.ok(
      retained.every(
        (ref) =>
          monitoredActivityFor(ref)?.completeness ===
          BranchActivityEvidenceCompleteness.Partial
      )
    );
  });

  test("bounds wide nested tool output before traversing unretained members", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [
        `field${index}`,
        `value-${index}`,
      ])
    );
    const values = boundedNestedTextValues(wide);

    assert.equal(values.length, 100);
    assert.equal(values.includes("value-999"), false);
  });
});

function monitoredActivityFor(ref: {
  evidence: string;
}): SyncedMonitoredSessionActivity | undefined {
  return (
    JSON.parse(ref.evidence) as {
      monitoredSessionActivity?: SyncedMonitoredSessionActivity;
    }
  ).monitoredSessionActivity;
}

function refHasMonitoredActivity(ref: {
  evidence: string;
  targetKind: string;
}): boolean {
  return (
    (ref.targetKind === ArtifactRefTargetKind.Branch ||
      ref.targetKind === ArtifactRefTargetKind.PullRequest) &&
    monitoredActivityFor(ref) !== undefined
  );
}
