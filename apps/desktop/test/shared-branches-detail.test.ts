import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BranchCloudHydrationStatus,
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  BranchLinkedArtifactEvidenceKind,
  type BranchPageDetail,
  BranchParticipationKind,
  BranchStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import {
  type BranchAssociatedPullRequestCollection,
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request.js";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution.js";
import { GitHubPRState } from "@repo/api/src/types/github.js";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildDesktopPhaseAttribution } from "../src/main/branch/branch-detail-phase-attribution.js";
import { getSharedBranchDetail } from "../src/main/branch/shared-branches-api.js";
import type { BranchLifecycleEventRow } from "../src/main/database/branch-reads.js";
import { SHARED_BRANCHES_SOURCE_ERROR_CODE } from "../src/shared/shared-branches-contract.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import {
  almostEqual,
  commit,
  link,
  makeSource,
  openPullRequestRow,
  phaseProjectionRows,
  SQL_SECRET,
  sumStackCost,
  sumStackInputTokens,
  syncedSession,
  throwingSource,
} from "./shared-branches-test-helpers.js";

/**
 * `getSharedBranchDetail` — the Epic C detail projection and its D1 enrichment
 * (cloud hydration overlay, lifecycle-phase stacks, per-session usage).
 *
 * Split out of `shared-branches-api.test.ts` (ISS-4941), which is grandfathered
 * at the noExcessiveLinesPerFile ceiling: the detail op is the one read whose
 * coverage is fully self-contained, so it moves whole rather than being sliced.
 * Shares the same canned-row helpers, so the seams are unchanged.
 */

describe("getSharedBranchDetail (Epic C detail projection)", () => {
  test("null for a missing source, a non-string id, or an empty id", async () => {
    assert.equal(await getSharedBranchDetail(null, "x"), null);
    assert.equal(await getSharedBranchDetail(makeSource({}), "x"), null);
    assert.equal(
      await getSharedBranchDetail(makeSource({}), 123 as unknown as string),
      null
    );
    assert.equal(await getSharedBranchDetail(makeSource({}), ""), null);
  });

  test("null when the id matches no local branch (early-exit after one read)", async () => {
    const reads: string[] = [];
    const source = makeSource(
      { links: [link({ branch_name: "feature/x" })] },
      (q) => reads.push(q)
    );
    const missingId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "does-not-exist",
    });
    assert.equal(await getSharedBranchDetail(source, missingId), null);
    // PLN-1148: the scoped link read returns no rows for an unknown branch, so
    // the detail 404s WITHOUT issuing the PR / token / commit reads.
    assert.deepEqual(reads, ["links"]);
  });

  // FEA-3056 follow-up: only the list/analytics page-data read opts into the
  // non-blocking `peekOrWarm`. The single-branch detail view keeps hydrating
  // via the blocking `hydrate`, so opening a branch still reflects live cloud
  // state rather than a possibly-empty background snapshot.
  test("hydrates via hydrate, not peekOrWarm, for the detail scope", async () => {
    const calls: string[] = [];
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      prs: [openPullRequestRow("https://github.com/acme/web/pull/42")],
    });
    const cloudHydration = {
      hydrate: () => {
        calls.push("hydrate");
        return Promise.resolve({ status: BranchCloudHydrationStatus.Fresh });
      },
      peekOrWarm: () => {
        calls.push("peekOrWarm");
        return Promise.resolve({ status: BranchCloudHydrationStatus.Stale });
      },
    };
    const id = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/x",
    });

    await getSharedBranchDetail(source, id, cloudHydration);

    assert.deepEqual(calls, ["hydrate"]);
  });

  test("no session loader → graceful spine fallback (null/0 usage, empty trace)", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1", is_primary: true }),
        link({
          branch_name: "feature/x",
          session_id: "s2",
          is_primary: false,
          observed_at: "2026-06-10T09:00:00.000Z",
        }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: "https://gh/acme/web/pull/42",
          title: "Add X",
          state: "closed",
          merged_at: "2026-06-12T10:00:00.000Z",
          closed_at: "2026-06-12T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const id = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/x",
    });
    const detail = await getSharedBranchDetail(source, id);
    assert.ok(detail, "expected a non-null detail");
    assert.equal(detail.id, id);
    assert.equal(detail.branchName, "feature/x");
    assert.equal(detail.prNumber, 42);
    assert.equal(detail.status, BranchStatus.Merged);
    // Real PR-derived detail fields.
    assert.deepEqual(detail.linkedPrNumbers, [42]);
    assert.equal(detail.mergedAt, "2026-06-12T10:00:00.000Z");
    assert.equal(detail.closedAt, "2026-06-12T10:00:00.000Z");
    // Sessions spine: every linked session, primary flag preserved.
    assert.deepEqual(
      detail.sessions.map((session) => session.sessionId).sort(),
      ["s1", "s2"]
    );
    assert.equal(
      detail.sessions.find((session) => session.sessionId === "s1")?.isPrimary,
      true
    );
    // Deferred enrichment degrades to null/[]/0 — never fabricated.
    assert.equal(detail.prBody, null);
    assert.equal(detail.headSha, null);
    assert.equal(detail.mergeCommitSha, null);
    assert.deepEqual(detail.mergedTrace, []);
    assert.equal(detail.sessions[0]?.inputTokens, 0);
    assert.equal(detail.sessions[0]?.estimatedCostUsd, null);
  });

  test("detail exposes commits[] (oldest-first) + openedAt (PRD-486)", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      // Returned newest-first by the fake; the projection must re-sort ascending.
      commits: [
        commit({
          sha: "newsha9999999",
          committed_at: "2026-06-12T08:00:00.000Z",
          message: "Second",
        }),
        commit({
          sha: "oldsha1111111",
          committed_at: "2026-06-09T08:00:00.000Z",
          message: "First",
        }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          opened_at: "2026-06-10T07:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const id = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/x",
    });
    const detail = await getSharedBranchDetail(source, id);
    assert.ok(detail, "expected a non-null detail");
    assert.equal(detail.openedAt, "2026-06-10T07:00:00.000Z");
    assert.deepEqual(detail.commits, [
      {
        sha: "oldsha1111111",
        committedAt: "2026-06-09T08:00:00.000Z",
        message: "First",
      },
      {
        sha: "newsha9999999",
        committedAt: "2026-06-12T08:00:00.000Z",
        message: "Second",
      },
    ]);
  });

  test("a read failure rethrows a sanitized, code-only error (no SQL leak)", async () => {
    await assert.rejects(
      getSharedBranchDetail(throwingSource, "x"),
      (err: Error) => {
        assert.equal(err.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
        assert.doesNotMatch(err.message, SQL_SECRET);
        return true;
      }
    );
  });
});

describe("getSharedBranchDetail (D1 enrichment)", () => {
  const idFeatureX = encodeBranchId({
    repoFullName: "acme/web",
    branchName: "feature/x",
  });

  test("hydrates per-session token splits + priced cost + name/harness", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1", is_primary: true }),
        link({
          branch_name: "feature/x",
          session_id: "s2",
          is_primary: false,
          observed_at: "2026-06-10T09:00:00.000Z",
        }),
      ],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          name: "Build the thing",
          harness: "claude",
          tokenUsageByModel: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
        syncedSession({
          externalSessionId: "s2",
          harness: "codex",
          tokenUsageByModel: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 200,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail, "expected a non-null detail");
    const s1 = detail.sessions.find((session) => session.sessionId === "s1");
    const s2 = detail.sessions.find((session) => session.sessionId === "s2");
    assert.equal(s1?.name, "Build the thing");
    assert.equal(s1?.harness, "claude");
    assert.equal(s1?.inputTokens, 1000);
    assert.equal(s1?.outputTokens, 500);
    assert.ok(
      (s1?.estimatedCostUsd ?? 0) > 0,
      "priced model → real per-session cost"
    );
    assert.equal(s2?.harness, "codex");
    assert.equal(s2?.inputTokens, 200);
    // Single PR across both sessions → one linked PR number, no warning.
    assert.equal(detail.multiPrWarning, false);
  });

  test("detail emits lifecycle phase segments and cost stacks from local evidence", async () => {
    const source = makeSource(phaseProjectionRows());

    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail, "expected a non-null detail");
    const session = detail.sessions.find((item) => item.sessionId === "s1");
    assert.deepEqual(
      session?.phaseSegments?.map((segment) => segment.phase),
      [
        BranchLifecyclePhase.Build,
        BranchLifecyclePhase.Review,
        BranchLifecyclePhase.Rework,
      ]
    );
    assert.equal(session?.evenSplitCostUsd, 0.9);
    assert.equal(session?.activitySegments?.length, 3);
    assert.equal(detail.phaseAttribution?.segments.length, 3);
    const stacks = detail.lifecyclePhaseStacks ?? [];
    assert.deepEqual(
      stacks.map((stack) => stack.phase),
      [
        BranchVisibleLifecyclePhase.Build,
        BranchVisibleLifecyclePhase.Review,
        BranchVisibleLifecyclePhase.Rework,
      ]
    );
    assert.ok(almostEqual(sumStackCost(stacks), 0.9));
    assert.ok(almostEqual(sumStackInputTokens(stacks), 600));
    assert.deepEqual(detail.phaseAttribution?.coverage, {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 0.9,
    });
  });

  test("linkedArtifacts derive from the BRANCH NAME slug, ignoring noisy session prose refs", async () => {
    const branchName = "fea-1952-branches-epic-f";
    const id = encodeBranchId({ repoFullName: "acme/web", branchName });
    const source = makeSource({
      links: [link({ branch_name: branchName, session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          // A prose/MCP mention of an UNRELATED artifact — must NOT become a link.
          artifactRefs: [
            {
              kind: ArtifactRefTargetKind.ClosedloopArtifact,
              slug: "PLN-988",
              isPrimary: false,
              method: "slug_in_message",
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, id);
    assert.ok(detail, "expected a non-null detail");
    // Only the branch's own slug (uppercased), not the prose-mentioned PLN-988.
    assert.deepEqual(detail.linkedArtifacts, [
      {
        slug: "FEA-1952",
        evidence: { kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug },
      },
    ]);
  });

  test("branch name with no Closedloop slug → empty linkedArtifacts", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          artifactRefs: [
            {
              kind: ArtifactRefTargetKind.ClosedloopArtifact,
              slug: "FEA-1952",
              isPrimary: false,
              method: "slug_in_message",
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.deepEqual(detail?.linkedArtifacts, []);
  });

  test("FEA-3546: unknown model priced at Opus-standard fallback, tokens still summed", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          tokenUsageByModel: [
            {
              model: "totally-unknown-model",
              inputTokens: 42,
              outputTokens: 7,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    const s1 = detail?.sessions.find((session) => session.sessionId === "s1");
    // genai-prices can't price `totally-unknown-model` (no_match); the FEA-3546
    // Opus-standard fallback prices it instead of collapsing to null.
    const fallback = estimateTokenCost({
      model: "totally-unknown-model",
      inputTokens: 42,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.ok(
      fallback,
      "expected the unknown-model fallback to produce a cost"
    );
    assert.equal(s1?.estimatedCostUsd, fallback.costUsd);
    assert.ok((s1?.estimatedCostUsd ?? 0) > 0);
    assert.equal(s1?.inputTokens, 42);
    assert.equal(s1?.outputTokens, 7);
  });

  test(">1 distinct linked PR → multiPrWarning true, linkedPrNumbers length 2", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 42,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T12:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "feature/x",
          pr_number: 43,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T11:00:00.000Z",
        },
      ],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.equal(detail?.multiPrWarning, true);
    assert.equal(detail?.linkedPrNumbers.length, 2);
    assert.deepEqual([...(detail?.linkedPrNumbers ?? [])].sort(), [42, 43]);
  });

  test("null enrichment degrades to null, never 0 (LOC + base + GitHub fields)", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail);
    for (const field of [
      detail.additions,
      detail.deletions,
      detail.filesChanged,
      detail.baseBranch,
      detail.headSha,
      detail.mergeCommitSha,
      detail.prBody,
      detail.ahead,
      detail.behind,
      detail.checksStatus,
    ]) {
      assert.equal(field, null);
    }
  });

  test("PLN-1148 Phase 2: detail defers the trace ([]) and summarizes lead-time from event instants", async () => {
    const source = makeSource({
      links: [link({ branch_name: "feature/x", session_id: "s1" })],
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          events: [
            {
              externalEventId: "e1",
              eventType: "user",
              createdAt: "2026-06-10T10:00:00.000Z",
            },
            // 5-minute gap (>= the 120s idle threshold) → one idle span.
            {
              externalEventId: "e2",
              eventType: "assistant",
              createdAt: "2026-06-10T10:05:00.000Z",
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail);
    // The events-heavy trace is NOT shipped by the detail anymore.
    assert.deepEqual(detail.mergedTrace, []);
    // The lightweight lead-time summary IS — derived from the event instants
    // (which survive the light `omitEventData` hydration).
    assert.equal(detail.leadTime.firstActivityT, "2026-06-10T10:00:00.000Z");
    assert.equal(detail.leadTime.lastActivityT, "2026-06-10T10:05:00.000Z");
    assert.equal(detail.leadTime.idleSpans.length, 1);
    assert.ok(detail.leadTime.idleSpans[0].gapMs >= 120_000);
  });

  test("a session that does not hydrate keeps the honest link-row spine", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "feature/x", session_id: "s1" }),
        link({ branch_name: "feature/x", session_id: "s-missing" }),
      ],
      // Only s1 hydrates; s-missing is absent from the loader result.
      sessions: [
        syncedSession({
          externalSessionId: "s1",
          tokenUsageByModel: [
            {
              model: "claude-sonnet-4-5",
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        }),
      ],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    const missing = detail?.sessions.find(
      (session) => session.sessionId === "s-missing"
    );
    assert.ok(missing, "the unhydrated session is still listed");
    assert.equal(missing.harness, "");
    assert.equal(missing.inputTokens, 0);
    assert.equal(missing.estimatedCostUsd, null);
    assert.deepEqual(detail?.phaseAttribution?.coverage, {
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
      reason: BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
    });
    assert.equal(detail?.lifecyclePhaseStacks, undefined);
  });

  test("enriched branch LOC flows through to the detail (FEA-1899)", async () => {
    const source = makeSource({
      links: [
        link({
          branch_name: "feature/x",
          session_id: "s1",
          lines_added: 321,
          lines_removed: 12,
          files_changed: 7,
        }),
      ],
      sessions: [syncedSession({ externalSessionId: "s1" })],
    });
    const detail = await getSharedBranchDetail(source, idFeatureX);
    assert.ok(detail, "expected a non-null detail");
    assert.equal(detail.additions, 321);
    assert.equal(detail.deletions, 12);
    assert.equal(detail.filesChanged, 7);
  });
});

describe("buildDesktopPhaseAttribution availability", () => {
  test("exposes each unavailable evidence boundary", () => {
    assert.equal(
      phaseAttributionReason(
        buildAvailabilityProjection({
          associatedPullRequests: incompleteAvailabilityPullRequests(),
        })
      ),
      BranchPhaseAttributionCompletenessReason.LifecycleIncomplete
    );
    assert.equal(
      phaseAttributionReason(
        buildAvailabilityProjection({ loadedSessions: [] })
      ),
      BranchPhaseAttributionCompletenessReason.MissingActivitySegments
    );
    assert.equal(
      phaseAttributionReason(
        buildAvailabilityProjection({
          sessions: [
            availabilityBranchSession({ activitySegments: undefined }),
          ],
        })
      ),
      BranchPhaseAttributionCompletenessReason.MissingActivitySegments
    );
    assert.equal(
      phaseAttributionReason(
        buildAvailabilityProjection({
          loadedSessions: [
            availabilityLoadedSession({
              activitySegmentRows: [
                availabilityActivitySegmentRow({ endMs: availabilityStartMs }),
              ],
            }),
          ],
        })
      ),
      BranchPhaseAttributionCompletenessReason.MalformedEvidence
    );
  });

  test("rejects malformed synced spend evidence", () => {
    const malformedEvents = [
      availabilityTokenEvent({ createdAt: "not-a-date" }),
      availabilityTokenEvent({ estimatedCostUsd: Number.NaN }),
      availabilityTokenEvent({ estimatedCostUsd: -1 }),
      availabilityTokenEvent({ inputTokens: -1 }),
      availabilityTokenEvent({ outputTokens: -1 }),
      availabilityTokenEvent({ cacheReadTokens: -1 }),
      availabilityTokenEvent({ cacheWriteTokens: -1 }),
    ];

    for (const event of malformedEvents) {
      assert.equal(
        phaseAttributionReason(
          buildAvailabilityProjection({
            loadedSessions: [
              availabilityLoadedSession({ tokenEvents: [event] }),
            ],
          })
        ),
        BranchPhaseAttributionCompletenessReason.PricingIncomplete
      );
    }
  });

  test("rejects each malformed activity-segment boundary", () => {
    const malformedRows = [
      availabilityActivitySegmentRow({ startMs: Number.NaN }),
      availabilityActivitySegmentRow({ endMs: Number.NaN }),
      availabilityActivitySegmentRow({ endMs: availabilityStartMs }),
    ];

    for (const row of malformedRows) {
      assert.equal(
        phaseAttributionReason(
          buildAvailabilityProjection({
            loadedSessions: [
              availabilityLoadedSession({ activitySegmentRows: [row] }),
            ],
          })
        ),
        BranchPhaseAttributionCompletenessReason.MalformedEvidence
      );
    }
  });

  test("accepts absent optional synced evidence when the projected segment is complete", () => {
    const result = buildAvailabilityProjection({
      loadedSessions: [
        availabilityLoadedSession({
          activitySegmentRows: undefined,
          tokenEvents: undefined,
        }),
      ],
    });

    assert.equal(
      result.coverage.completeness,
      BranchPhaseAttributionCompleteness.Complete
    );
  });
});

const availabilitySessionId = "session-1";
const availabilityStartMs = Date.parse("2026-08-01T00:00:00.000Z");
const availabilityEndMs = Date.parse("2026-08-01T00:01:00.000Z");

function buildAvailabilityProjection(
  overrides: {
    associatedPullRequests?: BranchAssociatedPullRequestCollection;
    loadedSessions?: SyncedAgentSession[];
    sessions?: BranchPageDetail["sessions"];
  } = {}
) {
  return buildDesktopPhaseAttribution({
    sessions: overrides.sessions ?? [availabilityBranchSession()],
    lifecycleEventsBySession: new Map([
      [availabilitySessionId, [availabilityLifecycleEvent()]],
    ]),
    associatedPullRequests:
      overrides.associatedPullRequests ?? completeAvailabilityPullRequests(),
    loadedSessions: overrides.loadedSessions ?? [availabilityLoadedSession()],
  });
}

function availabilityLifecycleEvent(): BranchLifecycleEventRow {
  return {
    repoFullName: "acme/web",
    branchName: "feature/test",
    sessionId: availabilitySessionId,
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    sessionEndedAt: "2026-08-01T00:01:00.000Z",
    kind: BranchLifecycleBoundaryKind.BranchWrite,
    observedAt: "2026-08-01T00:00:30.000Z",
    evidenceId: "push-1",
    method: "git_push",
  };
}

function phaseAttributionReason(
  result: ReturnType<typeof buildDesktopPhaseAttribution>
) {
  if (!("reason" in result.coverage)) {
    throw new Error("expected incomplete phase-attribution coverage");
  }
  return result.coverage.reason;
}

function availabilityBranchSession(
  overrides: Partial<BranchPageDetail["sessions"][number]> = {}
): BranchPageDetail["sessions"][number] {
  return {
    sessionId: availabilitySessionId,
    slug: null,
    name: null,
    harness: "claude",
    participation: BranchParticipationKind.Wrote,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    isPrimary: true,
    branchCount: 1,
    estimatedCostUsd: 1,
    evenSplitCostUsd: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    activitySegments: [
      {
        phase: "implement",
        startMs: availabilityStartMs,
        endMs: availabilityEndMs,
        costUsd: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        confidence: 1,
      },
    ],
    ownerUserName: null,
    ...overrides,
  };
}

function availabilityLoadedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return syncedSession({
    externalSessionId: availabilitySessionId,
    activitySegmentRows: [availabilityActivitySegmentRow()],
    tokenEvents: [availabilityTokenEvent()],
    ...overrides,
  });
}

function availabilityActivitySegmentRow(
  overrides: Partial<
    NonNullable<SyncedAgentSession["activitySegmentRows"]>[number]
  > = {}
): NonNullable<SyncedAgentSession["activitySegmentRows"]>[number] {
  return {
    phase: "implement",
    startMs: availabilityStartMs,
    endMs: availabilityEndMs,
    confidence: 1,
    evidenceLayers: [],
    version: 1,
    ...overrides,
  };
}

function availabilityTokenEvent(
  overrides: Partial<
    NonNullable<SyncedAgentSession["tokenEvents"]>[number]
  > = {}
): NonNullable<SyncedAgentSession["tokenEvents"]>[number] {
  return {
    externalEventId: "event-1",
    model: "test-model",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 1,
    createdAt: "2026-08-01T00:00:30.000Z",
    ...overrides,
  };
}

function completeAvailabilityPullRequests(): BranchAssociatedPullRequestCollection {
  return {
    items: [
      {
        id: "acme/web#1",
        repositoryFullName: "acme/web",
        number: 1,
        title: null,
        url: null,
        state: GitHubPRState.Merged,
        isDraft: false,
        reviewDecision: null,
        openedAt: "2026-08-01T00:00:15.000Z",
        closedAt: "2026-08-01T00:00:45.000Z",
        mergedAt: "2026-08-01T00:00:45.000Z",
      },
    ],
    selectedId: "acme/web#1",
    selectionReason:
      BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Complete,
      reasons: [],
      provenance: BranchAssociatedPullRequestProvenance.PersistedDesktop,
    },
  };
}

function incompleteAvailabilityPullRequests(): BranchAssociatedPullRequestCollection {
  return {
    ...completeAvailabilityPullRequests(),
    completeness: {
      state: BranchAssociatedPullRequestCompletenessState.Incomplete,
      reasons: [BranchAssociatedPullRequestCompletenessReason.InvalidIdentity],
      provenance: BranchAssociatedPullRequestProvenance.PersistedDesktop,
    },
  };
}
