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
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
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
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
      },
      {
        fileKey: "subagent:a",
        uploadStatus: TranscriptUploadStatus.Pending,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
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
    // the nullable sessionDetailId FK. ISS-9112: the read resolves an identity
    // SET, so the pair rides an `OR` arm — one arm here, one per session when a
    // Branch trace hydrates its whole population.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          OR: [
            {
              computeTargetId: "target-1",
              externalSessionId: "external-session-1",
            },
          ],
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
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
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
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
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
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
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
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
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

  it("ISS-9884: serves the terminal skip reason beside the detail verdict", async () => {
    // The DETAIL Properties Sync row renders through the same
    // `getSessionSyncStatus` the list row does, so without the reason it would
    // say "Sync failed, retrying" directly above a transcript panel saying
    // "Transcript upload paused" about the same file.
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "main",
            uploadStatus: TranscriptUploadStatus.Skipped,
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
            uploadedAt: null,
            lastObservedAt: SESSION_STARTED_AT,
            permanentFailureReason: TranscriptSkipReason.EnvironmentUnavailable,
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
    expect(result?.transcriptDispositionReason).toBe(
      TranscriptSkipReason.EnvironmentUnavailable
    );
  });

  it("ISS-9884: omits the reason key when no terminal skip produced the verdict", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(buildSessionDetailRecord()),
      },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([
          {
            fileKey: "main",
            uploadStatus: TranscriptUploadStatus.Failed,
            computeTargetId: "target-1",
            externalSessionId: "external-session-1",
            uploadedAt: null,
            lastObservedAt: SESSION_STARTED_AT,
            permanentFailureReason: TranscriptSkipReason.EnvironmentUnavailable,
          },
        ]),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    // The row carries a stale reason from an earlier terminal a re-queue
    // superseded; it did NOT produce this `failedTransient`, so serving it
    // would narrate a retrying row with a give-up's copy.
    expect(result).not.toHaveProperty("transcriptDispositionReason");
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

  // ISS-7176: the detail total IS `session_detail.estimated_cost`.
  describe("whole-session cost (ISS-7176)", () => {
    it("reads the STORED ROLLUP even when a complete token-event stream disagrees", async () => {
      const eventAt = new Date("2026-01-01T00:10:00.000Z");
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              // A COMPLETE per-event stream whose cost sum ($0.50) disagrees
              // with the stored rollup ($1.25). Under FEA-2926/FEA-4276 the
              // stream won this case and the assertion below read $0.50.
              //
              // IT IS THE FIXTURE THAT MAKES THE POINT: "complete" here means the
              // per-event TOKEN counts reconcile with the rollup token total
              // (10+5 = 15), which is the only completeness the gate could check.
              // A session-level web-search line item carries no tokens, so a
              // rollup that includes one looks exactly like this — divergent, and
              // indistinguishable from a broken stream. ISS-7176 ruled for the
              // rollup, which is the figure that carries every line item.
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

      expect(result?.estimatedCost).toBe(1.25);
      expect(result?.cost).toBe("$1.25");
    });

    it("reads the same rollup when no token events exist at all", async () => {
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

  // FEA-4378 (whitlockk review): findSessionDetail() OVERRIDES locPerDollar to
  // recompute it against the cost reconciled from token events. That override must
  // use the SAME numerator the list projection uses.
  //
  // ISS-9964 / ISS-9980 (RULED 2026-09-11) made that numerator merged-authored-PR
  // lines and nothing else, and deleted the `sessions-merged-loc-rung` flag that
  // used to select between two numerators. The expectations below changed because
  // that behavior changed: the wide (merged-or-not) population is no longer a
  // numerator on any code path, so the pair of gate-open/gate-closed cases that
  // existed to tell the two populations apart collapses to one case.
  describe("detail LOC/$ override counts merged authored PRs only (FEA-4378 / ISS-9964)", () => {
    /**
     * Tiny local working-tree residual + one large authored PR that is still
     * OPEN. The open PR is EXCLUDED from the numerator — a measurement that
     * found nothing merged, not a failure to measure — so the numerator is a
     * real `0` while the compatibility alias still reports the wide 8,000.
     */
    function installOpenAuthoredPrDetailSession() {
      // Tiny local working-tree residual (merged/reset multi-PR session) + a large
      // authored-PR roll-up. Cost is reconciled from token events (0.15 + 0.35 =
      // 0.50) so the override path runs against 0.50, not the stored 1.25.
      const eventAt = new Date("2026-01-01T00:10:00.000Z");
      const authoredPrLink = {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          relationTypes: [SessionPrRelationType.Created],
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 8801,
          source: "DETERMINISTIC",
          confidence: 1.0,
          extractorVersion: 1,
        },
        target: {
          name: "marisolashgrove/detail-rollup",
          type: "BRANCH",
          branch: {
            repository: { fullName: "closedloop-ai/closedloop-ai" },
            currentPullRequestDetail: {
              number: 8801,
              title: "PR 8801",
              // ISS-6114 (code review): deliberately OPEN, restored after a
              // draft of this branch flipped it to Merged to heal a red. That
              // red was the real defect — the detail path divided by the merged
              // population while the gate was CLOSED — and merging the fixture
              // hid it by making both populations 8,000. Open is what keeps them
              // different (wide 8,000 / merged 0), so this case can still tell
              // which one the numerator used.
              prState: PullRequestState.Open,
              closedAt: null,
              mergedAt: null,
              lastVerifiedAt: eventAt,
              isCurrent: true,
              repository: { fullName: "closedloop-ai/closedloop-ai" },
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
    }

    it("counts the merged population only, and an all-open session divides into a measured 0", async () => {
      installOpenAuthoredPrDetailSession();

      const result = await agentSessionsService.findSessionDetail({
        id: "session-1",
        organizationId: "org-1",
      });
      // ISS-7176: the DENOMINATOR is the stored rollup, not a per-event sum.
      // Named here because it is also the LOC/$ divisor below.
      expect(result?.estimatedCost).toBe(1.25);
      // The one authored PR is OPEN, so it is excluded from the numerator. The
      // exclusion is a MEASUREMENT — we read the PR and it had not merged — so
      // this is a real `0`, not the `null` an unresolvable roll-up produces.
      expect(result?.mergedAuthoredPrLinesChanged).toBe(0);
      // ISS-6114 review: the deprecated alias survives the DETAIL path too. The
      // list path has its own alias test; this one had none, so an `omit`/
      // explicit-field refactor of the detail assembly could drop the alias for
      // installed Desktop builds with nothing going red. It still reports the
      // WIDE 8,000 and is deliberately not a numerator.
      expect(result?.authoredPrLinesChanged).toBe(8000);
      // ISS-9964 / ISS-9980 (RULED 2026-09-11): this asserted the wide
      // population as a numerator (8000 / 1.25 = 6,400). It is now 0 / 1.25 = 0
      // — the session delivered no merged lines, which is a fact about the
      // session and renders as `0`, never as the 108.8 the retired local-diff
      // rung (136 / 1.25) gave nor as a placeholder.
      expect(result?.locPerDollar).toBe(0);
      // Pin the retired rungs explicitly against the ISS-7176 divisor: neither
      // the wide 8,000 roll-up (6,400) nor the 136-line working-tree diff
      // (108.8) may reappear as a numerator.
      expect(result?.locPerDollar).not.toBeCloseTo(6400, 10);
      expect(result?.locPerDollar).not.toBeCloseTo(108.8, 10);
      // `kloc` is a VOLUME field, not the ratio, and ISS-9980 ruled the RATIO.
      // Its own FEA-4250 contract is untouched here: `klocFromLines` returns
      // `null` for zero churn so a volume card renders a placeholder rather than
      // a misleading `0.0`. A measured-zero merged population therefore reports
      // `locPerDollar: 0` (a rate — nothing landed per dollar spent) beside
      // `kloc: null` (no churn to express in thousands of lines). Nothing in
      // this repo renders a session-level `kloc`, so no card is affected.
      expect(result?.kloc).toBeNull();
    });
  });

  describe("detail LOC/$ is NOT AVAILABLE when the merged roll-up cannot be resolved (ISS-4448 / ISS-9980)", () => {
    it("emits null rather than collapsing an unresolvable roll-up onto a measured 0", async () => {
      // ISS-4448's own worked example, driven through the DETAIL path: a merged
      // multi-PR session left with a 56-line working-tree residual, no reachable
      // authored-PR rows, and a real 3315/689 branch diff.
      //
      // ISS-9964 / ISS-9980 (RULED 2026-09-11): this case used to assert
      // `locPerDollar` 8008, recomputed from the 4,004-line BRANCH DIFF. That
      // rung is retired — a branch diff measures work in progress, not delivered
      // code — so the branch numbers below stay asserted as a rendered field and
      // are no longer a numerator. With no resolvable head branch the merged
      // roll-up is NOT KNOWABLE, and the ruling is explicit that an unmeasurable
      // numerator renders NOT AVAILABLE rather than `0`.
      const eventAt = new Date("2026-01-01T00:10:00.000Z");
      installDb({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue(
            buildSessionDetailRecord({
              linesAdded: 51,
              linesRemoved: 5,
              branchLocSource: "branch_compare",
              branchLinesAdded: 3315,
              branchLinesRemoved: 689,
              branchFilesChanged: 42,
              // Complete per-event stream so the reconciled cost is 0.50 and the
              // override path runs (same construction as the FEA-4378 sibling).
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
                name: "Merged multi-PR session",
                status: "completed",
                slug: "SES-4448",
                project: null,
                sourceLinks: [],
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

      // ISS-7176: the stored rollup is the divisor (see the WIDE-population case).
      expect(result?.estimatedCost).toBe(1.25);
      // The branch diff still survives to the detail payload — it is a real
      // measurement of the branch and the panel still renders it. It is simply
      // not what LOC/$ divides any more.
      expect(result?.branchDiffStats).toMatchObject({
        linesAdded: 3315,
        linesRemoved: 689,
      });
      // NOT KNOWABLE, not zero: with no head branch resolved the authored-PR
      // roll-up is suppressed rather than read, so the projection refuses to
      // report a count it never took.
      expect(result?.mergedAuthoredPrLinesChanged).toBeNull();
      expect(result?.locPerDollar).toBeNull();
      expect(result?.kloc).toBeNull();
      // Pin the retired rungs explicitly, against the ISS-7176 divisor: neither
      // the 4,004-line branch diff (4004 / 1.25 = 3203.2) nor the 56-line
      // working-tree residual (56 / 1.25 = 44.8) may reappear as a numerator.
      expect(result?.locPerDollar).not.toBeCloseTo(3203.2, 10);
      expect(result?.locPerDollar).not.toBeCloseTo(44.8, 10);
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
      // thread whitlockk (ISS-5075): keeping events in the served prefix is not proof
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
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
        uploadedAt: SESSION_UPDATED_AT,
        lastObservedAt: SESSION_UPDATED_AT,
      },
      ...Array.from({ length: SIDECHAIN_COUNT }, (_unused, index) => ({
        fileKey: `subagent:agent-${index + 1}`,
        uploadStatus: TranscriptUploadStatus.Uploaded,
        computeTargetId: "target-1",
        externalSessionId: "external-session-1",
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
