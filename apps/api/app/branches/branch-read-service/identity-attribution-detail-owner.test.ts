import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { createMockDb } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  resolveBranchDetailIdentityData,
  resolveBranchListIdentityData,
} from "./identity-attribution";

/**
 * ISS-11738 — the DETAIL read must hand the projection each session's owner
 * PROFILE, not just the id.
 *
 * `canonical-projection.ts` stamps `ownerUnavailable: true` on the test
 * `!profile && ownerId`. This path resolved names only, so
 * `sessionOwnerProfileById` was empty for every branch and that test was true
 * for every session that HAS an owner — reporting "nobody could look this owner
 * up" about owners the same response names in `ownerUserName`. Measured in
 * production 2026-09-30 on `campaign-iss-11212-20260929-c2`, whose branch owner
 * resolved to "Kerensa Whitlock" while both of its sessions carried the flag.
 *
 * The projection half of the contract (flag on a genuinely unresolved owner,
 * absent on a resolved one) is pinned by `canonical-projection.test.ts`; this
 * pins the read that feeds it.
 */

const ORGANIZATION_ID = "org-1";
const BRANCH_ID = "branch-1";
const SESSION_ID = "session-1";
const OWNER_ID = "user-1";
const UNRESOLVABLE_OWNER_ID = "user-gone";
const NAMELESS_OWNER_ID = "user-nameless";

describe("list identity reuse", () => {
  it("preserves session-keyed owner profiles without a second identity-directory read", async () => {
    const { db, userFindMany } = detailClient([
      { sessionId: SESSION_ID, ownerId: OWNER_ID },
    ]);
    const canonical = await resolveBranchListIdentityData(
      db,
      ORGANIZATION_ID,
      [branchRow()],
      undefined
    );
    expect(
      canonical.lifetime.get(BRANCH_ID)?.sessionOwnerProfileById.get(SESSION_ID)
        ?.name
    ).toBe("Avery Example");
    userFindMany.mockClear();
    const windowed = await resolveBranchListIdentityData(
      db,
      ORGANIZATION_ID,
      [branchRow()],
      {
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-01-02T00:00:00Z"),
      },
      canonical
    );
    expect(windowed.identityByBranch).toBe(canonical.identityByBranch);
    expect(
      windowed.windowed.get(BRANCH_ID)?.sessionOwnerProfileById.get(SESSION_ID)
    ).toEqual({ name: "Avery Example", avatarUrl: "https://a.test/avery.png" });
    expect(
      windowed.lifetime.get(BRANCH_ID)?.sessionOwnerProfileById.get(SESSION_ID)
    ).toEqual({ name: "Avery Example", avatarUrl: "https://a.test/avery.png" });
    expect(userFindMany).not.toHaveBeenCalled();
  });
});

describe("resolveBranchDetailIdentityData owner profiles", () => {
  it("attaches the resolved owner profile so the projection does not report it unavailable", async () => {
    const { db } = detailClient([{ sessionId: SESSION_ID, ownerId: OWNER_ID }]);

    const { usageByBranch, nameById } = await resolveBranchDetailIdentityData(
      db,
      ORGANIZATION_ID,
      branchRow()
    );

    const usage = usageByBranch.get(BRANCH_ID);
    expect(usage?.sessionOwnerById.get(SESSION_ID)).toBe(OWNER_ID);
    // The assertion the bug failed: an owner id WITH a profile beside it, which
    // is what keeps `!profile && ownerId` false in the projection.
    expect(usage?.sessionOwnerProfileById.get(SESSION_ID)).toEqual({
      name: "Avery Example",
      avatarUrl: "https://a.test/avery.png",
    });
    // The name half still reaches `attachSessionOwnerNames` off the same read.
    expect(nameById.get(OWNER_ID)).toBe("Avery Example");
  });

  it("leaves an owner the directory cannot resolve without a profile", async () => {
    const { db } = detailClient([
      { sessionId: SESSION_ID, ownerId: UNRESOLVABLE_OWNER_ID },
    ]);

    const { usageByBranch, nameById } = await resolveBranchDetailIdentityData(
      db,
      ORGANIZATION_ID,
      branchRow()
    );

    const usage = usageByBranch.get(BRANCH_ID);
    // The counterfactual that keeps the first case honest: `ownerUnavailable`
    // must stay REACHABLE for the case it actually describes, so a fix that
    // fabricated a profile for every owner id would fail here.
    expect(usage?.sessionOwnerById.get(SESSION_ID)).toBe(UNRESOLVABLE_OWNER_ID);
    expect(usage?.sessionOwnerProfileById.get(SESSION_ID)).toBeUndefined();
    expect(nameById.get(UNRESOLVABLE_OWNER_ID)).toBeUndefined();
  });

  it("gives an owner with no name parts no profile, so their email is never the chip name", async () => {
    const { db } = detailClient([
      { sessionId: SESSION_ID, ownerId: NAMELESS_OWNER_ID },
    ]);

    const { usageByBranch, nameById } = await resolveBranchDetailIdentityData(
      db,
      ORGANIZATION_ID,
      branchRow()
    );

    const usage = usageByBranch.get(BRANCH_ID);
    // whitlockk review — the chip profile is name parts ONLY. `displayUserName`
    // falls back to email, and the profile's `name` reaches the wire as
    // `ownerName`, so an email-only owner must stay absent from this map (→
    // `ownerUnavailable`) exactly as they already do on the list path
    // (`branch-read-service.owner.test.ts`).
    expect(usage?.sessionOwnerById.get(SESSION_ID)).toBe(NAMELESS_OWNER_ID);
    expect(usage?.sessionOwnerProfileById.get(SESSION_ID)).toBeUndefined();
    // `nameById` keeps its own long-standing display-name derivation, which the
    // detail response reads as `ownerUserName`; this change does not touch it.
    expect(nameById.get(NAMELESS_OWNER_ID)).toBe("private-owner@example.com");
  });

  it("adds no User read to the two this path already issued", async () => {
    const { db, userFindMany } = detailClient([
      { sessionId: "session-a", ownerId: OWNER_ID },
      { sessionId: "session-b", ownerId: OWNER_ID },
      { sessionId: "session-c", ownerId: null },
    ]);

    await resolveBranchDetailIdentityData(db, ORGANIZATION_ID, branchRow());

    // Two, and only two: `resolveBranchIdentities`'s own directory read, plus
    // the owner-profile read. `resolveOwnerNames` WAS that second read with the
    // picture dropped, so taking the profiles instead is the same statement —
    // three would be the N+1 `resolveOwnerProfiles` documents itself as
    // avoiding, and three sessions sharing one owner must not become three.
    expect(userFindMany).toHaveBeenCalledTimes(2);
    for (const call of userFindMany.mock.calls) {
      expect(call[0]?.where).toMatchObject({
        organizationId: ORGANIZATION_ID,
      });
    }
  });
});

function branchRow() {
  return {
    id: BRANCH_ID,
    assigneeId: null,
    branch: { firstPushedAt: new Date("2026-01-01T00:00:00.000Z") },
    pullRequestDetails: [],
  };
}

function detailClient(
  sessions: readonly { sessionId: string; ownerId: string | null }[]
) {
  const userFindMany = vi.fn().mockResolvedValue([
    {
      id: OWNER_ID,
      clerkId: "clerk-owner",
      email: "avery@example.com",
      firstName: "Avery",
      lastName: "Example",
      avatarUrl: "https://a.test/avery.png",
    },
    {
      id: NAMELESS_OWNER_ID,
      clerkId: "clerk-nameless-owner",
      email: "private-owner@example.com",
      firstName: null,
      lastName: null,
      avatarUrl: null,
    },
  ]);
  const db = {
    ...createMockDb(),
    artifactLink: {
      findMany: vi.fn().mockResolvedValue(sessions.map(linkRow)),
    },
    // ISS-12251: each pushing session's creator; this fixture's sessions were
    // created by the person they are assigned to.
    artifact: {
      findMany: vi.fn().mockResolvedValue(
        sessions.map(({ sessionId, ownerId }) => ({
          id: sessionId,
          createdById: ownerId,
        }))
      ),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    agentSessionTokenEvent: { findMany: vi.fn().mockResolvedValue([]) },
    comment: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubCommentProjection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubUserConnection: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: userFindMany },
  };
  return { db: db as never, userFindMany };
}

function linkRow({
  sessionId,
  ownerId,
}: {
  sessionId: string;
  ownerId: string | null;
}) {
  return {
    targetId: BRANCH_ID,
    sourceId: sessionId,
    branchParticipation: BranchParticipationKind.Wrote,
    branchParticipationMethod: "git_push",
    branchParticipationObservedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    source: {
      name: sessionId,
      slug: sessionId,
      status: "inactive",
      assigneeId: ownerId,
      session: {
        artifactId: sessionId,
        externalSessionId: `ext-${sessionId}`,
        harness: "claude",
        sessionStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        sessionEndedAt: new Date("2026-01-01T01:00:00.000Z"),
        lastActivityAt: new Date("2026-01-01T01:00:00.000Z"),
        awaitingInputSince: null,
        endsWithError: false,
        estimatedCost: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: 1,
        toolUseCount: 0,
        componentInvocationCount: 0,
        billingMode: null,
      },
    },
  };
}
