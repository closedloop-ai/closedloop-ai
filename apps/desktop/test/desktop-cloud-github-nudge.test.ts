import assert from "node:assert/strict";
import {
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  GitHubDirtyFallbackReason,
  GitHubDirtyScopeKind,
} from "@repo/api/src/types/github-dirty-scope";
import { test } from "vitest";
import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud/cloud-protocol.js";
import {
  classifyGitHubResyncNudgeCommand,
  GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS,
  handleGitHubResyncNudgeCommand,
  handleGitHubResyncNudgeFromApp,
  resolveGitHubResyncNudgeTargetContext,
} from "../src/main/github/github-resync-nudge.js";
import { BrowserCommandKeyTargetContextOutcome } from "../src/main/github/github-resync-nudge-target-context.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_GATEWAY_ID = "44444444-4444-4444-8444-444444444444";

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
      operationId: "git_local_changes",
      method: "GET",
      path: "/api/gateway/git/local-changes",
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

/**
 * ISS-7486: each of these four rejected with ONE wire reason before the split,
 * so the metric could not say which of them owned the 39,110 rejections that
 * were 100% of production's rejected acks. Each case asserts its own reason, so
 * collapsing any two back together fails here.
 */
const NUDGE_CONTEXT_REJECTION_CASES: readonly {
  name: string;
  body: Record<string, unknown>;
  activeContext?: { computeTargetId: string; gatewayId?: string };
  outcome: keyof typeof GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS;
}[] = [
  {
    name: "the command carried no target context at all",
    body: {
      scopes: makeNudgeBody().scopes,
    },
    activeContext: { computeTargetId: TARGET_ID, gatewayId: GATEWAY_ID },
    outcome: BrowserCommandKeyTargetContextOutcome.CommandContextAbsent,
  },
  {
    name: "the desktop has no resolvable active context",
    body: makeNudgeBody(),
    activeContext: undefined,
    outcome: BrowserCommandKeyTargetContextOutcome.ActiveContextUnresolved,
  },
  {
    name: "the compute targets disagree",
    body: { ...makeNudgeBody(), computeTargetId: OTHER_TARGET_ID },
    activeContext: { computeTargetId: TARGET_ID, gatewayId: GATEWAY_ID },
    outcome: BrowserCommandKeyTargetContextOutcome.ComputeTargetMismatch,
  },
  {
    name: "the gateways disagree",
    body: makeNudgeBody(),
    activeContext: {
      computeTargetId: TARGET_ID,
      gatewayId: OTHER_TARGET_ID,
    },
    outcome: BrowserCommandKeyTargetContextOutcome.GatewayMismatch,
  },
];

for (const nudgeCase of NUDGE_CONTEXT_REJECTION_CASES) {
  test(`reserved GitHub resync nudge names its own reason when ${nudgeCase.name}`, async () => {
    const acks: Pick<
      DesktopCommandAckEvent,
      "commandId" | "accepted" | "state" | "reason"
    >[] = [];
    let refreshCount = 0;

    await handleGitHubResyncNudgeCommand(
      makeNudgeCommand({ body: nudgeCase.body }),
      {
        getActiveTargetContext: () => nudgeCase.activeContext,
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
        reason:
          GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS[nudgeCase.outcome],
      },
    ]);
    assert.equal(refreshCount, 0);
  });
}

test("the four nudge context reasons are distinct wire strings", () => {
  // A duplicate would rebuild exactly the collapse ISS-7486 is splitting, and
  // every per-case assertion above would still pass.
  const reasons = Object.values(GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS);
  assert.equal(new Set(reasons).size, reasons.length);
});

test("nudge target context is the connection identity (ISS-8049)", () => {
  assert.deepEqual(
    resolveGitHubResyncNudgeTargetContext({
      onlineComputeTargetId: TARGET_ID,
      gatewayId: GATEWAY_ID,
    }),
    { computeTargetId: TARGET_ID, gatewayId: GATEWAY_ID }
  );
  // Unknown gateway id stays absent so a gateway-less command still matches.
  assert.deepEqual(
    resolveGitHubResyncNudgeTargetContext({
      onlineComputeTargetId: TARGET_ID,
      gatewayId: null,
    }),
    { computeTargetId: TARGET_ID }
  );
  // Offline: no addressing identity at all — the handler must keep rejecting.
  assert.equal(
    resolveGitHubResyncNudgeTargetContext({
      onlineComputeTargetId: null,
      gatewayId: GATEWAY_ID,
    }),
    undefined
  );
});

test("connection-identity fallback admits a correctly-addressed nudge end to end (ISS-8049)", async () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const refreshes: unknown[] = [];
  const rendered: unknown[] = [];
  await handleGitHubResyncNudgeFromApp(makeNudgeCommand(), {
    getOnlineComputeTargetId: () => TARGET_ID,
    cloudSocket: {
      getHelloGatewayId: () => GATEWAY_ID,
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    },
    getAgentDashboard: () => ({
      refreshGitHubBranches: (body: unknown) => {
        refreshes.push(body);
        return Promise.resolve(undefined as unknown);
      },
    }),
    sendResyncRefreshToRenderer: (payload) => rendered.push(payload),
  });
  assert.deepEqual(acks, [
    { commandId: "github-nudge-command", accepted: true, state: "accepted" },
  ]);
  assert.equal(refreshes.length, 1);
  // The fallback renderer payload is composed by the collaborator, not app.ts.
  assert.equal(rendered.length, 1);
});

test("the nudge gateway check compares against the id the hello declared (ISS-12032)", async () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  await handleGitHubResyncNudgeFromApp(makeNudgeCommand(), {
    getOnlineComputeTargetId: () => TARGET_ID,
    cloudSocket: {
      getHelloGatewayId: () => OTHER_GATEWAY_ID,
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    },
    getAgentDashboard: () => undefined,
    sendResyncRefreshToRenderer: () => {},
  });
  assert.deepEqual(acks, [
    {
      commandId: "github-nudge-command",
      accepted: false,
      state: "failed",
      reason:
        GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS[
          BrowserCommandKeyTargetContextOutcome.GatewayMismatch
        ],
    },
  ]);
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
        repositoryFullName: "closedloop-ai/closedloop-ai",
        branchName: "feat/nudge",
      },
    ],
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
  };
}
