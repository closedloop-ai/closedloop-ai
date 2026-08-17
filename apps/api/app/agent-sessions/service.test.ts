import type { TurnItem } from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import {
  TranscriptAvailability,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { PullRequestState } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "./service";
import { SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS } from "./service/records";

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

  it("enriches the detail with per-file transcript availability summaries", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        fileKey: "main",
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
      },
      {
        fileKey: "subagent:a",
        uploadStatus: TranscriptUploadStatus.Pending,
        uploadedAt: null,
        lastObservedAt: SESSION_STARTED_AT,
      },
    ]);
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: { findMany },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // Scoped by session identity (org + computeTarget + externalSession), not
    // the nullable sessionDetailId FK.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          computeTargetId: "target-1",
          externalSessionId: "external-session-1",
        },
      })
    );
    // Summaries only — no signed URL is minted on the detail path.
    expect(result?.transcripts).toEqual([
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: SESSION_UPDATED_AT.toISOString(),
        permanentFailureReason: null,
      },
      {
        fileKey: "subagent:a",
        availability: TranscriptAvailability.UploadPending,
        uploadedAt: null,
        permanentFailureReason: null,
      },
    ]);
  });
  it("synthesizes a missing main summary when the session has only subagent transcripts", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "subagent:a",
            uploadStatus: TranscriptUploadStatus.Uploaded,
            uploadedAt: SESSION_UPDATED_AT,
            lastObservedAt: SESSION_UPDATED_AT,
          },
        ]),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcripts).toEqual([
      {
        fileKey: "main",
        availability: TranscriptAvailability.Missing,
        uploadedAt: null,
        permanentFailureReason: null,
      },
      {
        fileKey: "subagent:a",
        availability: TranscriptAvailability.Available,
        uploadedAt: SESSION_UPDATED_AT.toISOString(),
        permanentFailureReason: null,
      },
    ]);
  });

  // FEA-3479 (PRD-536 G1) AC-7: freshness + disposition are served on detail.
  it("serves lastSyncedAt, per-target lastAgentSessionSyncAt, and a syncing disposition while the main transcript uploads", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "main",
            uploadStatus: TranscriptUploadStatus.Uploading,
            uploadedAt: null,
            lastObservedAt: SESSION_STARTED_AT,
          },
        ]),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // Cloud upsert freshness (SessionDetail.lastSyncedAt) is now selected/served.
    expect(result?.lastSyncedAt).toEqual(SESSION_UPDATED_AT);
    // Per-target sync freshness is served at the row level (not just usage).
    expect(result?.computeTarget.lastAgentSessionSyncAt).toEqual(
      SESSION_UPDATED_AT
    );
    // An in-flight main upload is the normal "syncing" case, not a failure.
    expect(result?.transcriptDisposition).toBe(TranscriptDisposition.Syncing);
  });

  it("serves a synced disposition when the main transcript is uploaded and current", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "main",
            uploadStatus: TranscriptUploadStatus.Uploaded,
            uploadedAt: SESSION_UPDATED_AT,
            lastObservedAt: SESSION_UPDATED_AT,
          },
        ]),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcriptDisposition).toBe(TranscriptDisposition.Synced);
  });

  it("maps a failed main upload to failedTransient (permanent is deferred to FEA-3476)", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "main",
            uploadStatus: TranscriptUploadStatus.Failed,
            uploadedAt: null,
            lastObservedAt: SESSION_STARTED_AT,
          },
        ]),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcriptDisposition).toBe(
      TranscriptDisposition.FailedTransient
    );
  });

  it("threads synced token events into per-turn cost + cumulative spend (FEA-3461)", async () => {
    const promptAt = new Date("2026-01-01T00:00:00.000Z");
    const toolAt = new Date("2026-01-01T00:05:00.000Z");
    const tokenEventAt = new Date("2026-01-01T00:10:00.000Z");

    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            events: [
              {
                externalEventId: "prompt-1",
                agentExternalId: null,
                eventType: "user_prompt",
                toolName: null,
                eventCreatedAt: promptAt,
              },
              {
                externalEventId: "tool-1",
                agentExternalId: null,
                eventType: "tool_use",
                toolName: "Bash",
                eventCreatedAt: toolAt,
              },
            ],
            // Per-event cost point that attributeTokenEventCosts assigns to the
            // last cost-bearing item before its timestamp (the Bash tools turn).
            tokenEvents: [
              { eventCreatedAt: tokenEventAt, estimatedCost: 0.05 },
            ],
          })
        ),
      },
      sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    const toolsTurn = result?.turnItems?.find((item) => item.type === "tools");
    // Before the fix the cloud projection got no tokenEvents, so every turn had
    // costDelta undefined / cum 0 and the per-turn cost badges never rendered.
    expect(toolsTurn).toBeDefined();
    expect((toolsTurn as { costDelta?: number }).costDelta).toBe(0.05);
    expect((toolsTurn as { cum?: number }).cum).toBe(0.05);
  });

  // FEA-2926: properties panel cost reconciled from per-event costs.
  describe("cost reconciliation (FEA-2926)", () => {
    it("derives estimatedCost from token events when they exist", async () => {
      const eventAt = new Date("2026-01-01T00:10:00.000Z");
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              // A COMPLETE per-event stream: the per-event token counts sum to
              // the record's rollup token total (10+5 = 15), so the FEA-4276
              // ingest-completeness cross-check reads the stream as whole and
              // the per-event cost sum wins over the (divergent) rollup.
              inputTokens: 10,
              outputTokens: 5,
              tokenEvents: [
                {
                  eventCreatedAt: eventAt,
                  estimatedCost: 0.15,
                  costCompleteness: TokenCostCompleteness.Complete,
                  inputTokens: 6,
                  outputTokens: 3,
                },
                {
                  eventCreatedAt: eventAt,
                  estimatedCost: 0.35,
                  costCompleteness: TokenCostCompleteness.Complete,
                  inputTokens: 4,
                  outputTokens: 2,
                },
              ],
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.estimatedCost).toBe(0.5);
      expect(result?.cost).toBe("$0.50");
    });

    it("falls back to stored estimatedCost when no token events exist", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue(buildSessionDetailRecord({ tokenEvents: [] })),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.estimatedCost).toBe(1.25);
      expect(result?.cost).toBe("$1.25");
    });

    it("falls back to stored estimatedCost when token events hit the query cap", async () => {
      const eventAt = new Date("2026-01-01T00:10:00.000Z");
      const cappedEvents = Array.from(
        { length: SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS },
        () => ({ eventCreatedAt: eventAt, estimatedCost: 0.0001 })
      );

      installDb({
        sessionDetail: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              buildSessionDetailRecord({ tokenEvents: cappedEvents })
            ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.estimatedCost).toBe(1.25);
      expect(result?.cost).toBe("$1.25");
      // Per-turn costs are suppressed when capped so they don't disagree
      // with the rollup-based properties total.
      const costBearing = result?.turnItems?.filter(
        (item) => (item as { costDelta?: number }).costDelta !== undefined
      );
      expect(costBearing).toEqual([]);
    });
  });

  // FEA-4378 (wongk review): findSessionDetail() OVERRIDES locPerDollar to
  // recompute it against the cost reconciled from token events. That override must
  // use the SAME numerator the list projection uses —
  // max(localWorkingTreeDiff, authoredPrLinesChanged) — not the line-only local
  // diff, or the detail LOC/$ card serves the tiny working-tree ratio for a
  // multi-PR session even though the list already shows the real delivered figure.
  describe("detail LOC/$ override uses the authored-PR roll-up numerator (FEA-4378)", () => {
    it("recomputes locPerDollar from the authored-PR roll-up, not the local diff", async () => {
      // Tiny local working-tree residual (merged/reset multi-PR session) + a large
      // authored-PR roll-up. Cost is reconciled from token events (0.15 + 0.35 =
      // 0.50) so the override path runs against 0.50, not the stored 1.25.
      const eventAt = new Date("2026-01-01T00:10:00.000Z");
      const authoredPrLink = {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          relationTypes: [SessionPrRelationType.Created],
          repositoryFullName: "closedloop-ai/symphony-alpha",
          prNumber: 8801,
          source: "DETERMINISTIC",
          confidence: 1.0,
          extractorVersion: 1,
        },
        target: {
          name: "mikeangstadt/detail-rollup",
          type: "BRANCH",
          branch: {
            repository: { fullName: "closedloop-ai/symphony-alpha" },
            currentPullRequestDetail: {
              number: 8801,
              title: "PR 8801",
              prState: PullRequestState.Open,
              closedAt: null,
              mergedAt: null,
              lastVerifiedAt: eventAt,
              isCurrent: true,
              repository: { fullName: "closedloop-ai/symphony-alpha" },
              additions: 6000,
              deletions: 2000,
            },
          },
        },
      };
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              // The bug's symptom: a tiny local diff...
              linesAdded: 130,
              linesRemoved: 6,
              // A COMPLETE per-event stream: per-event token counts sum to the
              // record's rollup token total (10+5 = 15), so the FEA-4276
              // ingest-completeness cross-check reads it as whole and the
              // per-event cost sum ($0.50) wins over the (divergent) rollup.
              inputTokens: 10,
              outputTokens: 5,
              tokenEvents: [
                {
                  eventCreatedAt: eventAt,
                  estimatedCost: 0.15,
                  costCompleteness: TokenCostCompleteness.Complete,
                  inputTokens: 6,
                  outputTokens: 3,
                },
                {
                  eventCreatedAt: eventAt,
                  estimatedCost: 0.35,
                  costCompleteness: TokenCostCompleteness.Complete,
                  inputTokens: 4,
                  outputTokens: 2,
                },
              ],
              artifact: {
                organizationId: "org-1",
                name: "Detail roll-up session",
                status: "completed",
                slug: "SES-8801",
                project: null,
                sourceLinks: [authoredPrLink],
              },
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      // Cost reconciled from token events.
      expect(result?.estimatedCost).toBe(0.5);
      // The roll-up (6000 + 2000 = 8000) reaches the detail, so the numerator is
      // 8000, not the 136-line local diff.
      expect(result?.authoredPrLinesChanged).toBe(8000);
      // ISS-4667: LOC/$ = 8000 / 0.50 = 16,000 — the real delivered efficiency,
      // NOT the 272 the local-diff numerator (136 / 0.50) would give.
      expect(result?.locPerDollar).toBeCloseTo(16_000, 10);
      expect(result?.locPerDollar ?? 0).toBeGreaterThan(1);
    });
  });

  // ISS-5075: the detail `events` select had an `orderBy` but no `take`, so a
  // long-running session materialized every `agent_session_events` row into the
  // payload — and `findSessionDetail` is fanned across many sessions by the
  // branch merged trace, multiplying the unbounded lane.
  describe("event-stream row cap (ISS-5075)", () => {
    function buildEventRows(count: number) {
      return Array.from({ length: count }, (_unused, index) => ({
        externalEventId: `event-${index}`,
        agentExternalId: null,
        eventType: "tool_use",
        toolName: "Bash",
        eventCreatedAt: new Date(SESSION_STARTED_AT.getTime() + index),
      }));
    }

    // The `take: cap + 1` query shape itself is pinned beside the `orderBy` the
    // prefix semantics depend on, in projections.test.ts.

    it("serves the whole stream unflagged when the session is under the cap", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              events: buildEventRows(SESSION_DETAIL_EVENT_MAX_ROWS),
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.events).toHaveLength(SESSION_DETAIL_EVENT_MAX_ROWS);
      expect(result?.eventsTruncated).toBeUndefined();
    });

    it("serves the bounded prefix and flags eventsTruncated when the read hits the cap", async () => {
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              // What the `take: cap + 1` select returns for an over-cap session.
              events: buildEventRows(SESSION_DETAIL_EVENT_MAX_ROWS + 1),
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      // The detection row never reaches the caller — the served set is the
      // bounded chronological prefix, flagged as partial.
      expect(result?.events).toHaveLength(SESSION_DETAIL_EVENT_MAX_ROWS);
      expect(result?.events.at(-1)?.externalEventId).toBe(
        `event-${SESSION_DETAIL_EVENT_MAX_ROWS - 1}`
      );
      expect(result?.eventsTruncated).toBe(true);
    });

    it("suppresses per-turn costs when the turns stop at the event cap but the token stream runs on", async () => {
      // Cost attribution lands each token event on the nearest turn at or before
      // it, so an uncapped token stream beside a truncated turn stream would pile
      // every later event's spend onto the last surviving turn.
      const afterTheCap = new Date(
        SESSION_STARTED_AT.getTime() + SESSION_DETAIL_EVENT_MAX_ROWS + 60_000
      );
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              events: buildEventRows(SESSION_DETAIL_EVENT_MAX_ROWS + 1),
              tokenEvents: [
                {
                  eventCreatedAt: afterTheCap,
                  estimatedCost: 7.5,
                  costCompleteness: TokenCostCompleteness.Complete,
                  inputTokens: 10,
                  outputTokens: 5,
                },
              ],
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.eventsTruncated).toBe(true);
      const costBearing = result?.turnItems?.filter(
        (item) => (item as { costDelta?: number }).costDelta !== undefined
      );
      expect(costBearing).toEqual([]);
    });

    function buildRunningSubagent(externalAgentId: string) {
      return {
        externalAgentId,
        name: "explorer",
        type: "subagent",
        status: "running",
        startedAt: SESSION_STARTED_AT.toISOString(),
        updatedAt: new Date(
          SESSION_STARTED_AT.getTime() + 86_400_000
        ).toISOString(),
        endedAt: null,
      };
    }

    function findSubagentDuration(
      turnItems: TurnItem[] | undefined
    ): string | null | undefined {
      const subagent = (turnItems ?? []).find(
        (item): item is Extract<TurnItem, { type: "subagent" }> =>
          item.type === "subagent"
      );
      return subagent?.duration;
    }

    it("reports an unavailable duration for a running subagent whose events all fell past the cap", async () => {
      // `agents` is a scalar column and is never bounded, so a still-running
      // subagent can survive with all of its own events in the dropped tail. The
      // projection would otherwise anchor its duration to `updatedAt` — bumped on
      // every resync, so the duration grows on every poll (the FEA-3451 bug).
      const runningSubagent = buildRunningSubagent("agent-past-the-cap");
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              // Every served event belongs to a DIFFERENT agent, so the running
              // subagent contributes no activity timestamp to the projection.
              events: buildEventRows(SESSION_DETAIL_EVENT_MAX_ROWS + 1),
              agents: [runningSubagent],
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.eventsTruncated).toBe(true);
      // No end anchor this payload can honor, so the surface reports the duration
      // as unavailable rather than a confident, ever-growing wrong figure. The
      // agent's own fields are served untouched.
      expect(findSubagentDuration(result?.turnItems)).toBeNull();
      expect(result?.agents[0]?.updatedAt).toBe(runningSubagent.updatedAt);
      expect(result?.agents[0]?.startedAt).toBe(runningSubagent.startedAt);
    });

    it("reports an unavailable duration for a running subagent with events on both sides of the cap", async () => {
      // thread wongk (ISS-5075): keeping events in the served prefix is not proof
      // the agent stopped there. Anchoring to its last RETAINED event reports a
      // confident undercount — the same class of lie as the `updatedAt` overcount
      // above, so the truncated stream owes this agent the same "unavailable".
      const runningSubagent = buildRunningSubagent("agent-across-the-cap");
      const rows = buildEventRows(SESSION_DETAIL_EVENT_MAX_ROWS + 1).map(
        (row, index) =>
          index === 0
            ? { ...row, agentExternalId: runningSubagent.externalAgentId }
            : row
      );
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              events: rows,
              agents: [runningSubagent],
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.eventsTruncated).toBe(true);
      expect(
        result?.events.some(
          (event) => event.agentExternalId === runningSubagent.externalAgentId
        )
      ).toBe(true);
      expect(findSubagentDuration(result?.turnItems)).toBeNull();
    });

    it("keeps a running subagent's duration when the stream is whole", async () => {
      // Untruncated, so the FEA-3451 anchors are working as designed and the
      // duration stays a real figure — the unavailable state above is scoped
      // strictly to the truncated read.
      const eventLessAgent = {
        ...buildRunningSubagent("agent-quiet"),
        updatedAt: new Date(
          SESSION_STARTED_AT.getTime() + 60_000
        ).toISOString(),
      };
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              events: buildEventRows(3),
              agents: [eventLessAgent],
            })
          ),
        },
        sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });

      expect(result?.eventsTruncated).toBeUndefined();
      expect(result?.agents[0]?.updatedAt).toBe(eventLessAgent.updatedAt);
      expect(findSubagentDuration(result?.turnItems)).not.toBeNull();
    });
  });
});

/**
 * ISS-5762 — the PRODUCER end of "show all subagent transcripts".
 *
 * The renderer-side proof (`packages/app/agents/.../transcript-file-switcher.test.tsx`)
 * only shows that the switcher renders whatever it is handed. It cannot catch a
 * cap introduced HERE, which is where a row cap would most naturally be added:
 * the sibling event read on this same detail path already carries
 * `SESSION_DETAIL_EVENT_MAX_ROWS`, so the shape is right there to copy.
 *
 * Both halves matter. Asserting only the served length would still pass if
 * someone added `take: 200` and the fixture happened to fit under it, so the
 * call SHAPE is pinned too — that is the assertion that fails the moment a bound
 * appears, whatever its value. And the fixture is sized above the caps a future
 * edit would plausibly reuse, because a fixture that fits under the cap is
 * exactly how ISS-5520 and ISS-5521 stayed green while their bug was live.
 */
describe("agentSessionsService — subagent transcripts are never bounded (ISS-5762)", () => {
  const SIDECHAIN_COUNT = 122;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function seedTranscripts() {
    const rows = [
      {
        fileKey: "main",
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
      },
      ...Array.from({ length: SIDECHAIN_COUNT }, (_unused, index) => ({
        fileKey: `subagent:agent-${index + 1}`,
        uploadStatus: TranscriptUploadStatus.Uploaded,
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
      })),
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: { findMany },
    });
    return findMany;
  }

  it("serves every sidechain summary a session owns", async () => {
    seedTranscripts();

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result?.transcripts).toHaveLength(SIDECHAIN_COUNT + 1);
    expect(
      result?.transcripts?.filter((file) =>
        file.fileKey.startsWith("subagent:")
      )
    ).toHaveLength(SIDECHAIN_COUNT);
    // The tail, specifically: a prefix-shaped cap drops exactly this one.
    expect(
      result?.transcripts?.some(
        (file) => file.fileKey === `subagent:agent-${SIDECHAIN_COUNT}`
      )
    ).toBe(true);
  });

  it("issues the transcript read with no row bound at all", async () => {
    const findMany = seedTranscripts();

    await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    const args = findMany.mock.calls[0]?.[0];
    expect(args).toBeDefined();
    // `take`/`skip` are how a bound would arrive; `cursor` is how a paginated
    // rewrite would. None may appear without the response also gaining a
    // continuation contract the switcher can read (ISS-5762 AC2).
    expect(args).not.toHaveProperty("take");
    expect(args).not.toHaveProperty("skip");
    expect(args).not.toHaveProperty("cursor");
  });
});
