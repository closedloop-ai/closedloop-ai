/**
 * ISS-9713 branch coverage for `loadSessionLocBranchIdentities` and
 * `sessionLocEntryBranchIdentity`. Drives the real reader against a minimal
 * `artifactLink` double and inspects the resulting identity map, so each
 * assertion pins an OBSERVABLE selection outcome rather than merely
 * executing a line.
 */
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // The real `sessionPrLinkKindWhere` always populates `.OR` for the Metric
  // audience, so `metricSessionPrLinkKindClauses`'s `?? []` fallback in
  // session-loc-branch-identity.ts is otherwise unreachable through this
  // module's real dependency. Mocking it to omit `.OR` is the only way to
  // exercise that fallback and prove what it produces.
  sessionPrLinkKindWhere: vi.fn(() => ({}) as { OR?: unknown[] }),
}));

vi.mock("@/lib/session-pr-links", () => ({
  SessionPrLinkAudience: { Metric: "metric", Evidence: "evidence" },
  sessionPrLinkKindWhere: mocks.sessionPrLinkKindWhere,
}));

import {
  loadSessionLocBranchIdentities,
  sessionLocEntryBranchIdentity,
} from "../session-loc-branch-identity";

const ORGANIZATION_ID = "org-1";
const DEFAULT_DATE = new Date("2026-01-01T00:00:00.000Z");

type LinkFixture = {
  sourceId: string;
  targetId: string;
  branchParticipation: string | null;
  lastContributedAt: Date | null;
  createdAt: Date;
  metadata: unknown;
  target: {
    name: string;
    branch: { branchName: string; repositoryFullName: string } | null;
  };
};

function branchLink(
  overrides: Partial<LinkFixture> & Pick<LinkFixture, "sourceId" | "targetId">
): LinkFixture {
  return {
    branchParticipation: BranchParticipationKind.Wrote,
    lastContributedAt: DEFAULT_DATE,
    createdAt: DEFAULT_DATE,
    metadata: null,
    target: {
      name: "fallback-display-name",
      branch: { branchName: "main", repositoryFullName: "org/repo" },
    },
    ...overrides,
  };
}

async function loadIdentities(links: LinkFixture[]) {
  const findMany = vi.fn((_args: { where: Record<string, unknown> }) =>
    Promise.resolve(links)
  );
  const db = { artifactLink: { findMany } };
  const sessionIds = [...new Set(links.map((link) => link.sourceId))];
  const result = await loadSessionLocBranchIdentities(
    db as unknown as Parameters<typeof loadSessionLocBranchIdentities>[0],
    ORGANIZATION_ID,
    sessionIds
  );
  return { result, findMany };
}

describe("loadSessionLocBranchIdentities", () => {
  it("drops session-branch links whose participation is Reviewed, an unrecognized non-null value, or resolves to an empty branch name", async () => {
    const { result } = await loadIdentities([
      branchLink({
        sourceId: "s-reviewed",
        targetId: "t-reviewed",
        branchParticipation: BranchParticipationKind.Reviewed,
      }),
      branchLink({
        sourceId: "s-other-participation",
        targetId: "t-other",
        branchParticipation: "mentioned",
      }),
      branchLink({
        sourceId: "s-no-branch-name",
        targetId: "t-no-branch",
        target: { name: "", branch: null },
      }),
    ]);

    expect(result.has("s-reviewed")).toBe(false);
    expect(result.has("s-other-participation")).toBe(false);
    expect(result.has("s-no-branch-name")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("derives participation from link metadata when the branchParticipation column is unset, dropping a Reviewed derivation but keeping Wrote and unknown at different priority tiers", async () => {
    const { result } = await loadIdentities([
      branchLink({
        sourceId: "s-meta-reviewed",
        targetId: "t-1",
        branchParticipation: null,
        metadata: { branchParticipation: "reviewed" },
      }),
      branchLink({
        sourceId: "s-meta-wrote",
        targetId: "t-2",
        branchParticipation: null,
        metadata: { branchParticipation: "wrote" },
      }),
      branchLink({
        sourceId: "s-meta-none",
        targetId: "t-3",
        branchParticipation: null,
        metadata: null,
      }),
    ]);

    expect(result.has("s-meta-reviewed")).toBe(false);
    expect(result.get("s-meta-wrote")).toEqual({
      repositoryFullName: "org/repo",
      branch: "main",
    });
    expect(result.get("s-meta-none")).toEqual({
      repositoryFullName: "org/repo",
      branch: "main",
    });
  });

  it("falls back to the target display name and the link's createdAt when branchName and lastContributedAt are absent", async () => {
    const { result } = await loadIdentities([
      branchLink({
        sourceId: "s-fallback",
        targetId: "t-1",
        lastContributedAt: null,
        target: { name: "display-name", branch: null },
      }),
    ]);

    expect(result.get("s-fallback")).toEqual({
      repositoryFullName: null,
      branch: "display-name",
    });
  });

  it("breaks a priority-and-recency tie by repository name, treating a missing repository as sorting before a named one", async () => {
    const tieDate = new Date("2026-02-01T00:00:00.000Z");
    const { result } = await loadIdentities([
      // Existing link has a named repo; the later link with no repo compares
      // as "less than" it and wins.
      branchLink({
        sourceId: "s-null-repo-wins",
        targetId: "t-1",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: { branchName: "branch-1", repositoryFullName: "repo-a" },
        },
      }),
      branchLink({
        sourceId: "s-null-repo-wins",
        targetId: "t-2",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: { branchName: "branch-1", repositoryFullName: "" },
        },
      }),
      // Existing link has no repo; the later link WITH a repo does not
      // compare as "less than" it, so the no-repo existing entry is kept.
      branchLink({
        sourceId: "s-null-repo-kept",
        targetId: "t-3",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: { branchName: "branch-2", repositoryFullName: "" },
        },
      }),
      branchLink({
        sourceId: "s-null-repo-kept",
        targetId: "t-4",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: { branchName: "branch-2", repositoryFullName: "repo-b" },
        },
      }),
    ]);

    expect(result.get("s-null-repo-wins")).toEqual({
      repositoryFullName: null,
      branch: "branch-1",
    });
    expect(result.get("s-null-repo-kept")).toEqual({
      repositoryFullName: null,
      branch: "branch-2",
    });
  });

  it("falls through to branch name when repository ties, and to target id when repository and branch both tie", async () => {
    const tieDate = new Date("2026-02-01T00:00:00.000Z");
    const { result } = await loadIdentities([
      branchLink({
        sourceId: "s-branch-decides",
        targetId: "t-1",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: { branchName: "branch-c1", repositoryFullName: "repo-tie" },
        },
      }),
      branchLink({
        sourceId: "s-branch-decides",
        targetId: "t-2",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: { branchName: "branch-c2", repositoryFullName: "repo-tie" },
        },
      }),
      // Fully tied on priority, recency, repository, AND branch — only the
      // target id comparison remains to produce a deterministic result. The
      // two candidates are content-identical by design (targetId is internal
      // and not part of the returned identity), so this pins that the
      // comparator completes and the reducer keeps exactly one entry rather
      // than which literal link supplied it.
      branchLink({
        sourceId: "s-full-tie",
        targetId: "t-d1",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: {
            branchName: "branch-tie",
            repositoryFullName: "repo-full-tie",
          },
        },
      }),
      branchLink({
        sourceId: "s-full-tie",
        targetId: "t-d2",
        lastContributedAt: tieDate,
        target: {
          name: "x",
          branch: {
            branchName: "branch-tie",
            repositoryFullName: "repo-full-tie",
          },
        },
      }),
    ]);

    expect(result.get("s-branch-decides")).toEqual({
      repositoryFullName: "repo-tie",
      branch: "branch-c1",
    });
    expect(result.size).toBe(2);
    expect(result.get("s-full-tie")).toEqual({
      repositoryFullName: "repo-full-tie",
      branch: "branch-tie",
    });
  });

  it("omits the SessionPr metric OR arm from the query when the shared predicate helper provides none", async () => {
    const { findMany } = await loadIdentities([
      branchLink({ sourceId: "s-1", targetId: "t-1" }),
    ]);

    if (findMany.mock.calls.length !== 1) {
      throw new Error(
        `expected one findMany call, got ${findMany.mock.calls.length}`
      );
    }
    const [{ where }] = findMany.mock.calls[0];
    expect(where.OR).toEqual([
      {
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionBranch,
        },
      },
    ]);
  });
});

describe("sessionLocEntryBranchIdentity", () => {
  it("falls back to the caller-supplied repositoryFullName when the resolved identity carries none", () => {
    const fallback = new Map([
      ["session-1", { repositoryFullName: null, branch: "feature-x" }],
    ]);

    const identity = sessionLocEntryBranchIdentity(
      "session-1",
      fallback,
      "org/fallback-repo"
    );

    expect(identity).toEqual({
      repositoryFullName: "org/fallback-repo",
      branch: "feature-x",
    });
  });
});
