import { ArtifactSubtype, LinkType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  syncPullRequestLabelsFromArtifactTags: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: mocks.withDb,
  };
});

vi.mock("@/lib/github/pull-request-label-sync", () => ({
  syncPullRequestLabelsFromArtifactTags:
    mocks.syncPullRequestLabelsFromArtifactTags,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";
import {
  ArtifactLabelReconciliationStatus,
  reconcileLinkedPullRequestLabelsForArtifact,
  reconcileLinkedPullRequestLabelsForArtifacts,
} from "@/lib/github/artifact-tag-label-reconciliation";

const ORGANIZATION_ID = "org-1";
const ARTIFACT_ID = "artifact-1";
const PLAN_ID = "plan-1";

type LinkedSide = {
  projectId: string;
  targetLinks: {
    sourceId: string;
    source: {
      subtype: string | null;
      targetLinks: { sourceId: string }[];
    } | null;
  }[];
};

type Row = {
  id: string;
  number: number;
  artifact: LinkedSide | null;
  branchArtifact: LinkedSide | null;
  repository: {
    owner: string;
    name: string;
    installation: { installationId: string };
  } | null;
};

type LinkFilter = {
  linkType: string;
  OR: [{ sourceId: string }, { source: unknown }];
};

type FindManyArgs = {
  where: {
    OR: [
      { branchArtifact: { targetLinks: { some: LinkFilter } } },
      { artifact: { targetLinks: { some: LinkFilter } } },
    ];
  };
  take: number;
  cursor?: { id: string };
  skip?: number;
};

function producingLink(sourceId: string): LinkedSide {
  return {
    projectId: "project-1",
    targetLinks: [{ sourceId, source: null }],
  };
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "pr-detail-1",
    number: 42,
    artifact: null,
    branchArtifact: producingLink(ARTIFACT_ID),
    repository: {
      owner: "acme",
      name: "widgets",
      installation: { installationId: "install-9" },
    },
    ...overrides,
  };
}

function makeRows(count: number, startIndex = 0): Row[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeRow({
      id: `pr-detail-${startIndex + index}`,
      number: startIndex + index,
    })
  );
}

/**
 * Serve paged rows per requested artifact, honouring the cursor exactly like
 * Prisma does, so the pagination the production code performs is really
 * exercised rather than assumed.
 */
function installRowsByArtifact(byArtifact: Map<string, Row[]>) {
  const findMany = vi.fn((args: FindManyArgs) => {
    const artifactId =
      args.where.OR[0].branchArtifact.targetLinks.some.OR[0].sourceId;
    const rows = byArtifact.get(artifactId) ?? [];
    const cursorId = args.cursor?.id;
    const start = cursorId
      ? rows.findIndex((row) => row.id === cursorId) + 1
      : 0;
    return Promise.resolve(rows.slice(start, start + args.take));
  });
  mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) =>
    Promise.resolve(cb({ pullRequestDetail: { findMany } }))
  );
  return findMany;
}

function installRows(rows: Row[]) {
  return installRowsByArtifact(new Map([[ARTIFACT_ID, rows]]));
}

function appliedSyncResult() {
  return {
    status: "applied",
    createdLabels: [],
    addedLabels: ["infra"],
    droppedLabels: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncPullRequestLabelsFromArtifactTags.mockResolvedValue(
    appliedSyncResult()
  );
});

describe("reconcileLinkedPullRequestLabelsForArtifact", () => {
  // ISS-4760: applying a tag in Closedloop fires no GitHub linkage webhook, so
  // without this the new tag sat un-propagated until someone edited or reopened
  // the PR on GitHub.
  it("reconciles every pull request the artifact produces", async () => {
    installRows([
      makeRow(),
      makeRow({
        id: "pr-detail-2",
        number: 43,
        repository: {
          owner: "acme",
          name: "other",
          installation: { installationId: "install-7" },
        },
      }),
    ]);

    const outcome = await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(outcome.status).toBe(ArtifactLabelReconciliationStatus.Complete);
    expect(outcome.reconciledCount).toBe(2);
    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: "project-1",
      artifactId: ARTIFACT_ID,
      installationId: "install-9",
      owner: "acme",
      repo: "widgets",
      pullNumber: 42,
    });
  });

  // The webhook path has always fallen back from `branchArtifact` to the legacy
  // PR-owned `artifact` relation. Reading only `branchArtifact` here excluded
  // every pre-branch-first row from tag-change reconciliation entirely.
  it("queries both the branch-owned and the legacy PR-owned link shape", async () => {
    const findMany = installRows([
      makeRow({ artifact: producingLink(ARTIFACT_ID), branchArtifact: null }),
    ]);

    await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where.OR[0].branchArtifact.targetLinks.some.OR[0]).toEqual({
      sourceId: ARTIFACT_ID,
    });
    expect(args.where.OR[1].artifact.targetLinks.some.linkType).toBe(
      LinkType.Produces
    );
    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: ARTIFACT_ID })
    );
  });

  // ISS-4760 single label-source identity: the link-PR dialog gives the PLAN
  // the produces-link and the ISSUE the tags, and the webhook resolves the same
  // way. A plan-owned link therefore has to label from the issue that produces
  // the plan, or the two paths label one pull request out of two documents.
  it("labels a plan-owned link from the issue that produces the plan", async () => {
    installRows([
      makeRow({
        branchArtifact: {
          projectId: "project-1",
          targetLinks: [
            {
              sourceId: PLAN_ID,
              source: {
                subtype: ArtifactSubtype.ImplementationPlan,
                targetLinks: [{ sourceId: ARTIFACT_ID }],
              },
            },
          ],
        },
      }),
    ]);

    await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: ARTIFACT_ID })
    );
  });

  // Reading one bounded page and dropping the rest meant stable ordering skipped
  // the SAME rows forever while the tag mutation reported success.
  it("pages through the full linked pull-request set", async () => {
    const findMany = installRows(makeRows(30));

    const outcome = await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledTimes(
      30
    );
    expect(findMany.mock.calls.length).toBeGreaterThan(1);
    expect(findMany.mock.calls[1][0].cursor).toBeDefined();
    expect(outcome.truncated).toBe(false);
    expect(outcome.status).toBe(ArtifactLabelReconciliationStatus.Complete);
  });

  // The ceiling is a resource bound, not a licence to lie: hitting it must be
  // reported as an explicitly retryable partial outcome.
  it("reports a truncated pass instead of silently succeeding", async () => {
    installRows(makeRows(105));

    const outcome = await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(outcome.truncated).toBe(true);
    expect(outcome.status).toBe(ArtifactLabelReconciliationStatus.Partial);
  });

  it("makes no GitHub call for an artifact with no linked pull request", async () => {
    installRows([]);

    await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });

  it("skips a row whose repository has no live installation", async () => {
    installRows([makeRow({ repository: null })]);

    await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).not.toHaveBeenCalled();
  });

  // Fail-open: the user's tag mutation has already committed, so a GitHub or DB
  // failure here must not surface as a failed tag change.
  it("never throws when the pull-request read fails", async () => {
    mocks.withDb.mockRejectedValue(new Error("db down"));

    const outcome = await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(outcome.status).toBe(ArtifactLabelReconciliationStatus.Failed);
  });

  // `mapWithDbConcurrency` is fail-fast, so one bad PR used to abandon every
  // other PR the same tag change was supposed to converge.
  it("keeps reconciling the remaining pull requests after one fails", async () => {
    installRows(makeRows(3));
    mocks.syncPullRequestLabelsFromArtifactTags
      .mockRejectedValueOnce(new Error("github unavailable"))
      .mockResolvedValue(appliedSyncResult());

    const outcome = await reconcileLinkedPullRequestLabelsForArtifact({
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledTimes(
      3
    );
    expect(outcome.failedCount).toBe(1);
    expect(outcome.reconciledCount).toBe(2);
    expect(outcome.status).toBe(ArtifactLabelReconciliationStatus.Partial);
  });
});

describe("reconcileLinkedPullRequestLabelsForArtifacts", () => {
  // The batch path used to `.slice(0, 20)` its input, so artifacts past the cap
  // were dropped permanently while the tag mutation reported success.
  it("reconciles every artifact in the batch, not the first page of them", async () => {
    const artifactIds = Array.from(
      { length: 30 },
      (_unused, index) => `artifact-${index}`
    );
    installRowsByArtifact(
      new Map(
        artifactIds.map((id, index) => [
          id,
          [makeRow({ id: `pr-${index}`, number: index })],
        ])
      )
    );

    const outcome = await reconcileLinkedPullRequestLabelsForArtifacts({
      organizationId: ORGANIZATION_ID,
      artifactIds,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledTimes(
      30
    );
    expect(outcome.reconciledCount).toBe(30);
  });

  // One PR-detail row is reachable from several artifacts in a batch (an issue
  // and its plan both resolve to it); labelling it twice is wasted GitHub work.
  it("labels a pull request reachable from two batched artifacts once", async () => {
    const shared = makeRow({ id: "shared-pr", number: 7 });
    installRowsByArtifact(
      new Map([
        ["artifact-a", [shared]],
        ["artifact-b", [shared]],
      ])
    );

    const outcome = await reconcileLinkedPullRequestLabelsForArtifacts({
      organizationId: ORGANIZATION_ID,
      artifactIds: ["artifact-a", "artifact-b"],
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledTimes(
      1
    );
    expect(outcome.reconciledCount).toBe(1);
  });

  // FEA-3299: a five-way artifact fan-out that built its own limiter inside each
  // artifact reconciliation put 25 reads against a 10-connection pool.
  it("holds every level of the batch inside one concurrency bound", async () => {
    const artifactIds = Array.from(
      { length: 5 },
      (_unused, index) => `artifact-${index}`
    );
    installRowsByArtifact(
      new Map(
        artifactIds.map((id, artifactIndex) => [
          id,
          makeRows(5, artifactIndex * 100),
        ])
      )
    );

    let inFlight = 0;
    let peakInFlight = 0;
    mocks.syncPullRequestLabelsFromArtifactTags.mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return appliedSyncResult();
    });

    await reconcileLinkedPullRequestLabelsForArtifacts({
      organizationId: ORGANIZATION_ID,
      artifactIds,
    });

    expect(mocks.syncPullRequestLabelsFromArtifactTags).toHaveBeenCalledTimes(
      25
    );
    // Concurrent at all (so the bound is real work, not accidental serialising)
    // but never past the single shared budget.
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
  });
});
