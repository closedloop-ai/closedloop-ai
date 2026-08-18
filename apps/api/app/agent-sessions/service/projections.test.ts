import {
  AgentSessionState,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { DocumentType, PullRequestState } from "@repo/api/src/types/document";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  buildPersistedAgent,
  buildSessionDetailRecord,
  buildSessionListRecord,
  buildSourceArtifactRecord,
  installDb,
  SESSION_STARTED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { MAIN_FILE_KEY } from "../transcript-availability";
import { SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS } from "./records";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
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
              status: SESSION_STATUS.INACTIVE,
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
      status: SESSION_STATUS.INACTIVE,
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
  /* FEA-4301 (thread #1): the served `status` is the DISPLAYED status — a row
     awaiting input stores `active` but must serve `waiting` so the Status badge,
     the Status sort (`compareByDisplayedStatus`), and the WAITING facet filter all
     agree. Serving the raw `active` made the badge read "Active" for a row the
     sort grouped under Waiting. */
  it("serves the projected Waiting status for an awaiting-input row (stored active)", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            awaitingInputSince: new Date("2026-05-20T17:03:00.000Z"),
            sessionEndedAt: null,
            artifact: {
              name: "Awaiting Session",
              status: SESSION_STATUS.ACTIVE,
              slug: "SES-WAIT",
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

    expect(result.items[0]?.status).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });
  it("serves the raw status for an awaiting-input row that has ended (no Waiting projection)", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            awaitingInputSince: new Date("2026-05-20T17:03:00.000Z"),
            sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
            artifact: {
              name: "Ended Awaiting Session",
              status: SESSION_STATUS.INACTIVE,
              slug: "SES-ENDED-WAIT",
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

    expect(result.items[0]?.status).toBe(SESSION_STATUS.INACTIVE);
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
  /*
   * ISS-4586: `inactive` is the terminal-not-failed LIFECYCLE state, and this
   * projection is the OUTCOME the detail page reports — a finished-not-failed
   * run IS `Completed` in outcome terms. ISS-4654 resolved that a dedicated
   * `AgentSessionState.Inactive` is NOT NEEDED (2026-08-08), so this mapping is
   * the intended answer and not a placeholder awaiting one. Do not "finish" it
   * by adding a member. (The list/detail wording divergence it produces is real
   * and tracked separately on ISS-5695; it is not fixed by changing this map.)
   */
  it("classifies an inactive session as Completed", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            artifact: {
              name: "Inactive Session",
              status: SESSION_STATUS.INACTIVE,
              slug: "SES-INACTIVE",
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
  /* This pair once contrasted an abandoned session WITH a merged PR against one
   * WITHOUT, because FEA-3551 rescued the first to Completed. ISS-4654 made the
   * PR signal stop deciding the outcome and ISS-6588 removed it entirely, so the
   * two cases no longer contrast — both read Completed because the row ENDED.
   * They are kept as end-to-end coverage that a straggler spelling still
   * projects a terminal outcome through the real list read, not as a pairing;
   * `prsMerged` remains asserted because it is still a projected list field. */
  // FEA-4287: a terminal ERROR session preserves the Error outcome instead of
  // collapsing to Blocked. The Sessions LIST renders the raw `error` status as
  // "Failed"; the detail projection must carry the matching terminal state so
  // list and detail never disagree. A PR does NOT rescue an errored run.
  it("keeps an errored session as Error (not Blocked), even with a merged PR", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            artifact: {
              name: "Errored but shipped",
              status: SESSION_STATUS.ERROR,
              slug: "SES-ERR",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    linkKind: "session_pr",
                    relationTypes: [SessionPrRelationType.Created],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    prNumber: 4287,
                    source: "DETERMINISTIC",
                    confidence: 1.0,
                    extractorVersion: 1,
                  },
                  target: {
                    name: "errored-session/head-ref",
                    branch: {
                      repository: {
                        fullName: "closedloop-ai/symphony-alpha",
                      },
                      currentPullRequestDetail: {
                        number: 4287,
                        title: "Shipped PR",
                        prState: PullRequestState.Merged,
                        closedAt: null,
                        mergedAt: new Date("2026-07-20T02:10:11.000Z"),
                        lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
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

    expect(result.items[0]?.status).toBe(SESSION_STATUS.ERROR);
    expect(result.items[0]?.prsMerged).toBe(1);
    expect(result.items[0]?.state).toBe(AgentSessionState.Error);
  });
  // FEA-4287: a genuinely nonterminal blocked session still reads as Blocked —
  // the persisted workflow state passes through unchanged and is NOT a terminal
  // status, so the ERROR/ABANDONED split does not touch it.
  it("keeps a genuinely blocked (nonterminal) session as Blocked", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: AgentSessionState.Blocked,
            pullRequests: [],
            artifact: {
              name: "Blocked in-flight",
              status: DISPLAYED_SESSION_STATUS.WAITING,
              slug: "SES-BLK",
              project: null,
              sourceLinks: [],
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

    expect(result.items[0]?.state).toBe(AgentSessionState.Blocked);
  });
  // FEA-3635: a session whose transcript referenced/created a FEAT resolves to a
  // RELATES_TO link to a DOCUMENT-typed target (slug-links.ts). The projection
  // surfaces it as a `linkedArtifacts` entry — slug + name + derived documentType
  // + role — parallel to the PR lane, without disturbing `prs`.
  it("projects a session→FEAT link into linkedArtifacts", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Planning session",
              status: SESSION_STATUS.INACTIVE,
              slug: "SES-FEAT",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    role: "input",
                    method: "mcp_tool_call",
                    isPrimary: false,
                  },
                  target: {
                    id: "feat-artifact-1",
                    name: "Pack-scanner worker",
                    slug: "FEA-3628",
                    type: "DOCUMENT",
                    subtype: DocumentType.Feature,
                    branch: null,
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

    expect(result.items[0]?.linkedArtifacts).toEqual([
      {
        id: "feat-artifact-1",
        slug: "FEA-3628",
        name: "Pack-scanner worker",
        documentType: DocumentType.Feature,
        role: "input",
      },
    ]);
    // The FEAT link does not leak into the PR lane.
    expect(result.items[0]?.prs).toEqual([]);
  });
  // FEA-3949: a session linked to a DOC-subtype DOCUMENT target must derive a
  // clickable documentType so the linked-artifact pill routes; a null here would
  // drop the source link and make the DOC pill non-clickable on session detail.
  it("derives documentType for a session→DOC link", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Doc session",
              status: SESSION_STATUS.INACTIVE,
              slug: "SES-DOC",
              project: null,
              sourceLinks: [
                {
                  metadata: {
                    role: "input",
                    method: "mcp_tool_call",
                    isPrimary: false,
                  },
                  target: {
                    id: "doc-artifact-1",
                    name: "Runbook",
                    slug: "DOC-1",
                    type: "DOCUMENT",
                    subtype: DocumentType.Doc,
                    branch: null,
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

    expect(result.items[0]?.linkedArtifacts).toEqual([
      {
        id: "doc-artifact-1",
        slug: "DOC-1",
        name: "Runbook",
        documentType: DocumentType.Doc,
        role: "input",
      },
    ]);
  });
  // FEA-3635: a session that referenced no FEAT surfaces no linked artifacts, so
  // the detail renders nothing extra.
  it("returns an empty linkedArtifacts list when no artifact links exist", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "No-links session",
              status: SESSION_STATUS.INACTIVE,
              slug: "SES-NOLINK",
              project: null,
              sourceLinks: [],
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

    expect(result.items[0]?.linkedArtifacts).toEqual([]);
  });
  it("passes billingMode through for subscription sessions", async () => {
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildSessionListRecord({ billingMode: "max_5x" }),
          ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.billingMode).toBe("max_5x");
  });
  it("projects null billingMode when the record has no billing mode", async () => {
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([buildSessionListRecord({ billingMode: null })]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.billingMode).toBeNull();
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
          events: expect.objectContaining({
            orderBy: [
              { eventCreatedAt: "asc" },
              { externalEventId: "asc" },
              { id: "asc" },
            ],
          }),
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
  it("derives the per-phase activitySegments from the raw tiling + token events (FEA-2275)", async () => {
    const planStart = new Date("2026-05-20T00:00:00.000Z");
    const implementStart = new Date("2026-05-20T01:00:00.000Z");
    const sessionEnd = new Date("2026-05-20T02:00:00.000Z");
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        state: AgentSessionState.Completed,
        artifact: {
          organizationId: "org-1",
          name: "Session One",
          status: SESSION_STATUS.INACTIVE,
          slug: "SES-1",
          project: null,
        },
        // Two contiguous phase rows; declared vs structural provenance.
        activitySegmentRows: [
          {
            phase: "plan",
            startMs: planStart.getTime(),
            endMs: implementStart.getTime(),
            confidence: 0.9,
            evidenceLayers: ["declared"],
            classifierVersion: 1,
            workItemRef: null,
            subagentId: null,
          },
          {
            phase: "implement",
            startMs: implementStart.getTime(),
            endMs: sessionEnd.getTime(),
            confidence: 0.6,
            evidenceLayers: ["structural"],
            classifierVersion: 1,
            workItemRef: null,
            subagentId: null,
          },
        ],
        // One priced event per phase span; the projection coerces Prisma values.
        tokenEvents: [
          {
            eventCreatedAt: new Date("2026-05-20T00:30:00.000Z"),
            estimatedCost: 0.1,
            costCompleteness: TokenCostCompleteness.Complete,
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 5,
            cacheWriteTokens: 0,
          },
          {
            eventCreatedAt: new Date("2026-05-20T01:30:00.000Z"),
            estimatedCost: 0.2,
            costCompleteness: TokenCostCompleteness.Complete,
            inputTokens: 400,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 20,
          },
        ],
      })
    );

    installDb({ sessionDetail: { findFirst } });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // The widened select pulls token counts for the per-phase breakdown.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          tokenEvents: expect.objectContaining({
            select: expect.objectContaining({
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
            }),
          }),
        }),
      })
    );

    const segments = result?.activitySegments ?? [];
    expect(segments.map((s) => s.key)).toEqual(["plan", "implement"]);
    const plan = segments.find((s) => s.key === "plan");
    const implement = segments.find((s) => s.key === "implement");
    expect(plan).toMatchObject({
      costUsd: 0.1,
      inputTokens: 100,
      source: "explicit",
    });
    expect(implement).toMatchObject({
      costUsd: 0.2,
      inputTokens: 400,
      source: "loop_perf",
    });
    const segmentCost = segments.reduce((sum, s) => sum + s.costUsd, 0);
    expect(segmentCost).toBeCloseTo(result?.estimatedCost ?? 0, 10);
  });
  it("omits priced activitySegments when the token-event query is capped, leaving activitySegmentRows for the renderer (FEA-2275 / ISS-4446)", async () => {
    /* At the cap the per-event sum is truncated, so shipping a per-phase COST
     * built from it would under-report and diverge from the cap-aware
     * estimatedCost. The priced breakdown is therefore omitted. It is NOT
     * replaced by a single unclassified segment: the raw activitySegmentRows
     * still ship, so the renderer re-derives the per-phase breakdown from the
     * tiling with cost marked unavailable (ISS-4446: cost-unavailable ≠
     * no-attribution), agreeing with the Activity phases strip. */
    const cappedEvents = Array.from(
      { length: SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS },
      (_unused, index) => ({
        eventCreatedAt: new Date(2_000_000_000_000 + index),
        estimatedCost: 0.001,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    );
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        state: AgentSessionState.Completed,
        estimatedCost: 0.25,
        artifact: {
          organizationId: "org-1",
          name: "Session One",
          status: SESSION_STATUS.INACTIVE,
          slug: "SES-1",
          project: null,
        },
        activitySegmentRows: [
          {
            phase: "implement",
            startMs: 0,
            endMs: 10 ** 13,
            confidence: 0.9,
            evidenceLayers: ["structural"],
            classifierVersion: 1,
            workItemRef: null,
            subagentId: null,
          },
        ],
        tokenEvents: cappedEvents,
      })
    );

    installDb({ sessionDetail: { findFirst } });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // Priced segments omitted (not a truncated under-report); the raw rows
    // remain so the renderer shows the cost-unavailable per-phase breakdown.
    expect(result?.activitySegments).toBeUndefined();
    expect(result?.activitySegmentRows?.length).toBeGreaterThan(0);
    // estimatedCost falls back to the stored rollup, not the truncated $10 sum.
    expect(result?.estimatedCost).toBe(0.25);
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
        // FEA-3345: idle-count is computed only on an explicit `substantive`
        // (the fail-open default `all` hides nothing → idleCount 0). Pass it so
        // this test still exercises the source-artifact projection with a
        // non-zero idle count.
        filters: { quality: "substantive" },
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
      // FEA-3284/FEA-3345: the shared count mock returns 1 for both the list total
      // and the scoped idle count; an explicit `substantive` computes the latter.
      idleCount: 1,
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

  it("threads the per-session transcript disposition onto list rows (PRD-536 G1 Phase 3)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildSessionListRecord()]);
    const count = vi.fn().mockResolvedValue(0);
    // The page-wide transcript batch: a stale main transcript for this session's
    // identity (externalSessionId "external-session-1" on computeTarget
    // "target-1"). Uploaded, then a newer fingerprint observed → `stale`.
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: new Date("2026-05-20T17:00:00.000Z"),
        lastObservedAt: new Date("2026-05-20T17:05:00.000Z"),
        permanentFailureReason: null,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const response = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // The row carries the batched verdict, so the shared list-row affordance can
    // render "Stale · Last synced …" without a per-row detail fetch.
    expect(response.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.Stale
    );
    // The batch is scoped to the page's exact (computeTargetId,
    // externalSessionId) identities within the org — a set of composite
    // predicates so Postgres can use the (computeTargetId, externalSessionId,
    // fileKey) unique index rather than scanning the org's whole transcript
    // history on every list response (codex P2, PR #3457).
    expect(transcriptFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        OR: [
          {
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
          },
        ],
      },
      select: expect.objectContaining({
        fileKey: true,
        computeTargetId: true,
        externalSessionId: true,
      }),
    });
  });

  it("synthesizes transcriptDisposition `syncing` on a list row with no transcript rows (ISS-4621 list↔detail parity)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildSessionListRecord()]);
    const count = vi.fn().mockResolvedValue(0);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      // Default empty transcript batch: the session has no rows yet.
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const response = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // ISS-4621: a session always expects a `main` transcript (PRD AC6), so a
    // requested identity with zero rows synthesizes `syncing` — matching the
    // detail path, which synthesizes a `missing` main → `syncing`. Omitting it
    // here (the prior behavior) made the list read `synced` while detail read
    // `pending` for the same zero-transcript session.
    expect(response.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.Syncing
    );
  });

  it("does NOT report cloudSyncState synced when the required transcript blob is still syncing (ISS-4621, SES-78221 shape)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildSessionListRecord()]);
    const count = vi.fn().mockResolvedValue(0);
    // SES-78221 repro: full derived data on the session, but the `main`
    // transcript blob never uploaded — a `pending` upload with no `uploadedAt`,
    // which the availability derivation folds to `uploadPending` → the session
    // disposition `syncing`. The derived-data lane is synced (the row exists in
    // the cloud DB), but the blob lane is NOT, so the aggregate must be `pending`,
    // not a false `synced`.
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Pending,
        uploadedAt: null,
        lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
        permanentFailureReason: null,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const response = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // The blob lane is behind ⇒ the row must NOT claim `synced`.
    expect(response.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.Syncing
    );
    expect(response.items[0]?.cloudSyncState).toBe(
      AgentSessionCloudSyncState.Pending
    );
  });

  it("reports cloudSyncState pending while the transcript blob is between retry attempts (ISS-4621, failed upload)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildSessionListRecord()]);
    const count = vi.fn().mockResolvedValue(0);
    // A `failed` upload is the RETRYABLE verdict — the desktop re-queues with
    // backoff, so the blob is still expected and not yet in the cloud. The row
    // must read `pending` (cloud copy behind), same as the `syncing` case above;
    // only `transcriptDisposition` carries the failure detail.
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Failed,
        uploadedAt: null,
        lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
        permanentFailureReason: null,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const response = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedTransient
    );
    expect(response.items[0]?.cloudSyncState).toBe(
      AgentSessionCloudSyncState.Pending
    );
  });

  it("reports cloudSyncState synced when the transcript blob is uploaded and current (ISS-4621)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildSessionListRecord()]);
    const count = vi.fn().mockResolvedValue(0);
    // A caught-up `main` blob: uploaded, no newer fingerprint ⇒ `available` →
    // disposition `synced`. Both lanes are caught up, so the row is truthfully
    // `synced`. This also guards the mutation: were the derivation reverted to a
    // hardcoded `synced`, the `syncing` case above would wrongly pass while this
    // one still would — so the two cases together pin the reconciliation.
    const transcriptFindMany = vi.fn().mockResolvedValue([
      {
        fileKey: MAIN_FILE_KEY,
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: new Date("2026-07-28T22:11:00.000Z"),
        lastObservedAt: new Date("2026-07-28T22:11:00.000Z"),
        permanentFailureReason: null,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
      },
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      sessionTranscript: { findMany: transcriptFindMany },
    });

    const response = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.Synced
    );
    expect(response.items[0]?.cloudSyncState).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });

  it("reports cloudSyncState `pending` when the session has no transcript rows (ISS-4621 list↔detail parity: main is always expected)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildSessionListRecord()]);
    const count = vi.fn().mockResolvedValue(0);

    installDb({
      sessionDetail: buildAgentSessionDbMock({ findMany, count }),
      // No transcript rows ⇒ the list path synthesizes a `syncing` verdict for the
      // requested identity (a `main` transcript is always expected), matching the
      // detail path's synthesized `missing` main. The blob lane is behind, so the
      // aggregate is `pending` — the same value detail reports for this session,
      // instead of the prior list-only false `synced`.
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const response = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items[0]?.transcriptDisposition).toBe(
      TranscriptDisposition.Syncing
    );
    expect(response.items[0]?.cloudSyncState).toBe(
      AgentSessionCloudSyncState.Pending
    );
  });
});
