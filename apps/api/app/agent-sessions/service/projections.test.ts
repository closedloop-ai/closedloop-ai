import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { SessionPrLifecycleStatus } from "@repo/api/src/session-trace/derivation";
import {
  AgentSessionState,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { DocumentType, PullRequestState } from "@repo/api/src/types/document";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../service";
import {
  buildAgentSessionDbMock,
  buildPersistedAgent,
  buildSessionDetailRecord,
  buildSessionListRecord,
  buildSourceArtifactRecord,
  installDb,
  SESSION_STARTED_AT,
} from "../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects manual state separately from legacy status and origin", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: AgentSessionState.InReview,
            origin: "LOOP",
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]).toMatchObject({
      status: "completed",
      origin: "LOOP",
      state: AgentSessionState.InReview,
    });
  });
  it("falls back to a conservative state for old rows without mutating storage", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            awaitingInputSince: new Date("2026-05-20T17:03:00.000Z"),
            sessionEndedAt: null,
            artifact: {
              name: "Waiting Session",
              status: "waiting",
              slug: "SES-2",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.state).toBe(AgentSessionState.PendingApproval);
  });
  it("treats ended old rows with stale active status as completed", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            awaitingInputSince: null,
            sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
            artifact: {
              name: "Ended Session",
              status: "active",
              slug: "SES-3",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.state).toBe(AgentSessionState.Completed);
  });
  it("deduplicates legacy pull request JSON when a trusted session PR link exists", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: "session_pr",
                    relationTypes: [SessionPrRelationType.Referenced],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Trusted title",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                        lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Trusted title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });
  it("downgrades legacy-only merged pull requests to unknown list state", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Legacy title",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  it("deduplicates repository-less legacy pull request JSON when a trusted session PR link exists", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            repositoryFullName: null,
            pullRequests: [
              {
                num: 17,
                title: "Repository-less legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: "session_pr",
                    relationTypes: [SessionPrRelationType.Referenced],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Trusted title",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                        lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Trusted title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });
  it("keeps current pull request details unknown until they have verification freshness", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: "session_pr",
                    relationTypes: [SessionPrRelationType.Referenced],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Unverified title",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                        lastVerifiedAt: null,
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "PR #17",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  it("downgrades legacy merged pull request status when linked details are unverified", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: "session_pr",
                    relationTypes: [SessionPrRelationType.Referenced],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 17,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 17,
                        title: "Unverified title",
                        prState: PullRequestState.Open,
                        closedAt: null,
                        mergedAt: null,
                        lastVerifiedAt: null,
                        isCurrent: true,
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Legacy title",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });
  it("projects detail events with deterministic ordering and useful tool details", async () => {
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        state: AgentSessionState.Running,
        artifact: {
          // Org SSOT asserted by the by-id session read (FEA-2734).
          organizationId: "org-1",
          name: "Session One",
          status: SESSION_STATUS.ACTIVE,
          slug: "SES-1",
          project: null,
        },
        events: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            externalEventId: "event-b",
            agentExternalId: "agent-1",
            eventType: "human_prompt",
            toolName: null,
            summary: null,
            data: { prompt: "secret prompt", filePath: "prompts/task.md" },
            eventCreatedAt: SESSION_STARTED_AT,
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            externalEventId: "event-c",
            agentExternalId: "agent-1",
            eventType: "tool_use",
            toolName: "Read",
            summary: "secret summary",
            data: {
              filePath: "src/safe.ts",
              output: "secret output",
              tool_response: {
                stdout: "secret stdout",
                status: "success",
              },
            },
            eventCreatedAt: SESSION_STARTED_AT,
          },
        ],
      })
    );

    installDb({
      sessionDetail: { findFirst },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          events: {
            orderBy: [
              { eventCreatedAt: "asc" },
              { externalEventId: "asc" },
              { id: "asc" },
            ],
          },
        }),
      })
    );
    // FEA-2718: the cloud read surfaces only retained event metadata — never
    // summary/data. Turn/tool detail comes from the archived transcript now, so
    // the projected events carry no raw content and the timeline carries no
    // data-derived detail.
    expect(result?.events).toEqual([
      expect.objectContaining({
        externalEventId: "event-b",
        eventType: "human_prompt",
        toolName: null,
      }),
      expect.objectContaining({
        externalEventId: "event-c",
        eventType: "tool_use",
        toolName: "Read",
      }),
    ]);
    for (const event of result?.events ?? []) {
      expect(Object.hasOwn(event, "summary")).toBe(false);
      expect(Object.hasOwn(event, "data")).toBe(false);
    }
    const serialized = JSON.stringify(result);
    for (const secret of [
      "secret prompt",
      "secret summary",
      "secret output",
      "secret stdout",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // The Read tool row carries no data-derived detail on the cloud read.
    expect(
      result?.timeline?.find((event) => event.title === "Read")?.detail
    ).toBeUndefined();
  });
  it("never surfaces turn text on the cloud read, even from a legacy row that still carries it", async () => {
    // FEA-2718 defense-in-depth: the summary/data columns are dropped, but a
    // stale in-memory row (or a mock) might still carry raw content. The read
    // maps ONLY the retained columns, so no turn/tool text can leak — there is
    // no longer any redaction step because the fields never reach the surface.
    const rawContentData = {
      filePath: "src/safe.ts",
      content: "file contents",
      new_string: "after edit",
      old_string: "before edit",
      output: "secret output",
      patch: "@@ diff @@",
      prompt: "secret prompt",
      reasoning: "chain of thought",
      stderr: "secret stderr",
      stdout: "secret stdout",
      text: "completion text",
    };
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        state: AgentSessionState.Running,
        artifact: {
          // Org SSOT asserted by the by-id session read (FEA-2734).
          organizationId: "org-1",
          name: "Session One",
          status: SESSION_STATUS.ACTIVE,
          slug: "SES-1",
          project: null,
        },
        events: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            externalEventId: "event-raw",
            agentExternalId: "agent-1",
            eventType: "tool_use",
            toolName: "Edit",
            summary: "legacy summary text",
            data: rawContentData,
            eventCreatedAt: SESSION_STARTED_AT,
          },
        ],
      })
    );

    installDb({
      sessionDetail: { findFirst },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.events?.[0]).toEqual(
      expect.objectContaining({
        externalEventId: "event-raw",
        eventType: "tool_use",
        toolName: "Edit",
      })
    );
    expect(Object.hasOwn(result?.events?.[0] ?? {}, "summary")).toBe(false);
    expect(Object.hasOwn(result?.events?.[0] ?? {}, "data")).toBe(false);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "legacy summary text",
      "file contents",
      "after edit",
      "before edit",
      "secret output",
      "@@ diff @@",
      "secret prompt",
      "chain of thought",
      "secret stderr",
      "secret stdout",
      "completion text",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
  it("projects detail metadata messages into timeline and turn rows", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            metadata: {
              kind: "fixture",
              messages: [
                {
                  role: "human",
                  timestamp: "2026-05-20T17:00:00.000Z",
                  text: "Please inspect the failing test.",
                },
                {
                  role: "assistant",
                  timestamp: "2026-05-20T17:01:00.000Z",
                  text: "I found the failing assertion.",
                  model: "gpt-5.5",
                },
                {
                  role: "human",
                  timestamp: "2026-05-20T17:02:00.000Z",
                },
              ],
            },
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(
      result?.timeline
        ?.slice(0, 3)
        .map((event) => [event.kind, event.title, event.detail])
    ).toEqual([
      ["human", "human", "Please inspect the failing test."],
      ["say", "gpt-5.5", "I found the failing assertion."],
      ["human", "human", undefined],
    ]);
    expect(
      result?.turnItems
        ?.slice(0, 3)
        .map((item) => [item.type, "text" in item ? item.text : null])
    ).toEqual([
      ["prompt", "Please inspect the failing test."],
      ["say", "I found the failing assertion."],
      ["prompt", ""],
    ]);
  });
  it("projects subagent agents into redaction-safe turn items", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            model: "gpt-5.5",
            agents: [
              buildPersistedAgent({
                externalAgentId: "agent-main",
                name: "Main worker",
                type: "main",
              }),
              buildPersistedAgent({
                externalAgentId: "agent-review",
                name: "Review lane",
                type: "subagent",
                subagentType: "review",
                status: "failed",
                task: "Check contract coverage.",
                startedAt: "2026-05-20T17:01:00.000Z",
                updatedAt: "2026-05-20T17:03:00.000Z",
                endedAt: "2026-05-20T17:03:00.000Z",
                parentExternalAgentId: "agent-main",
              }),
            ],
            events: [
              {
                id: "00000000-0000-0000-0000-000000000010",
                externalEventId: "event-subagent",
                agentExternalId: "agent-review",
                eventType: "tool_error",
                toolName: "vitest",
                summary: "raw subagent summary must not leak",
                data: { output: "secret subagent output" },
                eventCreatedAt: new Date("2026-05-20T17:02:00.000Z"),
              },
            ],
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    const subagentTurn = result?.turnItems?.find(
      (item) => item.type === "subagent"
    );
    expect(subagentTurn).toMatchObject({
      type: "subagent",
      sub: "Review lane",
      subagentType: "review",
      status: "failed",
      model: "gpt-5.5",
      duration: "2m",
      body: expect.arrayContaining([
        { kind: "task", text: "Check contract coverage." },
        {
          kind: "tool",
          text: "vitest",
          t: "2026-05-20T17:02:00.000Z",
          err: true,
        },
        {
          kind: "status",
          text: "failed",
          t: "2026-05-20T17:03:00.000Z",
          err: true,
        },
      ]),
    });
    expect(JSON.stringify(subagentTurn)).not.toContain(
      "secret subagent output"
    );
    expect(JSON.stringify(subagentTurn)).not.toContain("raw subagent summary");
  });
  it("falls back safely for malformed persisted trace JSON", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            pullRequests: [{ num: 1 }],
            activityBuckets: [{ label: "bad bucket" }],
            sessionSpan: { first: "00:00:00" },
            markers: [{ kind: "commit", x: 200 }],
            throttles: "not-json",
            phases: [{ key: "build" }],
            phaseIterations: { build: -1 },
            phaseLoopbacks: [{ from: "ship" }],
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result).toMatchObject({
      prs: [],
      activityBuckets: [],
      span: null,
      markers: [],
      throttles: [],
      phases: [],
      phaseIterations: {},
      phaseLoopbacks: [],
    });
  });
  it("includes source artifact metadata in session list responses", async () => {
    const findMany = vi.fn().mockResolvedValue([
      buildSessionListRecord({
        sourceArtifactId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
      }),
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const findArtifacts = vi
      .fn()
      .mockResolvedValue([buildSourceArtifactRecord()]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
      artifact: {
        findMany: findArtifacts,
      },
    });

    await expect(
      agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "session-1",
          sourceArtifactId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
          sourceArtifact: {
            id: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
            name: "Agent Platform PRD",
            slug: "agent-platform-prd",
            documentType: DocumentType.Prd,
          },
        }),
      ],
      total: 1,
      viewerScope: AgentSessionViewerScope.Organization,
    });

    expect(findArtifacts).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        id: { in: ["0196f2df-5b7d-7e72-9e4c-8d8af9fba001"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        subtype: true,
      },
    });
  });
});
