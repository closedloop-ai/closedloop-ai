import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import {
  MonitoredSessionActivityEventKind,
  type SyncedMonitoredSessionActivity,
} from "@repo/api/src/types/session-monitored-activity";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import {
  GitHubMonitoredActivityTool,
  GitHubPullRequestActionMethod,
  GitHubPullRequestReadMethod,
} from "../src/main/collectors/parsing/monitored-session-github-mcp.js";
import {
  MONITORED_ACTIVITY_TEST_ACTION_AT as ACTION_AT,
  MONITORED_ACTIVITY_TEST_BRANCH as BRANCH,
  monitoredActivityCarrierFor as carrierFor,
  makeMonitoredActivityTestSession as makeSession,
  MONITORED_ACTIVITY_TEST_READ_AT as READ_AT,
  MONITORED_ACTIVITY_TEST_REPOSITORY as REPOSITORY,
  monitoredActivityRefFor as refFor,
} from "./support/monitored-session-activity-fixtures.js";

describe("ISS-6060 GitHub MCP monitored activity", () => {
  test("normalizes an official GitHub MCP PR read and retains the exact head", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            id: "mcp-read-1",
            name: "mcp__github__pull_request_read",
            rawName: "github__pull_request_read",
            kind: "mcp",
            mcpServer: "github",
            mcpMethod: "pull_request_read",
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6060,
              method: "get_files",
            },
            output: { head: { ref: BRANCH } },
          },
        ],
      })
    );
    const ref = refFor(
      refs,
      ArtifactRefTargetKind.PullRequest,
      `${REPOSITORY}#6060`
    );

    assert.equal(ref.method, ArtifactRefMethod.McpToolCall);
    assert.equal(ref.branchName, BRANCH);
    assert.equal(
      carrierFor(ref).events[0].kind,
      MonitoredSessionActivityEventKind.AgentRead
    );
  });

  for (const [index, method] of Object.values(
    GitHubPullRequestReadMethod
  ).entries()) {
    test(`qualifies the exact GitHub MCP PR read method ${method}`, () => {
      const prefixes = ["", "github__", "mcp__github__"] as const;
      const prNumber = 6100 + index;
      const refs = extractArtifactRefs(
        makeSession({
          toolUses: [
            {
              id: `mcp-read-${method}`,
              name: `${prefixes[index % prefixes.length]}${GitHubMonitoredActivityTool.PullRequestRead}`,
              kind: index % prefixes.length === 0 ? "mcp" : undefined,
              mcpServer: index % prefixes.length === 0 ? "github" : undefined,
              timestamp: READ_AT,
              input: {
                owner: "closedloop-ai",
                repo: "symphony-alpha",
                pullNumber: prNumber,
                method,
              },
              output: { head: { ref: BRANCH } },
            },
          ],
        })
      );
      const ref = refFor(
        refs,
        ArtifactRefTargetKind.PullRequest,
        `${REPOSITORY}#${prNumber}`
      );

      assert.equal(
        carrierFor(ref).events[0].kind,
        MonitoredSessionActivityEventKind.AgentRead
      );
    });
  }

  for (const [index, method] of Object.values(
    GitHubPullRequestActionMethod
  ).entries()) {
    test(`qualifies the exact successful GitHub MCP PR action ${method}`, () => {
      const prefixes = ["", "github__", "mcp__github__"] as const;
      const prNumber = 6200 + index;
      const refs = extractArtifactRefs(
        makeSession({
          toolUses: [
            {
              id: `mcp-action-${method}`,
              name: `${prefixes[index % prefixes.length]}${method}`,
              kind: index % prefixes.length === 0 ? "mcp" : undefined,
              mcpServer: index % prefixes.length === 0 ? "github" : undefined,
              timestamp: ACTION_AT,
              input: {
                owner: "closedloop-ai",
                repo: "symphony-alpha",
                pullNumber: prNumber,
              },
              output: { ok: true },
            },
          ],
        })
      );
      const ref = refFor(
        refs,
        ArtifactRefTargetKind.PullRequest,
        `${REPOSITORY}#${prNumber}`
      );

      assert.equal(
        carrierFor(ref).events[0].kind,
        MonitoredSessionActivityEventKind.AgentAction
      );
    });
  }

  test("qualifies exact GitHub MCP create-branch and proven create-PR output", () => {
    const createdPr = 6260;
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            id: "mcp-create-branch",
            name: `mcp__github__${GitHubMonitoredActivityTool.CreateBranch}`,
            timestamp: ACTION_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              branch: BRANCH,
            },
            output: { ref: `refs/heads/${BRANCH}` },
          },
          {
            id: "mcp-create-pr",
            name: `github__${GitHubMonitoredActivityTool.CreatePullRequest}`,
            timestamp: ACTION_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              head: BRANCH,
            },
            output: {
              result: {
                url: `https://github.com/${REPOSITORY}/pull/${createdPr}`,
              },
            },
          },
        ],
      })
    );

    assert.equal(
      carrierFor(refFor(refs, ArtifactRefTargetKind.Branch, BRANCH)).events[0]
        .kind,
      MonitoredSessionActivityEventKind.AgentAction
    );
    assert.equal(
      carrierFor(
        refFor(
          refs,
          ArtifactRefTargetKind.PullRequest,
          `${REPOSITORY}#${createdPr}`
        )
      ).events[0].kind,
      MonitoredSessionActivityEventKind.AgentAction
    );
  });

  test("requires concrete matching output proof for GitHub MCP create-PR", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: `mcp__github__${GitHubMonitoredActivityTool.CreatePullRequest}`,
            timestamp: ACTION_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              head: BRANCH,
            },
            output: { ok: true },
          },
          {
            name: `mcp__github__${GitHubMonitoredActivityTool.CreatePullRequest}`,
            timestamp: ACTION_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              head: BRANCH,
            },
            output: "https://github.com/another/repository/pull/6261",
          },
        ],
      })
    );

    const pullRequestRefs = refs.filter(
      (ref) => ref.targetKind === ArtifactRefTargetKind.PullRequest
    );
    assert.equal(pullRequestRefs.length, 1);
    assert.equal(
      (
        JSON.parse(pullRequestRefs[0].evidence) as {
          monitoredSessionActivity?: SyncedMonitoredSessionActivity;
        }
      ).monitoredSessionActivity,
      undefined
    );
  });

  test("excludes failed, unsupported, generic, and similar GitHub MCP shapes", () => {
    const refs = extractArtifactRefs(
      makeSession({
        toolUses: [
          {
            name: "mcp__github__pull_request_read",
            kind: "mcp",
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6060,
              method: "unsupported_method",
            },
          },
          {
            name: "mcp__github__pull_request_read_similar",
            kind: "mcp",
            timestamp: READ_AT,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6061,
              method: "get",
            },
          },
          {
            name: "mcp__github__update_pull_request",
            kind: "mcp",
            timestamp: ACTION_AT,
            isError: true,
            input: {
              owner: "closedloop-ai",
              repo: "symphony-alpha",
              pullNumber: 6062,
            },
          },
          {
            name: "mcp__github__request",
            kind: "mcp",
            timestamp: READ_AT,
            input: { method: "GET", path: "/repos/x/y/pulls/6063" },
          },
        ],
      })
    );

    assert.deepEqual(
      refs.filter(
        (ref) => ref.targetKind === ArtifactRefTargetKind.PullRequest
      ),
      []
    );
  });
});
