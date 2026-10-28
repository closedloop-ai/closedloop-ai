/**
 * The Pensero points read layer (ISS-9813), driven through the production entry
 * point against a fake database that honours the predicates production sends.
 *
 * The fixture is built so the two defects this read exists to prevent produce
 * DIFFERENT wrong numbers, and neither of them is the right one:
 *
 * - a branch-keyed read alone drops the creator's share  → 7.5
 * - pulling siblings in without deduplicating by row id  → 27.5
 * - correct                                             → 20
 *
 * `20` is the pull request's own value, pinned as an independent literal rather
 * than re-derived from the row set the assertion polices.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: Object.assign(vi.fn(), { tx: vi.fn() }) };
});

vi.mock("@/app/settings/pensero/pensero-rollout-feature", () => ({
  isPenseroIntegrationRolloutEnabled: vi.fn(),
}));

import {
  DeliveryContributorRole,
  DeliveryPointProvider,
  Prisma,
  withDb,
} from "@repo/database";
import { isPenseroIntegrationRolloutEnabled } from "@/app/settings/pensero/pensero-rollout-feature";
// biome-ignore lint/performance/noNamespaceImport: the module's export set IS the contract under test — the gate is only as good as the absence of a second, ungated door, and a named-import list would restate the thing being verified.
import * as readModule from "../delivery-point-read";
import { readPenseroBranchDeliveryPoints } from "../delivery-point-read";

const ORG = "org-1";
/** Another tenant, colliding on every id this read joins on. */
const FOREIGN_ORG = "org-2";

const IDENTITY = { userId: "user-1", clerkUserId: "clerk-1" };

const BRANCH_4228 = "art-branch-4228";
const BRANCH_ROLES = "art-branch-roles";
const BRANCH_ZERO = "art-branch-9001";
const BRANCH_CONTRADICTED = "art-branch-5150";
const BRANCH_NO_ROWS = "art-branch-empty";

const INTERACTION_4228 = "pensero:interaction:4228";
const INTERACTION_ROLES = "pensero:interaction:roles";
const CONTRADICTED_INTERACTION = "pensero:interaction:5150";

/**
 * A stored row, as the read's `select` sees it, plus the columns it filters on
 * — and `role`, which it does NEITHER.
 *
 * `role` is real stored data (`DeliveryContributorRole` on `delivery_points`),
 * so the fixture carries it, but the read never selects or filters it. Holding
 * it here is what lets the role case below be a genuine population rather than
 * cosmetic row ids: the shares are attached to actual role values, and any
 * production attempt to narrow by role trips the unmodelled-predicate guard.
 */
type StoredRow = {
  id: string;
  organizationId: string;
  provider: string;
  role: DeliveryContributorRole;
  points: Prisma.Decimal;
  branchArtifactId: string | null;
  providerInteractionId: string | null;
  deliveredOn: Date;
};

function row(
  id: string,
  role: DeliveryContributorRole,
  points: string,
  branchArtifactId: string | null,
  providerInteractionId: string | null,
  /**
   * ISS-11117: the day the provider dated this share. Selected by the read and
   * filtered by NEITHER pass — the fold is where a window is applied.
   */
  deliveredOn: Date = DELIVERED_ON
): StoredRow {
  return {
    id,
    organizationId: ORG,
    provider: DeliveryPointProvider.PENSERO,
    role,
    points: new Prisma.Decimal(points),
    branchArtifactId,
    providerInteractionId,
    deliveredOn,
  };
}

/** The day every row of the base population is dated, unless it says otherwise. */
const DELIVERED_ON = new Date("2026-03-15T00:00:00.000Z");
/** The earlier window the 4228 creator share landed in. */
const CREATOR_DELIVERED_ON = new Date("2026-01-20T00:00:00.000Z");
/** A window holding the 4228 siblings and NOT the creator share. */
const MARCH = {
  start: new Date("2026-03-01T00:00:00.000Z"),
  end: new Date("2026-03-31T23:59:59.999Z"),
};

/**
 * One pull request worth 20 points, APPORTIONED across its role rows — Pensero
 * divides an interaction's value between roles rather than replicating it, so
 * the shares sum to the interaction's value exactly once.
 *
 * The creator row sits in an EARLIER delivery window than its siblings and
 * carries a null branch: it acquires a pull-request number only from a sibling
 * on the same interaction, and no such sibling had been fetched when it was
 * stored. That is the row a branch-keyed query cannot see.
 */
const STORED_ROWS: StoredRow[] = [
  row(
    "dp-creator-4228",
    DeliveryContributorRole.CREATOR,
    "12.5",
    null,
    INTERACTION_4228,
    // ISS-11117: dated in the EARLIER window the prose above describes, so the
    // fixture actually is the cross-window shape it claims to be. Every
    // lifetime case below is unchanged by it; the windowed case depends on it.
    CREATOR_DELIVERED_ON
  ),
  row(
    "dp-reviewer-a-4228",
    DeliveryContributorRole.REVIEWER,
    "4.2",
    BRANCH_4228,
    INTERACTION_4228
  ),
  row(
    "dp-reviewer-b-4228",
    DeliveryContributorRole.REVIEWER,
    "2.3",
    BRANCH_4228,
    INTERACTION_4228
  ),
  row(
    "dp-assignee-4228",
    DeliveryContributorRole.ASSIGNEE,
    "0.7",
    BRANCH_4228,
    INTERACTION_4228
  ),
  row(
    "dp-other-4228",
    DeliveryContributorRole.OTHER,
    "0.3",
    BRANCH_4228,
    INTERACTION_4228
  ),

  // A fully-resolved interaction carrying one share per role, each a distinct
  // value, so dropping ANY role from the sum changes the answer: 11.
  row(
    "dp-role-creator",
    DeliveryContributorRole.CREATOR,
    "5.5",
    BRANCH_ROLES,
    INTERACTION_ROLES
  ),
  row(
    "dp-role-reviewer",
    DeliveryContributorRole.REVIEWER,
    "3.25",
    BRANCH_ROLES,
    INTERACTION_ROLES
  ),
  row(
    "dp-role-assignee",
    DeliveryContributorRole.ASSIGNEE,
    "1.5",
    BRANCH_ROLES,
    INTERACTION_ROLES
  ),
  row(
    "dp-role-other",
    DeliveryContributorRole.OTHER,
    "0.75",
    BRANCH_ROLES,
    INTERACTION_ROLES
  ),

  // A MEASURED zero. Not an absence, and not a row that failed to match.
  row(
    "dp-zero-9001",
    DeliveryContributorRole.CREATOR,
    "0",
    BRANCH_ZERO,
    "pensero:interaction:9001"
  ),

  // A self-contradicting interaction: two resolved rows naming two branches.
  row(
    "dp-a-5150",
    DeliveryContributorRole.REVIEWER,
    "3",
    BRANCH_CONTRADICTED,
    CONTRADICTED_INTERACTION
  ),
  row(
    "dp-b-5150",
    DeliveryContributorRole.REVIEWER,
    "2",
    "art-branch-elsewhere",
    CONTRADICTED_INTERACTION
  ),
  row(
    "dp-creator-5150",
    DeliveryContributorRole.CREATOR,
    "9",
    null,
    CONTRADICTED_INTERACTION
  ),

  // Another tenant's row, on the SAME branch and the SAME interaction id.
  {
    ...row(
      "dp-foreign-4228",
      DeliveryContributorRole.CREATOR,
      "999",
      BRANCH_4228,
      INTERACTION_4228
    ),
    organizationId: FOREIGN_ORG,
  },
];

type DeliveryPointWhere = {
  organizationId?: string;
  provider?: string;
  branchArtifactId?: { in: string[] };
  providerInteractionId?: { in: string[] };
};

let whereClauses: DeliveryPointWhere[] = [];

/**
 * Exactly the predicates this fake models. A `where` carrying anything else is
 * a production change the fake would silently IGNORE — answering as though the
 * new predicate matched everything — which is how a narrowed query (a role
 * filter, a delivery-window bound) slips past a suite that still sees the full
 * row set. Rejecting it makes such a change fail here instead.
 */
const MODELLED_PREDICATES = new Set([
  "organizationId",
  "provider",
  "branchArtifactId",
  "providerInteractionId",
]);

/** `undefined` in a `where` means "no predicate", i.e. matches every row. */
function inList(value: string | null, clause?: { in: string[] }): boolean {
  if (clause === undefined) {
    return true;
  }
  return value !== null && clause.in.includes(value);
}

/**
 * Model Prisma, not wishful thinking: a `where` carrying no `organizationId`
 * returns EVERY tenant's rows rather than none, so dropping the predicate fails
 * the cross-tenant assertion for the reason production would have failed.
 */
function matches(candidate: StoredRow, where: DeliveryPointWhere): boolean {
  const orgOk =
    where.organizationId === undefined ||
    candidate.organizationId === where.organizationId;
  const providerOk =
    where.provider === undefined || candidate.provider === where.provider;
  return (
    orgOk &&
    providerOk &&
    inList(candidate.branchArtifactId, where.branchArtifactId) &&
    inList(candidate.providerInteractionId, where.providerInteractionId)
  );
}

function makeFakeDb(rows: StoredRow[]) {
  return {
    deliveryPoint: {
      findMany: ({ where }: { where: DeliveryPointWhere }) => {
        whereClauses.push(where);
        for (const key of Object.keys(where)) {
          if (!MODELLED_PREDICATES.has(key)) {
            throw new Error(`fake db does not model predicate "${key}"`);
          }
        }
        // Projected to the read's own `select`, so a read that leaned on an
        // unselected column would fail here rather than in production.
        const selected = rows
          .filter((candidate) => matches(candidate, where))
          .map((match) => ({
            id: match.id,
            points: match.points,
            branchArtifactId: match.branchArtifactId,
            providerInteractionId: match.providerInteractionId,
            deliveredOn: match.deliveredOn,
          }));
        return Promise.resolve(selected);
      },
    },
  };
}

let txOptions: { isolationLevel?: string; timeout?: number }[] = [];

function installDb(rows: StoredRow[] = STORED_ROWS): void {
  const db = makeFakeDb(rows);
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(callback(db as never))
  );
  vi.mocked(withDb.tx).mockImplementation((callback, options) => {
    txOptions.push(options ?? {});
    return Promise.resolve(callback(db as never));
  });
}

describe("readPenseroBranchDeliveryPoints", () => {
  beforeEach(() => {
    whereClauses = [];
    txOptions = [];
    vi.clearAllMocks();
    vi.mocked(isPenseroIntegrationRolloutEnabled).mockResolvedValue(true);
    installDb();
  });

  it("sums an interaction whose shares span two delivery windows exactly once", async () => {
    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_4228,
    ]);

    const branch = read?.byBranchArtifactId.get(BRANCH_4228);
    // 20, not 7.5 (creator share dropped) and not 27.5 (siblings double-counted).
    expect(branch?.points.toString()).toBe("20");
    // One interaction, counted once, with every one of its five shares folded in.
    expect(branch?.interactionCount).toBe(1);
    expect(branch?.rowCount).toBe(5);
    expect(read?.attributedPoints?.toString()).toBe("20");
  });

  it("resolves from the earlier window and sums only the requested one", async () => {
    // ISS-11117 (tamsinb, chatgpt-codex-connector, PR #7863). The whole reason
    // NEITHER pass filters `deliveredOn`: the creator row is in January and
    // carries a null branch, so a windowed QUERY would lose both its 12.5 and
    // its interaction. The windowed FOLD keeps the resolution and spends none
    // of that share on March.
    const march = await readPenseroBranchDeliveryPoints(
      IDENTITY,
      ORG,
      [BRANCH_4228],
      MARCH
    );

    // 7.5 = 4.2 + 2.3 + 0.7 + 0.3, the four March siblings. Paired with the
    // lifetime 20 above, which the same rows produce with no window.
    expect(march?.byBranchArtifactId.get(BRANCH_4228)?.points.toString()).toBe(
      "7.5"
    );
    expect(march?.byBranchArtifactId.get(BRANCH_4228)?.rowCount).toBe(4);
    // Still ONE interaction: it resolved from the whole row set, January share
    // included, and only the summation was narrowed.
    expect(march?.byBranchArtifactId.get(BRANCH_4228)?.interactionCount).toBe(
      1
    );
    // And the read itself is still un-windowed — no `deliveredOn` predicate
    // reached either pass, which is what the resolution above depends on.
    expect(whereClauses.some((clause) => "deliveredOn" in clause)).toBe(false);
  });

  it("sums all four roles' shares, and dedups when every row is already anchored", async () => {
    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_ROLES,
    ]);

    // This interaction carries one share per stored role — CREATOR 5.5,
    // REVIEWER 3.25, ASSIGNEE 1.5, OTHER 0.75 — and unlike the cross-window
    // case above, every row is ALREADY anchored to the branch. So it covers two
    // things at once: that no role is dropped (a creator-only read answers 5.5;
    // any other single-role predicate answers its own share; only all four make
    // 11), and that the sibling pass re-returning fully-anchored rows does not
    // double them.
    expect(read?.byBranchArtifactId.get(BRANCH_ROLES)?.points.toString()).toBe(
      "11"
    );
    expect(read?.byBranchArtifactId.get(BRANCH_ROLES)?.rowCount).toBe(4);
    expect(read?.byBranchArtifactId.get(BRANCH_ROLES)?.interactionCount).toBe(
      1
    );
  });

  it("reads both passes inside ONE repeatable-read snapshot", async () => {
    await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [BRANCH_4228]);

    // `branchArtifactId` is restated on every re-match, so a relink committing
    // between the two passes would make one interaction's rows disagree about
    // their branch and get the whole interaction refused. One transaction at
    // RepeatableRead is what stops that (ISS-4669's fix, applied here).
    expect(withDb.tx).toHaveBeenCalledTimes(1);
    expect(withDb).not.toHaveBeenCalled();
    expect(txOptions).toEqual([
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    ]);
  });

  it("reports a measured zero as zero, and an unpopulated branch as no data", async () => {
    const measured = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_ZERO,
    ]);
    const absent = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_NO_ROWS,
    ]);

    // A genuine 0-point population. `0` is a MEASURED value here.
    expect(measured?.attributedPoints?.toString()).toBe("0");
    expect(
      measured?.byBranchArtifactId.get(BRANCH_ZERO)?.points.toString()
    ).toBe("0");
    // No delivery evidence at all — a different answer from the measured zero
    // above, and never rendered as one.
    expect(absent?.attributedPoints).toBeNull();
    expect(absent?.byBranchArtifactId.size).toBe(0);
    expect(absent?.unattributed.rowCount).toBe(0);
  });

  it("reads an empty table as no data rather than as zero points", async () => {
    installDb([]);

    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_4228,
      BRANCH_ZERO,
    ]);

    expect(read).not.toBeNull();
    expect(read?.attributedPoints).toBeNull();
    expect(read?.byBranchArtifactId.size).toBe(0);
    expect(read?.unattributed.rowCount).toBe(0);
  });

  it("neither sums nor discards an interaction whose rows name two branches", async () => {
    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_CONTRADICTED,
    ]);

    // Not arbitrated onto either branch...
    expect(read?.byBranchArtifactId.has(BRANCH_CONTRADICTED)).toBe(false);
    expect(read?.attributedPoints).toBeNull();
    // ...and not folded in as 0 or silently dropped: all three shares are
    // reported, so a caller knows its total is short of the population.
    expect(read?.unattributed.rowCount).toBe(3);
    expect(read?.unattributed.interactionIds).toEqual([
      CONTRADICTED_INTERACTION,
    ]);
  });

  it("excludes another tenant's rows from this organization's numerator", async () => {
    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_4228,
    ]);

    // The foreign row carries 999 points on the same branch and the same
    // interaction id; dropping the org predicate would answer 1019.
    expect(read?.attributedPoints?.toString()).toBe("20");
  });

  it("scopes every query to the organization and to the Pensero provider", async () => {
    await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [BRANCH_4228]);

    expect(whereClauses.length).toBeGreaterThan(0);
    for (const where of whereClauses) {
      expect(where.organizationId).toBe(ORG);
      expect(where.provider).toBe(DeliveryPointProvider.PENSERO);
    }
  });

  it("refuses to read for a principal outside the pensero-integration rollout", async () => {
    vi.mocked(isPenseroIntegrationRolloutEnabled).mockResolvedValue(false);

    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [
      BRANCH_4228,
    ]);

    // The credential-precedence hazard: rows written under a credential stored
    // outside the rollout must not become an org's visible attribution. The
    // refusal is `null` — not an empty read, which a caller could mistake for a
    // measured zero — and no query is issued at all.
    expect(read).toBeNull();
    expect(withDb).not.toHaveBeenCalled();
    expect(withDb.tx).not.toHaveBeenCalled();
  });

  it("evaluates the rollout gate against the requesting principal", async () => {
    await readPenseroBranchDeliveryPoints(IDENTITY, ORG, [BRANCH_4228]);

    expect(isPenseroIntegrationRolloutEnabled).toHaveBeenCalledWith(IDENTITY);
  });

  it("exposes no ungated read a caller could use to bypass the rollout gate", () => {
    // The neutralization is only as good as the absence of a second door.
    expect(Object.keys(readModule).sort()).toEqual([
      "readPenseroBranchDeliveryPoints",
    ]);
  });

  it("issues no query at all when no branches are requested", async () => {
    const read = await readPenseroBranchDeliveryPoints(IDENTITY, ORG, []);

    expect(read?.attributedPoints).toBeNull();
    expect(withDb).not.toHaveBeenCalled();
    expect(withDb.tx).not.toHaveBeenCalled();
  });
});
