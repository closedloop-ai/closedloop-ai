import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { mapDetail } from "../src/main/session/shared-agent-session-detail-projection.js";
import {
  getSharedAgentSessions,
  mapListItem,
} from "../src/main/session/shared-agent-sessions-api.js";
import type { SharedAgentSessionListItem } from "../src/shared/shared-agent-sessions-contract.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

function buildMinimalSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-1",
    name: "Test Session",
    status: "active",
    harness: "claude",
    cwd: "/tmp",
    model: "claude-sonnet-4",
    startedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  } as SyncedAgentSession;
}

function buildMinimalListItem(
  overrides: Partial<SharedAgentSessionListItem> = {}
): SharedAgentSessionListItem {
  return {
    id: "sess-1",
    slug: "SES-1",
    externalSessionId: "sess-1",
    name: "Test Session",
    status: "active",
    harness: "claude",
    cwd: "/tmp",
    repositoryFullName: null,
    repo: null,
    worktreePath: null,
    model: "claude-sonnet-4",
    primaryModel: "claude-sonnet-4",
    branch: null,
    prs: [],
    prsMerged: 0,
    cost: "$0.00",
    wallClock: null,
    activeAgent: null,
    waitingUser: null,
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    turns: null,
    toolCallsTotal: null,
    steeringEpisodes: null,
    autonomy: null,
    startedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    endedAt: null,
    user: null,
    origin: undefined,
    project: null,
    computeTarget: null,
    locPerDollar: null,
    evidenceCoverage: null,
    ...overrides,
  } as SharedAgentSessionListItem;
}

describe("ISS-7895: desktop detail models = billed-only", () => {
  test("declared model + zero token-usage rows → models [] and primaryModel preserved", () => {
    const result = mapDetail({
      session: buildMinimalSession({ tokenUsageByModel: [] }),
      listItem: buildMinimalListItem({ primaryModel: "claude-sonnet-4" }),
      events: [],
      truncation: {},
    });
    assert.deepEqual(result.models, []);
    assert.equal(result.primaryModel, "claude-sonnet-4");
  });

  test("billed models → distinct billed set", () => {
    const result = mapDetail({
      session: buildMinimalSession({
        tokenUsageByModel: [
          {
            model: "gpt-5.5",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          {
            model: "claude-sonnet-4",
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          {
            model: "gpt-5.5",
            inputTokens: 50,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ] as SyncedAgentSession["tokenUsageByModel"],
      }),
      listItem: buildMinimalListItem({ primaryModel: "claude-sonnet-4" }),
      events: [],
      truncation: {},
    });
    assert.deepEqual([...result.models!].sort(), [
      "claude-sonnet-4",
      "gpt-5.5",
    ]);
  });

  test("zeroed row alongside a billed row → only the billed model", () => {
    const result = mapDetail({
      session: buildMinimalSession({
        tokenUsageByModel: [
          {
            model: "gpt-5.5",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0,
          },
          {
            model: "claude-sonnet-4",
            inputTokens: 120,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.75,
          },
        ] as SyncedAgentSession["tokenUsageByModel"],
      }),
      listItem: buildMinimalListItem({ primaryModel: "claude-sonnet-4" }),
      events: [],
      truncation: {},
    });
    assert.deepEqual(result.models, ["claude-sonnet-4"]);
  });

  test("priced row with zero token counters still counts as billed", () => {
    const result = mapDetail({
      session: buildMinimalSession({
        tokenUsageByModel: [
          {
            model: "gpt-5.5",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.03,
          },
        ] as SyncedAgentSession["tokenUsageByModel"],
      }),
      listItem: buildMinimalListItem({ primaryModel: "gpt-5.5" }),
      events: [],
      truncation: {},
    });
    assert.deepEqual(result.models, ["gpt-5.5"]);
  });
});

describe("ISS-7895: desktop list omits models", () => {
  // davetho review: the LIST path had no assertion of its own, so restoring
  // the deleted `models: toSingleModelList(primaryModel)` in
  // `buildLocalSessionIdentity` would have passed every detail regression
  // above. These drive the list mapper and the list READ, both of which serve a
  // session that DOES declare a model — so a reinstated declared-model fallback
  // is the thing that fails them.
  test("mapListItem omits the key for a session that declares a model", () => {
    const declared = session({ id: "session-a" });
    assert.equal(declared.model, "gpt-test");

    const item = mapListItem(declared);

    assert.equal("models" in item, false);
    assert.equal(item.primaryModel, "gpt-test");
  });

  test("the list read serves no models key on any row", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
    });

    const response = await getSharedAgentSessions(source, { limit: 10 });

    assert.ok(response.items.length > 0);
    for (const item of response.items) {
      assert.equal("models" in item, false);
    }
  });
});
