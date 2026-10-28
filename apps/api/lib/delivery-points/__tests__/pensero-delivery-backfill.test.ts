/**
 * End-to-end wiring for the Pensero delivery backfill, driven by the
 * synthetic hazard fixture through the REAL extractor, interaction join, matcher and
 * store, against a fake database.
 *
 * The provider fetch and the throttle sleep are injected — nothing here touches
 * the network or a real timer — but everything between them is production code,
 * so deleting a stage fails these tests rather than leaving them green.
 */

import fixture from "@repo/pensero/__tests__/fixtures/pensero-delivery-hazards.fixture.json";
import { SegmentCompleteness } from "@repo/pensero/delivery-client";
import { extractDeliverySegment } from "@repo/pensero/delivery-extractor";
import { PullRequestResolution } from "@repo/pensero/delivery-interaction-join";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  // `withDb.tx` is a property ON the mock, not a sibling export, because that
  // is how production reaches it — a bare `vi.fn()` here would make every
  // transactional write throw instead of exercising it.
  const mocked = Object.assign(vi.fn(), { tx: vi.fn() });
  return { ...actual, withDb: mocked };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { DeliveryMatchOutcome, withDb } from "@repo/database";
import type { BackfillSegment } from "../backfill-plan";
import { runPenseroDeliveryBackfill } from "../pensero-delivery-backfill";

const ORG = "org-1";

/** A second tenant, whose rows collide on every identity this matcher joins on. */
const FOREIGN_ORG = "org-2";

/**
 * Emails our fake organization actually has users for.
 *
 * `user-foreign-daveth` carries the SAME email in another tenant. Every read in
 * this pipeline joins on a value that is not globally unique — an email, an
 * `owner/repo#number`, an artifact slug — so the org predicate is the only thing
 * keeping one tenant's identity out of another's numerator. The fake honours
 * `where.organizationId` so dropping that predicate from a query fails here
 * rather than in production.
 */
const KNOWN_USERS = [
  // Stored in a DIFFERENT case from the provider's email, on purpose: the
  // bridge must fold case or it splits one person into two.
  {
    id: "user-daveth",
    email: "Daveth.Oakhurst@ClosedLoop.ai",
    organizationId: ORG,
  },
  {
    id: "user-marisol",
    email: "marisol.ashgrove@closedloop.ai",
    organizationId: ORG,
  },
  {
    id: "user-foreign-daveth",
    email: "daveth.oakhurst@closedloop.ai",
    organizationId: FOREIGN_ORG,
  },
];

const KNOWN_PULL_REQUESTS = [
  {
    id: "prd-4228",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 4228,
    artifactId: "art-pr-4228",
    branchArtifactId: "art-branch-4228",
    organizationId: ORG,
  },
  {
    id: "prd-3525-a",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 3525,
    artifactId: "art-pr-3525-a",
    branchArtifactId: "art-branch-3525-a",
    organizationId: ORG,
  },
  {
    id: "prd-3525-b",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 3525,
    artifactId: "art-pr-3525-b",
    branchArtifactId: "art-branch-3525-b",
    organizationId: ORG,
  },
  {
    id: "prd-tofu-148",
    repositoryFullName: "example-org/infrastructure",
    number: 148,
    artifactId: null,
    branchArtifactId: "art-branch-148",
    organizationId: ORG,
  },
  // Another tenant's row for the SAME repository and number. Admitting it would
  // make `#4228` look like two candidates and turn a clean match AMBIGUOUS.
  {
    id: "prd-foreign-4228",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 4228,
    artifactId: "art-foreign-pr-4228",
    branchArtifactId: "art-foreign-branch-4228",
    organizationId: FOREIGN_ORG,
  },
];

/** Our own artifact links — the authoritative artifact set for a matched PR. */
const KNOWN_LINKS = [
  {
    sourceId: "art-branch-4228",
    targetId: "art-iss-4881",
    organizationId: ORG,
  },
  // A foreign-tenant link hanging off the SAME branch artifact id. Dropping the
  // org predicate would pull another tenant's artifact into our association set.
  {
    sourceId: "art-branch-4228",
    targetId: "art-foreign-iss",
    organizationId: FOREIGN_ORG,
  },
];

/**
 * Artifacts addressable by slug, for the title fallback. `FEA-3753` is stored
 * under its LEGACY spelling so the fallback proves it resolves one.
 */
const KNOWN_ARTIFACTS = [
  { id: "art-iss-4884", slug: "ISS-4884", organizationId: ORG },
  { id: "art-fea-3753", slug: "FEA-3753", organizationId: ORG },
  // Same slug, another tenant. Slugs are not globally unique.
  {
    id: "art-foreign-iss-4884",
    slug: "ISS-4884",
    organizationId: FOREIGN_ORG,
  },
];

type UpsertedPoint = {
  providerItemId: string;
  matchOutcome: DeliveryMatchOutcome;
  points: number;
  personEmail: string;
  userId: string | null;
  repositoryFullName: string | null;
  pullRequestNumber: number | null;
  pullRequestDetailId: string | null;
  branchArtifactId: string | null;
};

type Association = {
  deliveryPointId: string;
  artifactId: string;
  source: string;
};

/** A delivery point an earlier run resolved, as the seed read selects it. */
type StoredPoint = {
  providerInteractionId: string;
  repositoryFullName: string | null;
  pullRequestNumber: number | null;
  organizationId: string;
};

let upserts: UpsertedPoint[] = [];
let associations: Association[] = [];
let storedPoints: StoredPoint[] = [];

/**
 * Model Prisma, not wishful thinking: a `where` carrying NO `organizationId`
 * does not match nothing, it returns EVERY tenant's row. Modelling a dropped
 * predicate as "matches nothing" would make the cross-tenant tests below fail
 * for the wrong reason and hide what production would actually have done.
 */
function inOrg(rowOrganizationId: string, whereOrganizationId?: string) {
  return (
    whereOrganizationId === undefined ||
    rowOrganizationId === whereOrganizationId
  );
}

function makeFakeDb() {
  return {
    user: {
      findMany: ({
        where,
      }: {
        where: { organizationId?: string; OR: { email: { equals: string } }[] };
      }) => {
        const wanted = new Set(
          where.OR.map((clause) => clause.email.equals.toLowerCase())
        );
        return Promise.resolve(
          KNOWN_USERS.filter(
            (user) =>
              inOrg(user.organizationId, where.organizationId) &&
              wanted.has(user.email.toLowerCase())
          )
        );
      },
    },
    pullRequestDetail: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          OR: { repositoryFullName: string; number: number }[];
        };
      }) =>
        Promise.resolve(
          KNOWN_PULL_REQUESTS.filter(
            (pr) =>
              inOrg(pr.organizationId, where.organizationId) &&
              where.OR.some(
                (clause) =>
                  clause.repositoryFullName === pr.repositoryFullName &&
                  clause.number === pr.number
              )
          )
        ),
    },
    artifactLink: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          OR: [{ sourceId: { in: string[] } }, { targetId: { in: string[] } }];
        };
      }) => {
        const seeds = new Set([
          ...where.OR[0].sourceId.in,
          ...where.OR[1].targetId.in,
        ]);
        return Promise.resolve(
          KNOWN_LINKS.filter(
            (link) =>
              inOrg(link.organizationId, where.organizationId) &&
              (seeds.has(link.sourceId) || seeds.has(link.targetId))
          )
        );
      },
    },
    artifact: {
      findMany: ({
        where,
      }: {
        where: { organizationId?: string; slug: { in: string[] } };
      }) =>
        Promise.resolve(
          KNOWN_ARTIFACTS.filter(
            (artifact) =>
              inOrg(artifact.organizationId, where.organizationId) &&
              where.slug.in.includes(artifact.slug)
          )
        ),
    },
    deliveryPoint: {
      // Rows a PREVIOUS run already resolved and persisted. The seed read is
      // scoped to `provider_interaction_id`, so this is the only shape that
      // matters here.
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          providerInteractionId: { in: string[] };
        };
      }) =>
        Promise.resolve(
          storedPoints.filter(
            (row) =>
              inOrg(row.organizationId, where.organizationId) &&
              where.providerInteractionId.in.includes(row.providerInteractionId)
          )
        ),
      upsert: (args: {
        where: {
          organizationId_provider_providerItemId: { providerItemId: string };
        };
        create: Record<string, unknown>;
      }) => {
        const create = args.create as unknown as UpsertedPoint;
        upserts.push(create);
        return Promise.resolve({
          id: `dp-${args.where.organizationId_provider_providerItemId.providerItemId}`,
        });
      },
    },
    deliveryPointArtifact: {
      deleteMany: ({ where }: { where: { deliveryPointId: string } }) => {
        associations = associations.filter(
          (row) => row.deliveryPointId !== where.deliveryPointId
        );
        return Promise.resolve({ count: 0 });
      },
      createMany: ({ data }: { data: Association[] }) => {
        associations.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  };
}

/**
 * Stands in for the network only. The payload goes through the REAL extractor,
 * so the stub cannot drift from what the client would have produced — the only
 * thing faked here is the transport.
 */
function fetchSegmentStub(segment: BackfillSegment) {
  const payload =
    segment.endDate === "2026-08-04"
      ? fixture
      : {
          start_date: segment.startDate,
          end_date: segment.endDate,
          users: [],
        };
  return Promise.resolve({
    segment: extractDeliverySegment(payload),
    completeness: SegmentCompleteness.Unverified,
    continuationKeysSeen: [] as string[],
  });
}

const BASE_OPTIONS = {
  organizationId: ORG,
  teamIdentifiers: ["Engineering"],
  endDate: new Date("2026-08-04T12:00:00.000Z"),
  lookbackDays: 8,
  segmentDays: 4,
  sleep: () => Promise.resolve(),
};

describe("runPenseroDeliveryBackfill", () => {
  beforeEach(() => {
    upserts = [];
    associations = [];
    storedPoints = [];
    vi.clearAllMocks();
    const db = makeFakeDb();
    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(callback(db as never))
    );
    vi.mocked(withDb.tx).mockImplementation((callback) =>
      Promise.resolve(callback(db as never))
    );
  });

  it("plans, fetches and persists every row exactly once", async () => {
    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    expect(report.segmentsPlanned).toBe(2);
    expect(report.segmentsFetched).toBe(2);
    expect(report.segmentsFailed).toEqual([]);
    expect(report.planTruncated).toBe(false);
    expect(report.rowsExtracted).toBe(39);
    expect(report.rowsRejected).toBe(0);
    expect(report.rowsWritten).toBe(39);
    // The idempotency contract: one upsert per provider row id, no duplicates.
    expect(new Set(upserts.map((row) => row.providerItemId)).size).toBe(39);
  });

  it("produces the exact match-outcome split for the fixture", async () => {
    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    expect(report.outcomeCounts).toEqual({
      [DeliveryMatchOutcome.MATCHED]: 5,
      [DeliveryMatchOutcome.AMBIGUOUS]: 4,
      [DeliveryMatchOutcome.NO_COUNTERPART]: 16,
      // Terminal: these rows name no pull-request interaction at all.
      [DeliveryMatchOutcome.UNMATCHABLE]: 5,
      // Provisional: these DO name one, and no window has yet supplied its
      // number. Storing them as UNMATCHABLE would claim a run that fetched two
      // windows had settled a question it had not.
      [DeliveryMatchOutcome.PENDING_REFERENCE]: 9,
    });
    expect(report.resolutionCounts).toEqual({
      [PullRequestResolution.Direct]: 16,
      [PullRequestResolution.Interaction]: 9,
      [PullRequestResolution.NoInteraction]: 5,
      [PullRequestResolution.NoCounterpart]: 9,
      [PullRequestResolution.Ambiguous]: 0,
    });
  });

  it("H1/H2: gives the creator row its number through the interaction join", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    const creator = upserts.find((row) => row.providerItemId === "2656228");
    expect(creator).toMatchObject({
      matchOutcome: DeliveryMatchOutcome.MATCHED,
      points: 3,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      pullRequestNumber: 4228,
      pullRequestDetailId: "prd-4228",
      branchArtifactId: "art-branch-4228",
    });
  });

  it("identifies a matched pull request by its BRANCH artifact, not the vestigial one", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    // `example-infrastructure#148` has `artifactId: null`, the normal production
    // shape. Keying on that column would have made this match look unresolved.
    const tofu = upserts.find((row) => row.providerItemId === "2670452");
    expect(tofu).toMatchObject({
      matchOutcome: DeliveryMatchOutcome.MATCHED,
      pullRequestDetailId: "prd-tofu-148",
      branchArtifactId: "art-branch-148",
    });
    expect(
      associations.filter((row) => row.deliveryPointId === "dp-2670452")
    ).toEqual([
      {
        deliveryPointId: "dp-2670452",
        artifactId: "art-branch-148",
        organizationId: ORG,
        source: "OUR_LINKS",
      },
    ]);
  });

  it("H8: persists a measured zero as a matched zero, distinct from unmatched", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    // `2428735` measured 0 AND is ambiguous; `2666774` measured 0 and matched
    // nothing. Both are zero points, and neither is the same fact as a PR with
    // no row at all — which is why the outcome travels with the value.
    const measuredZero = upserts.find(
      (row) => row.providerItemId === "2428735"
    );
    expect(measuredZero?.points).toBe(0);
    expect(measuredZero?.matchOutcome).toBe(DeliveryMatchOutcome.AMBIGUOUS);
  });

  it("never resolves an ambiguous pull request to a candidate", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    for (const row of upserts.filter(
      (candidate) => candidate.matchOutcome === DeliveryMatchOutcome.AMBIGUOUS
    )) {
      expect(row.pullRequestDetailId).toBeNull();
      expect(row.branchArtifactId).toBeNull();
    }
  });

  it("H11: bridges a person whose stored email differs in case", async () => {
    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    const daveth = upserts.find((row) => row.providerItemId === "2656228");
    expect(daveth?.personEmail).toBe("daveth.oakhurst@closedloop.ai");
    expect(daveth?.userId).toBe("user-daveth");
    // Four of the six people in the feed have no user in this org.
    expect(report.peopleUnbridged).toBe(4);
  });

  it("links EVERY artifact our own links reach, not just the pull request", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    const forCreator = associations.filter(
      (row) => row.deliveryPointId === "dp-2656228"
    );
    expect(new Set(forCreator.map((row) => row.artifactId))).toEqual(
      new Set(["art-pr-4228", "art-branch-4228", "art-iss-4881"])
    );
    expect(new Set(forCreator.map((row) => row.source))).toEqual(
      new Set(["OUR_LINKS"])
    );
  });

  it("attaches NO artifact to a row it could not identify", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    // `2656365` (PENDING_REFERENCE) and `2428735` (AMBIGUOUS) both have an
    // artifact slug sitting in their titles — `ISS-4884` and `FEA-3753`, both
    // present in KNOWN_ARTIFACTS. Reading it would attach points to an artifact
    // on the strength of a string the matcher just said did not identify the
    // row: "pick the first" wearing a different hat. An unmatched row is
    // visible; a wrongly attributed one is not.
    expect(
      associations.filter((row) => row.deliveryPointId === "dp-2656365")
    ).toEqual([]);
    expect(
      associations.filter((row) => row.deliveryPointId === "dp-2428735")
    ).toEqual([]);

    // Stronger, and the assertion that actually holds the line: EVERY
    // association in the batch belongs to a MATCHED row, and every one of them
    // came from our own links.
    const matchedIds = new Set(
      upserts
        .filter((row) => row.matchOutcome === DeliveryMatchOutcome.MATCHED)
        .map((row) => `dp-${row.providerItemId}`)
    );
    expect(associations.length).toBeGreaterThan(0);
    for (const association of associations) {
      expect(matchedIds.has(association.deliveryPointId)).toBe(true);
      expect(association.source).toBe("OUR_LINKS");
    }
  });

  it("never claims completeness the delivery endpoint cannot demonstrate", async () => {
    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    expect(report.completeness).toBe(SegmentCompleteness.Unverified);
  });

  it("reports a failed segment instead of letting it read as a quiet window", async () => {
    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: (segment) =>
        segment.endDate === "2026-08-04"
          ? Promise.reject(new Error("provider 503"))
          : fetchSegmentStub(segment),
    });
    expect(report.segmentsFetched).toBe(1);
    expect(report.segmentsFailed).toHaveLength(1);
    expect(report.segmentsFailed[0].segment.endDate).toBe("2026-08-04");
    // The run continued; it did not abort on the first failure.
    expect(report.segmentsPlanned).toBe(2);
  });

  it("resolves a creator row from a reference an EARLIER run stored", async () => {
    // `2656365` names interaction 1539978, whose number no row in this feed
    // supplies — so this run alone cannot resolve it. A previous run did, and
    // the row it persisted is the record of that. Without the seed the index
    // starts empty every invocation and this creator is re-derived unresolved.
    storedPoints = [
      {
        providerInteractionId: "1539978",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 4228,
        organizationId: ORG,
      },
    ];

    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    expect(report.interactionsSeededFromStore).toBe(1);
    expect(
      upserts.find((row) => row.providerItemId === "2656365")
    ).toMatchObject({
      matchOutcome: DeliveryMatchOutcome.MATCHED,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      pullRequestNumber: 4228,
      pullRequestDetailId: "prd-4228",
    });
    // And its associations now come from OUR links, not the lossy title slugs.
    expect(
      associations
        .filter((row) => row.deliveryPointId === "dp-2656365")
        .every((row) => row.source === "OUR_LINKS")
    ).toBe(true);
  });

  it("treats a stored reference as evidence, never as an override", async () => {
    // The feed says interaction 1539716 is #4228. Storage says #3525. Two
    // sources contradicting each other about one interaction is exactly the
    // ambiguity the join refuses to arbitrate — a stored answer does not win.
    storedPoints = [
      {
        providerInteractionId: "1539716",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 3525,
        organizationId: ORG,
      },
    ];

    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    const creator = upserts.find((row) => row.providerItemId === "2656228");
    expect(creator?.matchOutcome).toBe(DeliveryMatchOutcome.AMBIGUOUS);
    expect(creator?.pullRequestDetailId).toBeNull();
  });

  it("keeps a stored row out of the seed when it resolved to no pull request", async () => {
    storedPoints = [
      {
        providerInteractionId: "1539978",
        repositoryFullName: null,
        pullRequestNumber: null,
        organizationId: ORG,
      },
    ];

    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    expect(report.interactionsSeededFromStore).toBe(0);
    expect(
      upserts.find((row) => row.providerItemId === "2656365")?.matchOutcome
    ).toBe(DeliveryMatchOutcome.PENDING_REFERENCE);
  });

  it("never resolves another tenant's row that collides on the same identity", async () => {
    // Every join key here is non-unique across tenants: an email, an
    // `owner/repo#number`, an artifact slug. FOREIGN_ORG carries a colliding row
    // for each. If any query lost its org predicate, #4228 would see two
    // candidates and go AMBIGUOUS, the bridge would have two users for one
    // email, and the association set would gain a foreign artifact.
    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    const creator = upserts.find((row) => row.providerItemId === "2656228");
    expect(creator?.matchOutcome).toBe(DeliveryMatchOutcome.MATCHED);
    expect(creator?.pullRequestDetailId).toBe("prd-4228");
    expect(creator?.userId).toBe("user-daveth");
    expect(report.outcomeCounts[DeliveryMatchOutcome.MATCHED]).toBe(5);

    const everyArtifactId = new Set(associations.map((row) => row.artifactId));
    for (const foreign of [
      "art-foreign-branch-4228",
      "art-foreign-pr-4228",
      "art-foreign-iss",
      "art-foreign-iss-4884",
    ]) {
      expect(everyArtifactId.has(foreign)).toBe(false);
    }
  });

  it("does not seed the index from another tenant's stored reference", async () => {
    storedPoints = [
      {
        providerInteractionId: "1539978",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 4228,
        organizationId: FOREIGN_ORG,
      },
    ];

    const report = await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });

    expect(report.interactionsSeededFromStore).toBe(0);
    expect(
      upserts.find((row) => row.providerItemId === "2656365")?.matchOutcome
    ).toBe(DeliveryMatchOutcome.PENDING_REFERENCE);
  });

  it("writes each point and its associations inside one transaction", async () => {
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      fetchSegment: fetchSegmentStub,
    });
    // A DELETE followed by a CREATE outside a transaction can leave a persisted
    // point with an empty association set that reads as "touches no artifacts".
    // One transaction per point, not one per batch.
    expect(vi.mocked(withDb.tx)).toHaveBeenCalledTimes(39);
  });

  it("throttles between segments without a real timer", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runPenseroDeliveryBackfill({
      ...BASE_OPTIONS,
      sleep,
      throttleMs: 250,
      fetchSegment: fetchSegmentStub,
    });
    // One delay BETWEEN two segments — not before the first.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
