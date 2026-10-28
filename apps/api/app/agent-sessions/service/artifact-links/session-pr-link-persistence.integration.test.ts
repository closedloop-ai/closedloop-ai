/**
 * ISS-9859: the wire marker → write-mode derivation, end to end.
 *
 * `resolveSessionPrLinkWriteMode` turns two CLIENT-CONTROLLED fields —
 * `prRefsPaginated` and `chunk`, both set by the desktop and carried on the
 * sync payload — into whether the link lane retracts at all. Replace prunes,
 * downgrades and deletes; Merge does none of it. Nothing else in the suite
 * exercises that decision: the sibling suites call `persistSessionPrArtifactLinks`
 * with a hand-built `mode`, which bypasses the derivation entirely.
 *
 * So these drive the real wrapper, `persistSessionPullRequestArtifactLinks`, the
 * one production calls, and assert the DECISION by its observable effect on the
 * stored links rather than by inspecting a returned enum.
 */
import {
  MAX_SESSION_SYNC_CHUNKS,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  linkedPrNumbers,
  prRef,
  SESSION_PR_LINK_REPO,
  type SessionPrLinkFixture,
  seedSessionPrLinkFixture,
  sessionPrLinkMetadata,
} from "@/__tests__/support/agent-sessions/session-pr-links.test-harness";
import { autoRollbackTransaction } from "@/__tests__/utils/db-helpers";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "./pull-request-details";
import { persistSessionPullRequestArtifactLinks } from "./session-pr-link-persistence";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb("ISS-9859: prRefsPaginated → write-mode derivation", () => {
  it("MERGES a marked continuation part, so page-0 identities survive", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, {
        prNumbers: [1, 2],
        chunk: { index: 0, total: 3 },
      });
      expect(await linkedPrNumbers(fixture)).toEqual([1, 2]);

      await persistThroughWrapper(fixture, {
        prNumbers: [3],
        prRefsPaginated: true,
        chunk: { index: 1, total: 3 },
      });

      expect(await linkedPrNumbers(fixture)).toEqual([1, 2, 3]);
    });
  });

  it("falls back to REPLACE when the marker arrives with no chunk marker at all", () => {
    // The guard that stops stale links persisting forever. A payload claiming to
    // be a continuation while carrying no sequence is malformed (or from some
    // future producer); treating it as Merge would mean nothing ever retracts.
    //
    // Asserted on `relationTypes`, NOT on which links survive. PRs 1 and 2 both
    // resolve to branch-1, so they share ONE link row, and both modes leave it
    // in place: Replace upserts it with the incoming slice, Merge folds into it.
    // An assertion on the linked ID set would therefore pass whichever branch
    // ran. `relationTypes` on that row is the channel that DOES differ: Replace
    // derives it from the incoming slice alone, Merge from the folded union.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, {
        prNumbers: [1],
        relationType: SessionPrRelationType.Created,
      });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        relationType: SessionPrRelationType.Reviewed,
        prRefsPaginated: true,
      });

      expect(
        (await sessionPrLinkMetadata(fixture, "branch-1")).relationTypes
      ).toEqual([SessionPrRelationType.Reviewed]);
    });
  });

  it("falls back to REPLACE when the marker arrives on chunk 0", () => {
    // Chunk 0 is never a later page, so a `true` marker there is the same
    // malformed shape as the case above.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, {
        prNumbers: [1],
        relationType: SessionPrRelationType.Created,
      });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        relationType: SessionPrRelationType.Reviewed,
        prRefsPaginated: true,
        chunk: { index: 0, total: 2 },
      });

      expect(
        (await sessionPrLinkMetadata(fixture, "branch-1")).relationTypes
      ).toEqual([SessionPrRelationType.Reviewed]);
    });
  });

  it("falls back to REPLACE when the marked part claims more parts than MAX_SESSION_SYNC_CHUNKS", () => {
    // Review (davetho): both chunk fields are client-controlled, and the wire
    // schema bounds `total` from below only. Merged, a sequence that never
    // commits could add links forever with no retraction running.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      const total = MAX_SESSION_SYNC_CHUNKS + 1;

      await persistThroughWrapper(fixture, {
        prNumbers: [1, 3],
        chunk: { index: 0, total },
      });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        prRefsPaginated: true,
        chunk: { index: 1, total },
      });

      // Replace: PR 3's branch-2 link is retracted and branch-1 now holds only
      // PR 2. Merge would have kept all three.
      expect(await linkedPrNumbers(fixture)).toEqual([2]);
    });
  });

  it("falls back to REPLACE when the marked part's index is not below its total", () => {
    // The wire schema refuses this shape before it gets here. The predicate
    // does not lean on that, because both lanes call it with whatever payload
    // reaches them.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, { prNumbers: [1, 3] });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        prRefsPaginated: true,
        chunk: { index: 3, total: 3 },
      });

      expect(await linkedPrNumbers(fixture)).toEqual([2]);
    });
  });

  it("REPLACES page 0 (an explicit false marker) mid-sequence", () => {
    // Page 0 of a paginated sequence carries `false` and lands at a non-zero
    // index once events pack ahead of it. It must still replace — that is what
    // makes the whole no-ledger design work.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, {
        prNumbers: [1],
        relationType: SessionPrRelationType.Created,
      });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        relationType: SessionPrRelationType.Reviewed,
        prRefsPaginated: false,
        chunk: { index: 1, total: 3 },
      });

      expect(
        (await sessionPrLinkMetadata(fixture, "branch-1")).relationTypes
      ).toEqual([SessionPrRelationType.Reviewed]);
    });
  });

  it("REPLACES a payload with no marker even mid-sequence", () => {
    // No key is a whole-set payload wherever it lands in a sequence.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, {
        prNumbers: [1],
        relationType: SessionPrRelationType.Created,
      });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        relationType: SessionPrRelationType.Reviewed,
        chunk: { index: 1, total: 3 },
      });

      expect(
        (await sessionPrLinkMetadata(fixture, "branch-1")).relationTypes
      ).toEqual([SessionPrRelationType.Reviewed]);
    });
  });

  it("COUNTERFACTUAL: a marked continuation part UNIONS the same two payloads", () => {
    // The discriminator, proven. Identical payloads to the cases above; only
    // the marker+index differ. Merge folds, so both relations survive — which
    // is exactly what those cases assert must NOT happen.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistThroughWrapper(fixture, {
        prNumbers: [1],
        relationType: SessionPrRelationType.Created,
      });
      await persistThroughWrapper(fixture, {
        prNumbers: [2],
        relationType: SessionPrRelationType.Reviewed,
        prRefsPaginated: true,
        chunk: { index: 1, total: 3 },
      });

      expect(
        (await sessionPrLinkMetadata(fixture, "branch-1")).relationTypes
      ).toEqual([
        SessionPrRelationType.Created,
        SessionPrRelationType.Reviewed,
      ]);
    });
  });
});

function seedFixture(): Promise<SessionPrLinkFixture> {
  return seedSessionPrLinkFixture("iss9859-mode", {
    1: "branch-1",
    2: "branch-1",
    3: "branch-2",
  });
}

/** PRs 1-2 share branch-1; PR 3 is on branch-2, so a Replace is observable. */
function detailMap(fixture: SessionPrLinkFixture): SessionPullRequestDetailMap {
  return new Map(
    [1, 2, 3].map((prNumber) => [
      sessionPullRequestDetailKey(SESSION_PR_LINK_REPO, prNumber),
      {
        prDetailId: `prd-${prNumber}`,
        branchArtifactId:
          prNumber === 3
            ? fixture.branchArtifactIds["branch-2"]
            : fixture.branchArtifactIds["branch-1"],
      },
    ])
  );
}

function persistThroughWrapper(
  fixture: SessionPrLinkFixture,
  payload: {
    prNumbers: number[];
    relationType?: SessionPrRelationType;
    prRefsPaginated?: boolean;
    chunk?: { index: number; total: number };
  }
): Promise<void> {
  const session: SyncedAgentSession = {
    externalSessionId: "sess-iss9859-mode",
    name: "mode derivation",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    prRefs: payload.prNumbers.map((prNumber) =>
      prRef(prNumber, payload.relationType ?? SessionPrRelationType.Created)
    ),
    ...(payload.prRefsPaginated === undefined
      ? {}
      : { prRefsPaginated: payload.prRefsPaginated }),
    ...(payload.chunk ? { chunk: payload.chunk } : {}),
  };
  return withDb((db) =>
    persistSessionPullRequestArtifactLinks(db, {
      organizationId: fixture.organizationId,
      sessionArtifactId: fixture.sessionArtifactId,
      session,
      pullRequestDetails: detailMap(fixture),
    })
  );
}
