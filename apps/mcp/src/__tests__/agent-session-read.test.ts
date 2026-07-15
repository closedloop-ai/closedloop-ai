import { describe, expect, it } from "vitest";
import {
  buildAgentSessionListQuery,
  shapeAgentSessionListItem,
} from "../tools/agent-session-read.js";

describe("buildAgentSessionListQuery", () => {
  it("maps provided filters and stringifies pagination params", () => {
    expect(
      buildAgentSessionListQuery({
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        harness: "claude-code",
        status: "completed",
        viewerScope: "organization",
        limit: 50,
        offset: 25,
      })
    ).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      harness: "claude-code",
      status: "completed",
      viewerScope: "organization",
      limit: "50",
      offset: "25",
    });
  });

  it("maps teamId + userId for scoped queries", () => {
    expect(
      buildAgentSessionListQuery({
        viewerScope: "team",
        teamId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      })
    ).toEqual({
      viewerScope: "team",
      teamId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("keeps a zero offset instead of dropping it as undefined", () => {
    expect(buildAgentSessionListQuery({ offset: 0 })).toEqual({ offset: "0" });
  });

  it("drops undefined filters and returns an empty query when nothing is set", () => {
    expect(buildAgentSessionListQuery({ harness: "codex" })).toEqual({
      harness: "codex",
    });
    expect(buildAgentSessionListQuery({})).toEqual({});
  });
});

describe("shapeAgentSessionListItem", () => {
  it("projects the identifiers and core run metadata", () => {
    const shaped = shapeAgentSessionListItem({
      id: "33333333-3333-3333-3333-333333333333",
      slug: "SES-42",
      externalSessionId: "ext-abc",
      name: "Fix flaky test",
      status: "completed",
      harness: "claude-code",
      model: "claude-opus-4",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      baseBranch: "main",
      startedAt: "2026-07-10T00:00:00.000Z",
      lastActivityAt: "2026-07-10T01:00:00.000Z",
      endedAt: "2026-07-10T01:05:00.000Z",
      estimatedCost: 1.23,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      agentCount: 2,
      toolUseCount: 9,
      errorCount: 0,
      sourceArtifactId: "44444444-4444-4444-4444-444444444444",
      sourceLoopId: "55555555-5555-5555-5555-555555555555",
      user: {
        id: "66666666-6666-6666-6666-666666666666",
        email: "dev@example.com",
        firstName: "Dev",
        lastName: "Eloper",
        avatarUrl: "https://example.com/a.png",
      },
      // Fields intentionally omitted from the compact projection.
      events: [{ type: "noise" }],
    });

    expect(shaped).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      slug: "SES-42",
      externalSessionId: "ext-abc",
      name: "Fix flaky test",
      status: "completed",
      harness: "claude-code",
      model: "claude-opus-4",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      baseBranch: "main",
      startedAt: "2026-07-10T00:00:00.000Z",
      lastActivityAt: "2026-07-10T01:00:00.000Z",
      endedAt: "2026-07-10T01:05:00.000Z",
      estimatedCost: 1.23,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      agentCount: 2,
      toolUseCount: 9,
      errorCount: 0,
      sourceArtifactId: "44444444-4444-4444-4444-444444444444",
      sourceLoopId: "55555555-5555-5555-5555-555555555555",
      user: {
        id: "66666666-6666-6666-6666-666666666666",
        email: "dev@example.com",
        firstName: "Dev",
        lastName: "Eloper",
      },
    });
  });

  it("nulls absent fields and keeps user null when the row has no user", () => {
    const shaped = shapeAgentSessionListItem({
      id: "77777777-7777-7777-7777-777777777777",
      status: "running",
      harness: "codex",
      user: null,
    });

    expect(shaped.slug).toBeNull();
    expect(shaped.model).toBeNull();
    expect(shaped.endedAt).toBeNull();
    expect(shaped.estimatedCost).toBeNull();
    expect(shaped.user).toBeNull();
  });
});
