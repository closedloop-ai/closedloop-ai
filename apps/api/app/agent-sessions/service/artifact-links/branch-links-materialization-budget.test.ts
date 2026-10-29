/**
 * ISS-8186 path 3: the session→branch lane's per-identity materialization.
 *
 * `persistSessionBranchArtifactLinks` awaits `ensureBranchArtifactRow` once per
 * DISTINCT branch identity folded from the session's whole `artifactRefs` array,
 * inside that session's own write transaction. It runs BEFORE
 * `persistMonitoredSessionActivity`, so `collectCandidates`' 100-candidate
 * truncation bounds a later lane and never this one — the claim #5990's
 * docstring originally made and had to withdraw (whitlockk). One session could
 * therefore time out inside its own transaction and retry the identical work.
 *
 * The bound is a deferral, not a truncation, so the two assertions that matter
 * are paired everywhere below: the lane stops materializing at the budget, AND
 * every identity past it reaches the durable retry store, from which
 * `drainBranchMaterializationRetries` materializes it with the same
 * `materializeSessionBranchAggregate` this lane would have used.
 *
 * Drives `persistSessionBranchArtifactLinks` directly against a transaction
 * double and asserts after the call, on the `branch-links-push-gate` precedent.
 */

import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BranchLinksTxDouble,
  branchAuthorityMap,
  makeBranchLinksTx,
} from "@/__tests__/support/agent-sessions/branch-links.test-harness";
import { SessionIngestWorkBudget } from "../ingest-work-budget";
import { persistSessionBranchArtifactLinks } from "./branch-links";

const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;
const OBSERVED_AT = "2026-05-20T17:03:00.000Z";
const ORG = "org-1";
const SESSION_ARTIFACT_ID = "persisted-session-1";
const REPO = "acme/web";
const BUDGET = SessionIngestWorkBudget.BranchMaterializationsPerSession;

/**
 * `BUDGET + 37`. An independently chosen overflow, large enough that a
 * one-identity off-by-one could not pass and small enough to stay a readable
 * fixture; the count is expressed relative to the budget because the property
 * under test IS "more identities than the budget", which a bare literal would
 * stop describing the moment the budget moved.
 */
const OVERFLOW = 37;

/** A pushed branch ref: eligible to materialize, so only the budget can stop it. */
function pushedRef(index: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPO,
    branchName: `feat/branch-${index}`,
    method: GIT_PUSH_METHOD,
    relation: ArtifactRefRelation.Created,
    observedAt: OBSERVED_AT,
  };
}

function pushedRefs(count: number): SyncedArtifactRef[] {
  return Array.from({ length: count }, (_, index) => pushedRef(index));
}

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

/**
 * The branch names the lane ENQUEUED for retry, read off the one bulk write the
 * retry store issues. Read from the real `Prisma.Sql` values rather than from a
 * spy on the store, so the assertion describes what would reach the database.
 */
function enqueuedBranchNames(double: BranchLinksTxDouble): string[] {
  const names = new Set<string>();
  for (const call of double.queryRaw.mock.calls) {
    const statement = call[0] as
      | { sql?: string; values?: unknown[] }
      | undefined;
    if (!statement?.sql?.includes("INSERT INTO")) {
      continue;
    }
    for (const value of statement?.values ?? []) {
      if (typeof value === "string" && value.startsWith("feat/branch-")) {
        names.add(value);
      }
    }
  }
  return [...names];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ISS-8186 branch materialization budget", () => {
  it("materializes exactly the budget and no more, however many identities arrive", async () => {
    const double = makeBranchLinksTx();

    await run(double, pushedRefs(BUDGET + OVERFLOW));

    // Exactly the budget lands in one set read and two batch inserts.
    expect(double.branchDetailFindMany).toHaveBeenCalledTimes(1);
    expect(double.branchDetailFindMany.mock.calls[0][0].where.OR).toHaveLength(
      BUDGET
    );
    expect(double.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(double.branchCreateMany).toHaveBeenCalledTimes(1);
    expect(double.artifactCreateMany.mock.calls[0][0].data).toHaveLength(
      BUDGET
    );
    expect(double.branchCreateMany.mock.calls[0][0].data).toHaveLength(BUDGET);
    expect(double.linkRow).toHaveBeenCalledTimes(BUDGET);
  });

  it("defers every identity past the budget to the durable retry store", async () => {
    const double = makeBranchLinksTx();

    await run(double, pushedRefs(BUDGET + OVERFLOW));

    // Bounded, never dropped: the tail is enqueued in full, so the cron drain
    // materializes it with the same aggregate this lane folded. A truncating
    // bound would leave this empty and lose the branches silently.
    const enqueued = enqueuedBranchNames(double);
    expect(enqueued).toHaveLength(OVERFLOW);
    expect(new Set(enqueued)).toEqual(
      new Set(
        Array.from(
          { length: OVERFLOW },
          (_, index) => `feat/branch-${BUDGET + index}`
        )
      )
    );
  });

  it("splits on the payload's own ref order, so a retry defers the same tail", async () => {
    const first = makeBranchLinksTx();
    const second = makeBranchLinksTx();
    const refs = pushedRefs(BUDGET + OVERFLOW);

    await run(first, refs);
    await run(second, refs);

    // A split that churned would re-enqueue a different tail on every sync and
    // never let the drain settle any of them.
    expect(enqueuedBranchNames(second)).toEqual(enqueuedBranchNames(first));
  });

  it("leaves an in-budget session materializing every identity inline", async () => {
    const double = makeBranchLinksTx();

    await run(double, pushedRefs(BUDGET));

    // No cap was introduced for ordinary payloads: at the budget nothing defers,
    // so a session any shipping desktop emits behaves exactly as before.
    expect(double.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(double.artifactCreateMany.mock.calls[0][0].data).toHaveLength(
      BUDGET
    );
    expect(enqueuedBranchNames(double)).toEqual([]);
  });
});
