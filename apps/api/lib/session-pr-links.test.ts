import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The merged-PR reader is the only DB-touching export exercised here, so the
// client is mocked down to the one delegate it calls: the case asserts the
// STATEMENT the reader builds (predicate, semi-join, select), which is what
// stops the ISS-6028 fix from silently regressing back to a row drain.
const findMany = vi.fn((_args: unknown) => Promise.resolve([]));

vi.mock("@repo/database", () => ({
  withDb: (
    fn: (db: { pullRequestDetail: { findMany: typeof findMany } }) => unknown
  ) => fn({ pullRequestDetail: { findMany } }),
}));

const {
  findMergedPrsLinkedToSessions,
  isMergedPrDetail,
  MERGED_PR_DETAIL_WHERE,
  SESSION_PR_LINK_WHERE,
  scopeToSessionsWithPrLinks,
  sessionPrLinkFromSessions,
} = await import("./session-pr-links");

describe("SESSION_PR_LINK_WHERE", () => {
  it("selects a RELATES_TO link whose linkKind metadata is SessionPr", () => {
    expect(SESSION_PR_LINK_WHERE).toEqual({
      linkType: LinkType.RelatesTo,
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionPr,
      },
    });
  });
});

describe("scopeToSessionsWithPrLinks", () => {
  it("ANDs a session→PR-link EXISTS filter onto the incoming where", () => {
    const where: Prisma.SessionDetailWhereInput = {
      userId: "user-1",
    };

    const scoped = scopeToSessionsWithPrLinks(where);

    expect(scoped).toEqual({
      AND: [
        where,
        { artifact: { sourceLinks: { some: SESSION_PR_LINK_WHERE } } },
      ],
    });
  });

  it("preserves an existing artifact clause instead of clobbering it", () => {
    // The usage `where` already scopes `artifact.is` (org/status/etc.). Wrapping
    // in `AND` — rather than spreading `artifact` — keeps that clause intact
    // alongside the new sourceLinks existence filter.
    const where: Prisma.SessionDetailWhereInput = {
      artifact: { is: { organizationId: "org-1" } },
    };

    const scoped = scopeToSessionsWithPrLinks(where);

    expect(scoped.AND).toEqual([
      { artifact: { is: { organizationId: "org-1" } } },
      { artifact: { sourceLinks: { some: SESSION_PR_LINK_WHERE } } },
    ]);
  });
});

describe("MERGED_PR_DETAIL_WHERE", () => {
  // The row this builds is derived FROM the mirror's own values, so the case
  // fails if either half of the pair moves: loosening/tightening
  // `isMergedPrDetail` breaks the accept assertion, and changing the mirror to a
  // value `isMergedPrDetail` rejects breaks it too. Asserting the const against
  // a second hand-written literal would pin neither.
  function detailMatching(mirror: typeof MERGED_PR_DETAIL_WHERE) {
    return {
      isCurrent: mirror.isCurrent,
      prState: mirror.prState,
      mergedAt: new Date("2026-07-15T12:00:00.000Z"),
      number: 1,
      repositoryFullName: "acme/repo",
      repository: { fullName: "acme/repo" },
    };
  }

  it("accepts exactly what isMergedPrDetail accepts", () => {
    const detail = detailMatching(MERGED_PR_DETAIL_WHERE);

    expect(isMergedPrDetail(detail)).toBe(true);
    // Each column the mirror constrains, violated one at a time.
    expect(isMergedPrDetail({ ...detail, isCurrent: false })).toBe(false);
    expect(isMergedPrDetail({ ...detail, prState: GitHubPRState.Open })).toBe(
      false
    );
    expect(isMergedPrDetail({ ...detail, mergedAt: null })).toBe(false);
  });

  it("constrains those three columns and nothing else", () => {
    // A new column in the mirror without a matching clause in `isMergedPrDetail`
    // (or vice versa) is the drift this pins.
    expect(Object.keys(MERGED_PR_DETAIL_WHERE).sort()).toEqual([
      "isCurrent",
      "mergedAt",
      "prState",
    ]);
    expect(MERGED_PR_DETAIL_WHERE.mergedAt).toEqual({ not: null });
  });
});

describe("findMergedPrsLinkedToSessions (ISS-6028)", () => {
  const ORGANIZATION_ID = "org-1";
  const where: Prisma.SessionDetailWhereInput = { userId: "user-1" };
  const linkedBranches = {
    artifact: { targetLinks: { some: sessionPrLinkFromSessions(where) } },
  };

  beforeEach(() => {
    findMany.mockClear();
  });

  function readArgs() {
    return findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
      take?: number;
    };
  }

  it("reads the PR side, semi-joined back through the session→PR links", async () => {
    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
    });

    // The scan population is merged PRs — NOT sessions. The session `where`
    // survives inside the link semi-join, so the same scope is honored.
    expect(readArgs().where).toEqual({
      // Org-scoped in the statement itself (not only through the join): it is
      // the tenant boundary AND the leading column of the index this predicate
      // shape targets.
      organizationId: ORGANIZATION_ID,
      ...MERGED_PR_DETAIL_WHERE,
      currentForBranches: { some: linkedBranches },
    });
    expect(sessionPrLinkFromSessions(where).source).toEqual({
      type: ArtifactType.Session,
      session: { is: where },
    });
  });

  it("returns the caller's columns plus the LINKED branch artifacts", async () => {
    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
      additions: true,
    });

    // The nested branch filter repeats the semi-join deliberately: a branch that
    // holds this PR as current but carries no matching session link must not
    // contribute a `branch:` identity the session-side traversal never saw.
    expect(readArgs().select).toEqual({
      number: true,
      additions: true,
      currentForBranches: {
        where: linkedBranches,
        select: { artifactId: true },
      },
    });
  });

  it("does NOT cap the read (whole-population aggregates)", async () => {
    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
    });

    // mergedPrCount and medianPrSize are whole-population figures over the
    // scope; a `take` would silently understate both rather than truncate
    // something the caller could report as partial.
    expect(readArgs().take).toBeUndefined();
  });
});
