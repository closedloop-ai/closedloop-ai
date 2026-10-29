/**
 * ISS-9182 / PLN-2061 M4: a delivery carrying PR-bearing `artifactRefs` but no
 * usable `prRefs` materializes the head branch it observed, so the target it
 * names stops being lane-owned and the Session's id reaches the ack echo.
 *
 * One case per PRODUCER of a payload that ships PR-bearing `artifactRefs` with
 * no usable `prRefs`, because a fix proven on one would leave the others stuck.
 * Each case derives its own gate value from the REAL freshness gate over the
 * REAL producer payload rather than passing a literal `false`, so a producer
 * that stopped shutting the gate would change the case's own premise instead of
 * quietly passing.
 *
 * Only ONE of the three can strand a `PullRequestDetail` target, and the other
 * two cases pin the filters that make that so — remove either filter and this
 * fix's scope silently changes. A prose-mention PR ref is dropped by
 * `collectProviderVerifiablePullRequestRefs`, and a `monitoredActivityOnly` ref
 * by `collectPullRequestRefs`, so neither reaches the lane's loop at all.
 *
 * The observable is the head Branch artifact and the `PullRequestDetail` row:
 * once they exist the lane reports no deferral, so the classifier settles the
 * target on its existence read instead of holding the Session's id out of the
 * ack echo. The hold itself is pinned next door, by the deferral cases in
 * `pull-request-details.branches.test.ts` and the classifier suites that read
 * that report.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSyncedSession,
  SESSION_STARTED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  installPrDetailIngestDb,
  prDetailRef as prRef,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";
import { resolveSessionFreshnessGates } from "../field-regression-guards";
import { resolveSessionPullRequestEvidence } from "../persist-session-children";

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

/**
 * The stored watermark the PR-detail harness seeds. An ENDED session's
 * `updatedAt` is frozen at it, so every replay of that session TIES — which is
 * the whole reason these payloads can never open the link gate.
 */
const ENDED_AT_TIE = SESSION_STARTED_AT.toISOString();

/** A `gh pr view` observation: provider-verifiable, and head-bearing. */
function observedPrRef(
  overrides: Record<string, unknown> = {}
): SyncedArtifactRef {
  return prRef({
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Reviewed,
    ...overrides,
  });
}

/**
 * The transport-only ref `monitoredActivityOnlyRefsFromMetadata` appends after
 * the desktop's link loop has run, so it has no `prRefs` counterpart BY
 * CONSTRUCTION. Its `monitoredSessionActivity` carrier is omitted here because
 * `collectPullRequestRefs` excludes the ref on the flag alone, before anything
 * reads that carrier.
 */
function monitoredActivityOnlyPrRef(): SyncedArtifactRef {
  return observedPrRef({ monitoredActivityOnly: true });
}

/**
 * A PR link the extractor found in prose: never carried in `prRefs`. Given a
 * head branch name deliberately, so the case fails if
 * `collectProviderVerifiablePullRequestRefs` ever admits it — a headless ref
 * would be stopped by the head-name check instead and prove nothing.
 */
function proseMentionPrRef(): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/web",
    prNumber: 77,
    branchName: "feat/prose",
    method: ArtifactRefMethod.PrMentionInProse,
    relation: ArtifactRefRelation.Referenced,
    observedAt: "2026-05-20T17:00:00.000Z",
  } as SyncedArtifactRef;
}

/**
 * What the REAL gate says about this producer's payload at the tie. Asserted
 * per case so the premise is pinned rather than assumed: if a producer stopped
 * shipping PR-bearing refs without usable `prRefs`, this is what would change.
 */
function linkGateFor(session: SyncedAgentSession): {
  shouldUpdatePullRequestLinks: boolean;
  didPreservePullRequestsOnTie: boolean;
} {
  const evidence = resolveSessionPullRequestEvidence(session);
  const freshness = resolveSessionFreshnessGates({
    existingSessionUpdatedAt: SESSION_STARTED_AT,
    incomingSessionUpdatedAt: new Date(session.updatedAt),
    receivedAt: new Date("2026-05-20T18:30:00.000Z"),
    hasPullRequestBlobEvidence: evidence.hasBlobEvidence,
    hasPullRequestLinkEvidence: evidence.hasLinkEvidence,
    hasPullRequestBlobWrite: evidence.hasBlobWrite,
    hasPullRequestLinkWrite: evidence.hasLinkWrite,
    isPullRequestListPageZero: evidence.isPrListPageZero,
  });
  return {
    shouldUpdatePullRequestLinks: freshness.shouldUpdatePullRequestLinks,
    didPreservePullRequestsOnTie: freshness.didPreservePullRequestsOnTie,
  };
}

describe("PR head-branch materialization under a shut link gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("materializes for a paginated PR-list BASE part, which carries no PR lists at all", async () => {
    const m = installPrDetailIngestDb({ branches: [] });
    const overrides = {
      updatedAt: ENDED_AT_TIE,
      endedAt: ENDED_AT_TIE,
      chunk: { index: 0, total: 3 },
    } as Partial<SyncedAgentSession>;

    // `sessionWithoutPrLists` strips both PR carriers from the replicated base,
    // and a base part carries no `prRefsPaginated` key, so it is not the page 0
    // the tie admits.
    const gate = linkGateFor(
      buildSyncedSession({ ...overrides, artifactRefs: [observedPrRef()] })
    );
    expect(gate.shouldUpdatePullRequestLinks).toBe(false);

    await syncPrDetailRefs([observedPrRef()], undefined, overrides);

    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.prCreateMany).toHaveBeenCalledTimes(1);
    // The link lane stayed shut: materializing a head branch replaces nothing,
    // and the fix must not have widened the destructive replacement.
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
  });

  it("shuts the gate for a session whose PR links are all prose mentions, shipping an EMPTY prRefs array, and strands nothing", async () => {
    const m = installPrDetailIngestDb({ branches: [] });
    const refs = [proseMentionPrRef()];
    const overrides = {
      updatedAt: ENDED_AT_TIE,
      endedAt: ENDED_AT_TIE,
      prRefs: [],
    } as Partial<SyncedAgentSession>;

    const gate = linkGateFor(
      buildSyncedSession({ ...overrides, artifactRefs: refs })
    );
    expect(gate.shouldUpdatePullRequestLinks).toBe(false);
    // An EMPTY array fails the same evidence test as an absent one, then takes
    // a different path: the link lane HAD a write to lose, so the tie books the
    // accepted-loss counter. An absent `prRefs` books nothing.
    expect(gate.didPreservePullRequestsOnTie).toBe(true);
    expect(
      linkGateFor(
        buildSyncedSession({
          updatedAt: ENDED_AT_TIE,
          endedAt: ENDED_AT_TIE,
          artifactRefs: refs,
        })
      ).didPreservePullRequestsOnTie
    ).toBe(false);

    await syncPrDetailRefs(refs, undefined, overrides);

    // Nothing to materialize and nothing to strand: a prose mention is not
    // provider-verifiable, so the lane never runs over it. This producer shuts
    // the gate for whatever else rides the same payload, which is the only way
    // it participates.
    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
  });

  it("shuts the gate for a monitored-activity-only ref, which the PR-detail lane never runs over", async () => {
    const m = installPrDetailIngestDb({ branches: [] });
    const refs = [monitoredActivityOnlyPrRef()];
    const overrides = {
      updatedAt: ENDED_AT_TIE,
      endedAt: ENDED_AT_TIE,
    } as Partial<SyncedAgentSession>;

    const gate = linkGateFor(
      buildSyncedSession({ ...overrides, artifactRefs: refs })
    );
    expect(gate.shouldUpdatePullRequestLinks).toBe(false);

    await syncPrDetailRefs(refs, undefined, overrides);

    // `collectPullRequestRefs` excludes the transport-only ref, so this target
    // is the monitored-activity classifier's alone and the PR lane reports no
    // deferral for it. Dropping that exclusion would put it on the lane's loop
    // and make this fix's admission load-bearing for it too.
    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.prCreateMany).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
  });
});
