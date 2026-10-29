/**
 * @file agent-dashboard-ipc-contract-coverage.test.ts
 * @description ISS-10514: the disabled Agent Dashboard responders for the
 * channels `agent-dashboard-disabled-ipc.test.ts` does not reach. Each case
 * installs the real responders through `installDisabledAgentDashboardDbIpcHandlers`
 * over the shared `ipcMain` double and asserts the exact neutral value a
 * renderer receives while the runtime is disabled.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { installDisabledAgentDashboardDbIpcHandlers } from "../src/main/dashboard/agent-dashboard-ipc-contract.js";
import {
  emptyAgentComponentsListResponse,
  emptyAgentComponentsPageDataResponse,
} from "../src/shared/shared-agent-components-contract.js";
import {
  emptySharedAgentSessionsPageDataResponse,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
} from "../src/shared/shared-agent-sessions-contract.js";
import {
  emptySharedBranchesPageDataResponse,
  SHARED_BRANCHES_IPC_CHANNELS,
} from "../src/shared/shared-branches-contract.js";
import { createIpcRegistrar } from "./helpers/ipc-registrar.js";

const DISABLED_MESSAGE = "Agent Dashboard is disabled in Settings.";

const EMPTY_TOKEN_ANALYTICS = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  windowDays: 0,
  byModel: [],
  byDay: [],
};

function installed(): (channel: string, ...args: unknown[]) => unknown {
  const harness = createIpcRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(harness.registrar);
  return (channel, ...args) => harness.invoke(channel, undefined, ...args);
}

describe("disabled Agent Dashboard DB responders", () => {
  it("summary and analytics reads answer zeroed shapes", () => {
    const invoke = installed();
    expect(invoke("desktop:db:get-dashboard-summary")).toEqual({
      totalSessions: 0,
      activeSessions: 0,
      totalAgents: 0,
      totalEvents: 0,
      eventTypeCount: 0,
      totalTokens: 0,
      recentSessions: [],
    });
    expect(invoke("desktop:db:get-token-analytics")).toEqual(
      EMPTY_TOKEN_ANALYTICS
    );
    expect(invoke("desktop:db:get-analytics")).toEqual({
      tokens: EMPTY_TOKEN_ANALYTICS,
      eventsByType: [],
      toolUsage: [],
      dailyEvents: [],
      sessionsByStatus: [],
      agentsByStatus: [],
      agentsByType: [],
      totalSessions: 0,
      totalAgents: 0,
      totalEvents: 0,
    });
    expect(invoke("desktop:db:get-pr-stats")).toEqual({
      totalPrs: 0,
      sessionsWithPrs: 0,
      repos: 0,
    });
  });

  it("workflow and core-feature reads answer empty collections", () => {
    const invoke = installed();
    expect(invoke("desktop:db:get-workflow-data")).toEqual({
      stats: {
        totalSessions: 0,
        totalAgents: 0,
        totalSubagents: 0,
        avgSubagents: 0,
        successRate: 0,
        avgDepth: 0,
        avgDurationSec: 0,
        totalCompactions: 0,
        avgCompactions: 0,
      },
      orchestration: {
        sessionCount: 0,
        mainCount: 0,
        subagentTypes: [],
        outcomes: [],
        compactions: { total: 0, sessions: 0 },
      },
      effectiveness: [],
    });
    expect(invoke("desktop:db:get-core-features")).toEqual({
      packs: [],
      skills: [],
      tools: [],
      subagents: [],
      plans: [],
      pullRequests: [],
    });
  });

  it("single-record reads fail closed as not-found", () => {
    const invoke = installed();
    expect(invoke("desktop:db:get-session", "id")).toBeUndefined();
    expect(invoke("desktop:db:get-session-details", "id")).toBeUndefined();
    for (const channel of [
      "desktop:db:get-catalog-entry",
      "desktop:db:get-catalog-contents",
      "desktop:db:get-plan",
      "desktop:db:get-agent-component-detail",
    ]) {
      expect(invoke(channel, "id")).toBeNull();
    }
  });

  it("install and uninstall report a not-started disabled mutation", () => {
    const invoke = installed();
    const disabled = {
      started: false,
      error: { code: "AGENT_DASHBOARD_DISABLED", message: DISABLED_MESSAGE },
    };
    expect(invoke("desktop:db:catalog-install", "pack", "claude")).toEqual(
      disabled
    );
    expect(invoke("desktop:db:catalog-uninstall", "pack", "claude")).toEqual(
      disabled
    );
  });

  it("fire-and-forget writes and opens answer undefined", () => {
    const invoke = installed();
    for (const channel of [
      "desktop:db:catalog-refresh",
      "desktop:db:confirm-plan",
      "desktop:db:reject-plan",
      "desktop:db:open-plan",
      "desktop:db:open-pr",
    ]) {
      expect(invoke(channel, "id")).toBeUndefined();
    }
  });

  it("diagnostics and optimization analytics answer empty shapes", () => {
    const invoke = installed();
    expect(invoke("desktop:db:get-diagnostics")).toEqual({
      repos: [],
      backfill: {
        artifactLinks: { totalScanned: 0, lastScannedAt: null },
      },
      linkStats: [],
      linkTotals: { totalLinks: 0, linkedSessions: 0, linkedArtifacts: 0 },
    });
    expect(invoke("desktop:db:get-component-model-trend")).toEqual({
      componentKind: "",
      componentKey: "",
      windowDays: 0,
      points: [],
    });
    expect(invoke("desktop:db:get-subagent-frequency")).toEqual({
      subagentKey: "",
      windowDays: 0,
      points: [],
    });
    expect(invoke("desktop:db:is-skill-loaded")).toEqual({
      skillKey: "",
      existsInInventory: false,
      hasUsage: false,
      totalInvocations: 0,
      lastUsedAt: null,
    });
    expect(invoke("desktop:db:list-agent-components")).toEqual(
      emptyAgentComponentsListResponse()
    );
    expect(invoke("desktop:db:get-agent-components-page-data")).toEqual(
      emptyAgentComponentsPageDataResponse()
    );
  });

  it("shared page-data reads answer the canonical empty page and cancel reports nothing forwarded", () => {
    const invoke = installed();
    expect(invoke(SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData)).toEqual(
      emptySharedAgentSessionsPageDataResponse()
    );
    expect(invoke(SHARED_AGENT_SESSIONS_IPC_CHANNELS.cancelRead)).toEqual({
      requested: false,
    });
    expect(invoke(SHARED_BRANCHES_IPC_CHANNELS.pageData)).toEqual(
      emptySharedBranchesPageDataResponse()
    );
  });

  it("the sessions page defaults its window when the request is missing or partial", () => {
    const invoke = installed();
    const defaultPage = { sessions: [], total: 0, limit: 25, offset: 0 };
    expect(invoke("desktop:db:get-sessions-page")).toEqual(defaultPage);
    expect(invoke("desktop:db:get-sessions-page", "request")).toEqual(
      defaultPage
    );
    expect(invoke("desktop:db:get-sessions-page", {})).toEqual(defaultPage);
  });

  it("kanban pages answer {} for non-array statuses and default a non-number limit", () => {
    const invoke = installed();
    expect(
      invoke("desktop:db:get-kanban-pages", SESSION_STATUS.ACTIVE, 10)
    ).toEqual({});
    expect(
      invoke("desktop:db:get-kanban-pages", [SESSION_STATUS.ACTIVE], "10")
    ).toEqual({
      [SESSION_STATUS.ACTIVE]: { sessions: [], total: 0, limit: 25, offset: 0 },
    });
  });
});
