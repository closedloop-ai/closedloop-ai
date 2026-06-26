import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "../session-table-row";

const NOW = new Date("2026-06-17T12:00:00.000Z");

describe("resolveSessionRepoLabel", () => {
  it("prefers the remote repositoryFullName", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: "closedloop-ai/symphony-alpha",
          cwd: "/Users/dev/symphony-alpha",
          worktreePath: "/Users/dev/symphony-alpha-wt",
        })
      )
    ).toBe("closedloop-ai/symphony-alpha");
  });

  it("falls back to the cwd folder name when there is no remote", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          cwd: "/Users/dev/Dev/symphony-alpha",
          worktreePath: "/Users/dev/Dev/symphony-alpha-wt",
        })
      )
    ).toBe("symphony-alpha");
  });

  it("falls back to the worktree folder name when cwd is absent", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          cwd: null,
          worktreePath: "/Users/dev/Dev/symphony-alpha-wt",
        })
      )
    ).toBe("symphony-alpha-wt");
  });

  it("handles Windows-style backslash paths", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          cwd: "C:\\Users\\dev\\symphony-alpha",
          worktreePath: null,
        })
      )
    ).toBe("symphony-alpha");
  });

  it("returns null when no repository identity is available", () => {
    expect(
      resolveSessionRepoLabel(
        createAgentSessionListItemFixture({
          repositoryFullName: null,
          cwd: null,
          worktreePath: null,
        })
      )
    ).toBeNull();
  });
});

describe("agentSessionToSessionTableRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps Started and Last active labels through app local-time helpers", () => {
    const row = agentSessionToSessionTableRow(sessionListItem(), "owner/repo");

    expect(row.startedLabel).toBe("Yesterday");
    expect(row.lastActivityLabel).toBe("3 hours ago");
    expect(row.repo).toBe("owner/repo");
  });

  it("renders placeholders for invalid or missing session timestamps", () => {
    const row = agentSessionToSessionTableRow(
      sessionListItem({
        startedAt: new Date("not-a-date"),
        lastActivityAt: new Date("not-a-date"),
      }),
      null
    );

    expect(row.startedLabel).toBe("—");
    expect(row.lastActivityLabel).toBe("—");
    expect(row.durationLabel).toBe("-");
  });
});

function sessionListItem(
  overrides: Partial<AgentSessionListItem> = {}
): AgentSessionListItem {
  return {
    id: "session-1",
    slug: "SES-1",
    externalSessionId: "external-session-1",
    name: "Implement local timestamps",
    status: "completed",
    harness: "codex",
    cwd: "/repo",
    repositoryFullName: "owner/repo",
    worktreePath: "/repo",
    model: "gpt-5.5",
    branch: "fea-2097",
    autonomy: null,
    startedAt: new Date("2026-06-16T10:00:00.000Z"),
    updatedAt: new Date("2026-06-17T09:00:00.000Z"),
    lastActivityAt: new Date("2026-06-17T09:00:00.000Z"),
    endedAt: new Date("2026-06-17T09:30:00.000Z"),
    awaitingInputSince: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    agentCount: 1,
    toolUseCount: 0,
    errorCount: 0,
    issueId: null,
    baseBranch: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    user: null,
    computeTarget: {
      id: "target-1",
      machineName: "Local Desktop",
      isOnline: true,
      lastSeenAt: NOW,
    },
    project: null,
    ...overrides,
  };
}
