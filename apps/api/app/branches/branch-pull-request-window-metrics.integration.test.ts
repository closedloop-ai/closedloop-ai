import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  type BranchMetricPullRequestEvidence,
  calculateBranchListMetrics,
} from "@repo/lib/branches/branch-list-metrics";
import type { BranchMetricPullRequestWindowFacts } from "@repo/lib/branches/branch-pull-request-metrics";
import { afterEach, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  type PullRequestMetricWindow,
  readPullRequestMetricFacts,
} from "./branch-pull-request-window-metrics";

/**
 * ISS-11589 / ISS-12346: the SQL fold must publish the Median PR size and the
 * Merge rate the JS fold publishes for the same evidence, window by window.
 * The JS fold is the oracle, so the seed stays inside what it can settle: no
 * unsettled twin pair, whose winner is arrival order there and an id here.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const SEED = 20_261_012;
const IDENTITY_COUNT = 240;
const DAY = 86_400_000;
const END = Date.parse("2026-09-30T00:00:00.000Z");
const WINDOWS: PullRequestMetricWindow[] = [
  { key: "all", startAt: null, endAt: iso(END) },
  { key: "d90", startAt: iso(END - 90 * DAY), endAt: iso(END) },
  { key: "d30", startAt: iso(END - 30 * DAY), endAt: iso(END) },
  { key: "d7", startAt: iso(END - 7 * DAY), endAt: iso(END) },
  { key: "prior30", startAt: iso(END - 60 * DAY), endAt: iso(END - 30 * DAY) },
];
const REPOSITORY_NAMES = ["acme/web", "acme/api", "acme/Docs"];

type Random = ReturnType<typeof createRandom>;

type SeededRow = {
  identity: string;
  verified: boolean;
  linked: boolean;
  owned: boolean;
  closedDraft: boolean;
  mergedAt: Date | null;
  closedAt: Date | null;
  additions: number | null;
  deletions: number | null;
};

function createRandom(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  return {
    chance: (probability: number) => next() < probability,
    int: (maximum: number) => Math.floor(next() * maximum),
    pick: <Value>(values: readonly Value[]): Value =>
      values[Math.floor(next() * values.length)] as Value,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describeIfDb("pull request window metrics", () => {
  it("publishes the median and merge rate the JS fold publishes, per window", async () => {
    const organizationId = await committedOrganizations.create();
    const rows = await seed(organizationId, createRandom(SEED));

    const facts = await readPullRequestMetricFacts(
      organizationId,
      cohortSql(organizationId),
      WINDOWS
    );

    const compared = new Set<string>();
    for (const window of WINDOWS) {
      const sql = facts.windows.get(window.key);
      expect(sql, window.key).toBeDefined();
      const js = jsFold(rows, window);
      expect(sqlMedian(sql), `median ${window.key}`).toEqual(
        resultValue(js.median)
      );
      expect(sqlMergeRate(sql), `merge rate ${window.key}`).toEqual(
        resultValue(js.mergeRate)
      );
      compared.add(String(resultValue(js.median)));
    }
    // A fixture where every window answers nothing would make the equality above vacuous.
    expect(compared.size).toBeGreaterThan(2);
    expect(facts.windows.get("all")?.merged).toBeGreaterThan(20);
    expect(facts.windows.get("all")?.closedUnmerged).toBeGreaterThan(10);
  });

  // Operator ruling 2026-10-14: a closed, unmerged draft is excluded from Merge
  // rate and Median PR size.
  it("excludes a pull request whose App-owned representative is a closed draft, stub twin included", async () => {
    const organizationId = await committedOrganizations.create();
    const closedAt = new Date(END - 2 * DAY);
    await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: new Date(END - DAY) }),
      row("acme/web#5", { closedAt, isDraft: true, owned: true }),
      row("acme/web#5", { closedAt, repositoryFullName: "ACME/web" }),
    ]);

    const facts = await readPullRequestMetricFacts(
      organizationId,
      cohortSql(organizationId),
      WINDOWS
    );

    expect(facts.windows.get("d7")).toMatchObject({
      merged: 1,
      closedUnmerged: 0,
      decidedIdentities: 1,
    });
  });

  it("excludes a closed draft and leaves an open draft undecided", async () => {
    const organizationId = await committedOrganizations.create();
    const closedAt = new Date(END - 2 * DAY);
    await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: new Date(END - DAY) }),
      row("acme/web#2", { closedAt, isDraft: true }),
      row("acme/web#3", { closedAt: null, isDraft: true }),
    ]);

    const facts = await readPullRequestMetricFacts(
      organizationId,
      cohortSql(organizationId),
      WINDOWS
    );

    expect(facts.windows.get("d7")).toMatchObject({
      merged: 1,
      closedUnmerged: 0,
    });
  });

  it("lets the App-owned row settle a size disagreement, whichever row arrived first", async () => {
    const organizationId = await committedOrganizations.create();
    const merged = new Date(END - DAY);
    await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: merged, additions: 7, deletions: 0 }),
      row("acme/web#1", {
        mergedAt: merged,
        additions: 500,
        deletions: 0,
        owned: true,
        repositoryFullName: "ACME/web",
      }),
      row("acme/web#2", {
        mergedAt: merged,
        additions: 900,
        deletions: 0,
        owned: true,
      }),
      row("acme/web#2", {
        mergedAt: merged,
        additions: 9,
        deletions: 0,
        repositoryFullName: "ACME/web",
      }),
    ]);

    const facts = await factsFor(organizationId);

    expect(facts.conflicted).toBe(false);
    expect(facts.windows.get("d7")).toMatchObject({
      merged: 2,
      medianSize: 700,
    });
  });

  it.each([
    ["two repo-less rows", false],
    ["two App-owned rows", true],
  ])("flags %s that disagree on size as conflicted", async (_name, owned) => {
    const organizationId = await committedOrganizations.create();
    const merged = new Date(END - DAY);
    await seedRows(organizationId, [
      row("acme/web#1", {
        mergedAt: merged,
        additions: 5,
        deletions: 5,
        owned,
      }),
      row("acme/web#1", {
        mergedAt: merged,
        additions: 50,
        deletions: 50,
        owned,
        repositoryFullName: "ACME/web",
      }),
    ]);

    const facts = await factsFor(organizationId);

    expect(facts.conflicted).toBe(true);
    expect(facts.windows.get("d7")).toMatchObject({ merged: 1, sized: 1 });
  });

  it("keeps a pull request whose sized twin was never verified, unsized", async () => {
    const organizationId = await committedOrganizations.create();
    const merged = new Date(END - DAY);
    await seedRows(organizationId, [
      row("acme/web#1", {
        mergedAt: merged,
        additions: 500,
        deletions: 0,
        owned: true,
        verified: false,
      }),
      row("acme/web#1", {
        mergedAt: merged,
        repositoryFullName: "ACME/web",
      }),
    ]);

    const facts = await factsFor(organizationId);

    expect(facts.conflicted).toBe(false);
    expect(facts.windows.get("d7")).toMatchObject({
      merged: 1,
      sized: 0,
      medianSize: null,
    });
  });

  it("does not flag twins that agree on size, or that differ only in being sized", async () => {
    const organizationId = await committedOrganizations.create();
    const merged = new Date(END - DAY);
    await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: merged, additions: 5, deletions: 5 }),
      row("acme/web#1", {
        mergedAt: merged,
        additions: 5,
        deletions: 5,
        repositoryFullName: "ACME/web",
      }),
      row("acme/web#2", { mergedAt: merged, additions: 5, deletions: 5 }),
      row("acme/web#2", { mergedAt: merged, repositoryFullName: "ACME/web" }),
    ]);

    expect((await factsFor(organizationId)).conflicted).toBe(false);
  });

  it.each([
    [
      "merge instants",
      { mergedAt: new Date(END - 2 * DAY) },
      { mergedAt: new Date(END - DAY) },
    ],
    [
      "close instants",
      { closedAt: new Date(END - 2 * DAY) },
      { closedAt: new Date(END - DAY) },
    ],
  ])(
    "drops both rows of a pull request whose twins disagree on %s",
    async (_name, first, second) => {
      const organizationId = await committedOrganizations.create();
      await seedRows(organizationId, [
        row("acme/web#1", { additions: 1, deletions: 1, ...first }),
        row("acme/web#1", {
          additions: 1,
          deletions: 1,
          repositoryFullName: "ACME/web",
          ...second,
        }),
        row("acme/web#2", { closedAt: new Date(END - DAY) }),
      ]);

      const facts = await factsFor(organizationId);

      expect(facts.conflicted).toBe(true);
      expect(facts.windows.get("d7")).toMatchObject({
        merged: 0,
        closedUnmerged: 1,
        decidedIdentities: 2,
      });
    }
  );

  it("includes the window's start and excludes its end", async () => {
    const organizationId = await committedOrganizations.create();
    await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: new Date(END - 7 * DAY) }),
      row("acme/web#2", { mergedAt: new Date(END) }),
      row("acme/web#3", { closedAt: new Date(END - 7 * DAY) }),
      row("acme/web#4", { closedAt: new Date(END) }),
    ]);

    const facts = await factsFor(organizationId);

    expect(facts.windows.get("d7")).toMatchObject({
      merged: 1,
      closedUnmerged: 1,
      decidedIdentities: 2,
    });
  });

  it("reads a size as known only when both counts are non-negative", async () => {
    const organizationId = await committedOrganizations.create();
    const merged = new Date(END - DAY);
    await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: merged, additions: 10, deletions: 0 }),
      row("acme/web#2", { mergedAt: merged, additions: 5, deletions: -3 }),
      row("acme/web#3", { mergedAt: merged, additions: -3, deletions: 5 }),
      row("acme/web#4", { mergedAt: merged, additions: 5, deletions: null }),
      row("acme/web#5", { mergedAt: merged, additions: 0, deletions: 0 }),
    ]);

    const facts = await factsFor(organizationId);

    // The known zero counts toward the median; the three unknowns do not.
    expect(facts.windows.get("d7")).toMatchObject({
      merged: 5,
      sized: 2,
      medianSize: 5,
    });
  });

  it("limits the fold to the cohort and to verified, session-linked rows", async () => {
    const organizationId = await committedOrganizations.create();
    const merged = new Date(END - DAY);
    const ids = await seedRows(organizationId, [
      row("acme/web#1", { mergedAt: merged, additions: 4, deletions: 4 }),
      row("acme/web#2", {
        mergedAt: merged,
        additions: 9,
        deletions: 9,
        verified: false,
      }),
      row("acme/web#3", {
        mergedAt: merged,
        additions: 9,
        deletions: 9,
        linked: false,
      }),
      row("acme/web#4", { mergedAt: merged, additions: 100, deletions: 100 }),
    ]);

    const facts = await readPullRequestMetricFacts(
      organizationId,
      Prisma.sql`SELECT ${ids[0]}::uuid`,
      WINDOWS
    );

    expect(facts.windows.get("d7")).toMatchObject({
      merged: 1,
      sized: 1,
      medianSize: 8,
    });
  });
});

function factsFor(organizationId: string) {
  return readPullRequestMetricFacts(
    organizationId,
    cohortSql(organizationId),
    WINDOWS
  );
}

function cohortSql(organizationId: string): Prisma.Sql {
  return Prisma.sql`SELECT id FROM artifacts
    WHERE organization_id = ${organizationId}::uuid
      AND type = ${ArtifactType.BRANCH}::"ArtifactType"`;
}

type RowOptions = Partial<{
  mergedAt: Date | null;
  closedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  isDraft: boolean;
  verified: boolean;
  linked: boolean;
  owned: boolean;
  repositoryFullName: string;
}>;

type SpecRow = Required<Omit<RowOptions, "repositoryFullName">> & {
  repositoryFullName: string;
  number: number;
};

function row(identity: string, options: RowOptions = {}): SpecRow {
  const [repositoryFullName, number] = identity.split("#") as [string, string];
  return {
    mergedAt: null,
    closedAt: null,
    additions: null,
    deletions: null,
    isDraft: false,
    verified: true,
    linked: true,
    owned: false,
    repositoryFullName,
    number: Number(number),
    ...options,
  };
}

async function seedRows(
  organizationId: string,
  specs: readonly SpecRow[]
): Promise<string[]> {
  const branchIds: string[] = [];
  for (const spec of specs) {
    branchIds.push(await seedRow(organizationId, spec));
  }
  return branchIds;
}

async function seedRow(organizationId: string, spec: SpecRow): Promise<string> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${spec.repositoryFullName}-${spec.number}-${spec.mergedAt?.getTime() ?? 0}`,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        number: spec.number,
        repositoryFullName: spec.repositoryFullName,
        prState: prStateFor(spec),
        isDraft: spec.isDraft,
        mergedAt: spec.mergedAt,
        closedAt: spec.closedAt,
        additions: spec.additions,
        deletions: spec.deletions,
        githubId: spec.owned ? `PR_${branch.id}` : null,
        lastVerifiedAt: spec.verified ? new Date(END) : null,
      },
      select: { id: true },
    });
    if (spec.linked) {
      const session = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: `session-${branch.id}`,
          status: "inactive",
        },
        select: { id: true },
      });
      await db.artifactLink.create({
        data: {
          organizationId,
          sourceId: session.id,
          targetId: branch.id,
          linkType: LinkType.RelatesTo,
          metadata: {
            linkKind: "session_pr",
            repositoryFullName: spec.repositoryFullName,
            prNumber: spec.number,
          },
        },
        select: { id: true },
      });
    }
    return branch.id;
  });
}

async function seed(
  organizationId: string,
  random: Random
): Promise<SeededRow[]> {
  const seeded: SeededRow[] = [];
  for (let index = 0; index < IDENTITY_COUNT; index += 1) {
    const repositoryFullName = random.pick(REPOSITORY_NAMES);
    const identity = `${repositoryFullName.toLowerCase()}#${index + 1}`;
    const lifecycle = lifecycleFor(random);
    const size = sizeFor(random);
    const twinCount = random.chance(0.25) ? 2 : 1;
    for (let twin = 0; twin < twinCount; twin += 1) {
      const sized = twin === 0 ? size : twinSize(random, size);
      const spec = row(`${repositoryFullName}#${index + 1}`, {
        ...lifecycle,
        ...sized,
        isDraft: random.chance(0.2),
        verified: random.chance(0.9),
        linked: random.chance(0.9),
        owned: twin === 1,
        repositoryFullName:
          twin === 0 ? repositoryFullName : repositoryFullName.toUpperCase(),
      });
      await seedRow(organizationId, spec);
      seeded.push({
        identity,
        verified: spec.verified,
        linked: spec.linked,
        owned: spec.owned,
        closedDraft: spec.isDraft && prStateFor(spec) === GitHubPRState.Closed,
        mergedAt: spec.mergedAt,
        closedAt: spec.closedAt,
        additions: spec.additions,
        deletions: spec.deletions,
      });
    }
  }
  return seeded;
}

function lifecycleFor(random: Random): {
  mergedAt: Date | null;
  closedAt: Date | null;
} {
  const kind = random.int(5);
  const at = new Date(END - random.int(120) * DAY - random.int(DAY));
  if (kind <= 1) {
    return { mergedAt: at, closedAt: at };
  }
  if (kind === 2) {
    return { mergedAt: null, closedAt: at };
  }
  if (kind === 3) {
    return { mergedAt: null, closedAt: null };
  }
  return { mergedAt: new Date(END + DAY), closedAt: null };
}

function sizeFor(random: Random): {
  additions: number | null;
  deletions: number | null;
} {
  if (random.chance(0.15)) {
    return { additions: null, deletions: null };
  }
  if (random.chance(0.05)) {
    return { additions: random.int(50), deletions: null };
  }
  return { additions: random.int(400), deletions: random.int(400) };
}

/** A twin whose size the tie-break can always settle: unsized, equal, or owned. */
function twinSize(
  random: Random,
  size: { additions: number | null; deletions: number | null }
): { additions: number | null; deletions: number | null } {
  return random.chance(0.5) ? { additions: null, deletions: null } : size;
}

function jsFold(
  rows: readonly SeededRow[],
  window: PullRequestMetricWindow
): {
  median: BranchMetricResult<number>;
  mergeRate: BranchMetricResult<number>;
} {
  const counted = rows.filter(
    (candidate) => candidate.verified && candidate.linked
  );
  // Producers drop a closed, unmerged draft before the kernel (operator ruling
  // 2026-10-14), decided per pull request by its twin-order representative.
  const excluded = closedDraftIdentities(counted);
  const pullRequests: BranchMetricPullRequestEvidence[] = counted
    .filter((candidate) => !excluded.has(candidate.identity))
    .map((candidate) => ({
      identity: candidate.identity,
      mergedAt: candidate.mergedAt?.toISOString() ?? null,
      closedAt: candidate.closedAt?.toISOString() ?? null,
      isDraft: false,
      additions: candidate.additions,
      deletions: candidate.deletions,
      githubId: candidate.owned ? `PR_${candidate.identity}` : null,
    }));
  const bundle = calculateBranchListMetrics(
    {
      cohortSize: 1,
      lastActiveCoverageComplete: true,
      lastActiveEvents: [],
      statusSnapshots: [],
      locContributions: [],
      locCompleteBranchIds: [],
      pullRequests,
      pullRequestCoverageComplete: true,
      costContributions: [],
      costCompleteBranchIds: [],
    },
    {
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: window.startAt, endAt: window.endAt },
      prior: null,
    }
  );
  return {
    median: bundle.medianPrSize.current,
    mergeRate: bundle.mergeRatePct.current,
  };
}

function resultValue(result: BranchMetricResult<number>): number | null {
  return result.state === BranchMetricAvailability.Complete ||
    result.state === BranchMetricAvailability.Partial
    ? result.value
    : null;
}

function sqlMedian(
  facts: BranchMetricPullRequestWindowFacts | undefined
): number | null {
  return facts?.medianSize ?? null;
}

function sqlMergeRate(
  facts: BranchMetricPullRequestWindowFacts | undefined
): number | null {
  if (!facts) {
    return null;
  }
  const decided = facts.merged + facts.closedUnmerged;
  return decided === 0 ? null : (facts.merged / decided) * 100;
}

function prStateFor(spec: SpecRow): GitHubPRState {
  if (spec.mergedAt) {
    return GitHubPRState.Merged;
  }
  return spec.closedAt ? GitHubPRState.Closed : GitHubPRState.Open;
}

function closedDraftIdentities(rows: readonly SeededRow[]): Set<string> {
  const representative = new Map<string, SeededRow>();
  for (const candidate of rows) {
    const current = representative.get(candidate.identity);
    if (!current || twinRank(candidate) > twinRank(current)) {
      representative.set(candidate.identity, candidate);
    }
  }
  return new Set(
    [...representative.values()]
      .filter((candidate) => candidate.closedDraft)
      .map((candidate) => candidate.identity)
  );
}

/** The SQL twin order: sized first, then App-owned; ties keep seed order. */
function twinRank(candidate: SeededRow): number {
  const sized =
    candidate.additions !== null &&
    candidate.deletions !== null &&
    candidate.additions >= 0 &&
    candidate.deletions >= 0;
  return (sized ? 2 : 0) + (candidate.owned ? 1 : 0);
}
