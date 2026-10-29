/**
 * ISS-8148 — the push gate on session→branch materialization.
 *
 * Every case here drives `persistSessionBranchArtifactLinks` DIRECTLY against a
 * transaction double and awaits it, so a throw anywhere in the lane fails the
 * test. An earlier revision drove the whole `upsertSessions` path and swallowed
 * the PR lane's error with `.catch()`; that was a false green, because the real
 * upsert wraps both lanes in one transaction, so the swallowed error would roll
 * back the very `artifact.create` and link the assertions then read off the mock.
 */

import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BranchLinksTxDouble,
  branchAuthorityMap,
  makeBranchLinksTx,
} from "@/__tests__/support/agent-sessions/branch-links.test-harness";
import {
  hasBranchPushEvidence,
  persistSessionBranchArtifactLinks,
} from "./branch-links";

const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;
const OBSERVED_AT = "2026-05-20T17:03:00.000Z";
const ORG = "org-1";
const SESSION_ARTIFACT_ID = "persisted-session-1";
const REPO = "acme/web";
const BRANCH = "feat/x";
/** Pinned system time for the timestamp-less-push upper-bound stamp. */
const INGEST_AT = "2026-05-02T00:00:00.000Z";

/** A branch a session only ever touched locally: no push method, no PR, no remote-implying boundary. */
const LOCAL_ONLY_REF: SyncedArtifactRef = {
  kind: ArtifactRefTargetKind.Branch,
  repositoryFullName: REPO,
  branchName: BRANCH,
  method: ArtifactRefMethod.GitCommand,
  relation: ArtifactRefRelation.Created,
  observedAt: OBSERVED_AT,
  branchLifecycleEvents: [
    {
      kind: BranchLifecycleBoundaryKind.BranchWrite,
      observedAt: OBSERVED_AT,
      evidenceId: "desktop-artifact-link:l-1",
    },
  ],
};

function run(
  double: BranchLinksTxDouble,
  artifactRefs: SyncedArtifactRef[]
): Promise<void> {
  return persistSessionBranchArtifactLinks(
    double.tx,
    ORG,
    null,
    SESSION_ARTIFACT_ID,
    artifactRefs,
    branchAuthorityMap([REPO])
  );
}

function deferredRefsFrom(double: BranchLinksTxDouble): unknown {
  const call = double.sessionDetailUpdate.mock.calls.find(
    (entry) =>
      (entry[0] as { data?: { metadata?: Record<string, unknown> } }).data
        ?.metadata?._unresolvedBranchRefs !== undefined
  );
  return (
    call?.[0] as { data: { metadata: { _unresolvedBranchRefs: unknown } } }
  )?.data.metadata._unresolvedBranchRefs;
}

describe("ISS-8148 push-gated branch materialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Unconditional: a case that installs fake timers must not leak a frozen
  // clock into its siblings when an assertion throws (AGENTS.md).
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers a local-only branch: no artifact row, no session link, no push stamp", async () => {
    const double = makeBranchLinksTx();

    await run(double, [LOCAL_ONLY_REF]);

    // Ruling 2: the row must not materialize at all — read-side exclusion is the
    // safety net for legacy rows, not the mechanism for new ones.
    expect(double.artifactCreateMany).not.toHaveBeenCalled();
    expect(double.linkRow).not.toHaveBeenCalled();
    expect(double.pushRow).not.toHaveBeenCalled();
    // Deferred, not dropped: written to the DURABLE retry store, so the heal
    // does not depend on this ref surviving the Desktop's ref cap into a later
    // payload. The enqueue is the only raw SQL this path issues — the link
    // path's advisory locks never run, because no link is written.
    expect(double.queryRaw).toHaveBeenCalled();
    expect(deferredRefsFrom(double)).toBeUndefined();
  });

  it("materializes and links once a push is observed", async () => {
    const double = makeBranchLinksTx();

    await run(double, [{ ...LOCAL_ONLY_REF, method: GIT_PUSH_METHOD }]);

    expect(double.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(double.branchCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      repositoryFullName: REPO,
      branchName: BRANCH,
    });
    expect(double.linkRow).toHaveBeenCalledTimes(1);
    expect(double.pushRow.mock.calls[0][0]).toMatchObject({
      firstPushedAt: new Date(OBSERVED_AT),
    });
  });

  it("accepts a push from an older Desktop build that sent no timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INGEST_AT));
    const double = makeBranchLinksTx();
    const { observedAt: _dropped, ...noTimestamp } = LOCAL_ONLY_REF as Record<
      string,
      unknown
    >;

    await run(double, [
      { ...noTimestamp, method: GIT_PUSH_METHOD } as SyncedArtifactRef,
    ]);

    // `observedAt` is optional on the wire. Gating on the TIMESTAMP would read
    // this real push as "never pushed" and drop the branch entirely.
    expect(double.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(double.linkRow).toHaveBeenCalledTimes(1);
    // ISS-8148 (review): the push is real but timeless, so the lane stamps the
    // ingest instant as an UPPER BOUND — leaving the row unstamped would hide
    // a genuinely pushed branch from every publication-gated population,
    // metric denominators included. `stampBranchFirstPush` overwrites any
    // LATER stored value, so the first timestamped push evidence corrects this
    // stamp downward.
    expect(double.pushRow).toHaveBeenCalledWith(
      expect.objectContaining({
        firstPushedAt: new Date(INGEST_AT),
        pushSource: BranchPushSource.Session,
      })
    );
  });

  it("does not materialize from same-batch PR refs in the branch lane", async () => {
    const double = makeBranchLinksTx();

    // The branch lane runs before the gated PR detail/link lanes. Reading PR
    // refs here would let a stale replay create identity-less branch evidence.
    await run(double, [
      LOCAL_ONLY_REF,
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPO,
        branchName: BRANCH,
        prNumber: 41,
        method: ArtifactRefMethod.HarnessPrLink,
        relation: ArtifactRefRelation.Created,
        observedAt: OBSERVED_AT,
      },
    ]);

    expect(double.artifactCreateMany).not.toHaveBeenCalled();
    expect(double.linkRow).not.toHaveBeenCalled();
    expect(double.queryRaw).toHaveBeenCalled();
  });

  it("keeps attaching sessions to an already-materialized branch with no push evidence (D7: exclude, never drop)", async () => {
    const double = makeBranchLinksTx("branch-x");

    await run(double, [LOCAL_ONLY_REF]);

    // A legacy row keeps its session attachments — the read side hides it until
    // push evidence arrives, and nothing is deleted.
    expect(double.artifactCreateMany).not.toHaveBeenCalled();
    expect(double.linkRow).toHaveBeenCalledTimes(1);
    expect(double.linkRow.mock.calls[0][0].targetId).toBe("branch-x");
  });

  it("materializes on a pr_raised boundary alone without stamping a push it never observed", async () => {
    const double = makeBranchLinksTx();

    await run(double, [
      {
        ...LOCAL_ONLY_REF,
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.PrRaised,
            observedAt: OBSERVED_AT,
            evidenceId: "desktop-artifact-link:pr-1",
          },
        ],
      },
    ]);

    expect(double.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(double.pushRow).not.toHaveBeenCalled();
  });
});

describe("hasBranchPushEvidence", () => {
  it("treats a local commit boundary as no evidence", () => {
    // The counterfactual for the gate: if BRANCH_LIFECYCLE_IMPLIES_REMOTE were
    // inverted, or the gate defaulted open, this would be true and every
    // local-only branch would materialize again.
    expect(
      hasBranchPushEvidence({
        pushObserved: false,
        branchLifecycleEvents: [
          { kind: BranchLifecycleBoundaryKind.BranchWrite },
        ],
        pullRequestObserved: false,
      })
    ).toBe(false);
  });

  it("accepts a push observation, a PR ref, and a PR-bound boundary", () => {
    expect(
      hasBranchPushEvidence({
        pushObserved: true,
        branchLifecycleEvents: [],
        pullRequestObserved: false,
      })
    ).toBe(true);
    expect(
      hasBranchPushEvidence({
        pushObserved: false,
        branchLifecycleEvents: [],
        pullRequestObserved: true,
      })
    ).toBe(true);
    expect(
      hasBranchPushEvidence({
        pushObserved: false,
        branchLifecycleEvents: [
          { kind: BranchLifecycleBoundaryKind.ReviewFeedback },
        ],
        pullRequestObserved: false,
      })
    ).toBe(true);
  });

  it("reads no evidence out of an empty ref", () => {
    expect(
      hasBranchPushEvidence({
        pushObserved: false,
        branchLifecycleEvents: [],
        pullRequestObserved: false,
      })
    ).toBe(false);
  });
});
