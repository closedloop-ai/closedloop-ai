import assert from "node:assert/strict";
import { test } from "node:test";
import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch";
import {
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  GitHubDirtyFallbackReason,
  GitHubDirtyScopeKind,
} from "@repo/api/src/types/github-dirty-scope";
import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud-protocol.js";
import { resolveGitHubResyncBranchIds } from "../src/main/github-resync-branch-resolution.js";
import {
  classifyGitHubResyncNudgeCommand,
  GITHUB_RESYNC_NUDGE_TARGET_CONTEXT_MISMATCH_REASON,
  handleGitHubResyncNudgeCommand,
} from "../src/main/github-resync-nudge.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";

test("GitHub resync nudge matcher is limited to exact reserved command", () => {
  assert.equal(classifyGitHubResyncNudgeCommand(makeNudgeCommand()), "match");
  assert.equal(
    classifyGitHubResyncNudgeCommand(
      makeNudgeCommand({ operationId: "symphony_status" })
    ),
    "mismatch"
  );
  assert.equal(
    classifyGitHubResyncNudgeCommand(makeNudgeCommand({ method: "GET" })),
    "mismatch"
  );
  assert.equal(
    classifyGitHubResyncNudgeCommand({
      operationId: "symphony_status",
      method: "GET",
      path: "/api/gateway/symphony/status/FEA-1",
    }),
    "not_reserved"
  );
});

test("reserved GitHub resync nudge emits refresh after target validation", async () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  const refreshes: unknown[] = [];

  await handleGitHubResyncNudgeCommand(makeNudgeCommand(), {
    getActiveTargetContext: () => ({
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
    }),
    sendCommandAck: (event) => acks.push(event),
    sendCommandEvent: (event) => events.push(event),
    notifyRendererRefresh: (body) => refreshes.push(body),
  });

  assert.deepEqual(acks, [
    {
      commandId: "github-nudge-command",
      accepted: true,
      state: "accepted",
    },
  ]);
  assert.deepEqual(events, [
    {
      commandId: "github-nudge-command",
      sequence: 1,
      eventType: "done",
      data: { type: "done", fallback: false },
    },
  ]);
  assert.deepEqual(refreshes, [makeNudgeBody()]);
});

test("reserved GitHub resync nudge waits for the refresh boundary before done", async () => {
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  const refreshes: unknown[] = [];

  await handleGitHubResyncNudgeCommand(makeNudgeCommand(), {
    getActiveTargetContext: () => ({
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
    }),
    sendCommandAck: () => {},
    sendCommandEvent: (event) => events.push(event),
    notifyRendererRefresh: (body) => {
      assert.equal(events.length, 0);
      refreshes.push(body);
    },
  });

  assert.equal(refreshes.length, 1);
  assert.equal(events.length, 1);
});

test("reserved GitHub resync nudge accepts unknown scopes with target context fallback", async () => {
  const refreshes: unknown[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];

  await handleGitHubResyncNudgeCommand(
    makeNudgeCommand({
      body: {
        scopes: [{ kind: "future_scope", branchName: "main" }],
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      },
    }),
    {
      getActiveTargetContext: () => ({
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      }),
      sendCommandAck: () => {},
      sendCommandEvent: (event) => events.push(event),
      notifyRendererRefresh: (body) => refreshes.push(body),
    }
  );

  assert.deepEqual(refreshes, [
    {
      scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
      fallbackReason: GitHubDirtyFallbackReason.MalformedPayload,
      computeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
    },
  ]);
  assert.deepEqual(events[0]?.data, { type: "done", fallback: true });
});

test("reserved GitHub resync nudge rejects mismatched target context", async () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  let refreshCount = 0;

  await handleGitHubResyncNudgeCommand(
    makeNudgeCommand({
      body: { ...makeNudgeBody(), computeTargetId: OTHER_TARGET_ID },
    }),
    {
      getActiveTargetContext: () => ({
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      }),
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
      notifyRendererRefresh: () => {
        refreshCount += 1;
      },
    }
  );

  assert.deepEqual(acks, [
    {
      commandId: "github-nudge-command",
      accepted: false,
      state: "failed",
      reason: GITHUB_RESYNC_NUDGE_TARGET_CONTEXT_MISMATCH_REASON,
    },
  ]);
  assert.equal(refreshCount, 0);
});

test("GitHub resync scope resolution maps repo and PR number to branch id", () => {
  const branch = makeBranchRow({
    id: "branch-artifact-42",
    repoFullName: "closedloop-ai/symphony-alpha",
    branchName: "feat/nudge",
    prNumber: 42,
  });

  assert.deepEqual(
    resolveGitHubResyncBranchIds(
      [
        {
          kind: GitHubDirtyScopeKind.Comment,
          repositoryFullName: "closedloop-ai/symphony-alpha",
          pullRequestNumber: 42,
        },
      ],
      [branch]
    ),
    ["branch-artifact-42"]
  );
});

function makeNudgeCommand(
  overrides: Partial<DesktopCommandEvent> = {}
): DesktopCommandEvent {
  return {
    commandId: "github-nudge-command",
    operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
    method: GITHUB_RESYNC_NUDGE_METHOD,
    path: GITHUB_RESYNC_NUDGE_PATH,
    body: makeNudgeBody(),
    timeoutMs: 30_000,
    ...overrides,
  };
}

function makeNudgeBody() {
  return {
    scopes: [
      {
        kind: GitHubDirtyScopeKind.Branch,
        repositoryId: "repo-1",
        repositoryFullName: "closedloop-ai/symphony-alpha",
        branchName: "feat/nudge",
      },
    ],
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
  };
}

function makeBranchRow(overrides: Partial<BranchRow>): BranchRow {
  return {
    id: "branch-id",
    branchName: "main",
    baseBranch: null,
    repoFullName: "closedloop-ai/symphony-alpha",
    owner: null,
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-07-06T09:00:00.000Z",
    sessionIds: [],
    ...overrides,
  };
}
