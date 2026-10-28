/**
 * ISS-6768: the component detail read must emit the per-user INSTALLER roster
 * (`AgentComponentDetail.installers`) it folds from the identity's live
 * inventory rows.
 *
 * The web Packs catalog feeds `PackDetail` from this endpoint while the desktop
 * Plugins panel feeds it from `GET /agent-components/pack/{packId}`, and only
 * the latter carried a roster — so the same pack showed a populated "Used by"
 * stack on desktop and "Used by (0)" on web. Both now fold the SAME rows through
 * `installerRosterOf`; `pack-analytics-service.test.ts` covers the desktop half.
 *
 * The roster is deliberately NOT the authors set (`collaborators` / `owner`):
 * those model who WROTE the definition, and conflating the two would show
 * authors as users and omit real users who never edited it.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type PrismaOrderBy, sortByPrismaOrderBy } from "./prisma-order-double";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
  listByArtifactIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";

const ORGANIZATION_ID = "org-1";
const COMPONENT_KEY = "my-skill";
const SLUG = encodeComponentSlug(AgentComponentKind.Skill, COMPONENT_KEY, null);

type RosterUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
};

function inventoryRow(
  id: string,
  computeTargetId: string,
  user: RosterUser,
  metadata: unknown = null,
  lastSeenAt: Date | null = new Date("2026-01-10T00:00:00.000Z")
) {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    computeTargetId,
    componentKind: AgentComponentKind.Skill,
    componentKey: COMPONENT_KEY,
    externalComponentId: `skill::${COMPONENT_KEY}`,
    harness: "claude",
    name: "My Skill",
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    description: null,
    metadata,
    content: "BODY",
    contentHash: null,
    resolvedState: "resolved",
    variantsTruncated: false,
    variantsTruncatedReason: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt,
    computeTarget: { id: computeTargetId, userId: user.id },
    sessionUsages: [],
  };
}

/** The `user.findMany` args the org-scoped name resolution must carry. */
type UserFindManyArgs = {
  where?: { organizationId?: string; id?: { in?: string[] } };
};

/**
 * `orgUsers` is the org-scoped `User` read the roster resolves names through.
 * A user omitted from it is a user this organization cannot see — which is the
 * cross-org boundary, not a fixture detail.
 */
function installDetailDb(
  inventory: Record<string, unknown>[],
  orgUsers: RosterUser[] = []
) {
  // The read's own `orderBy` decides the row order, with PostgreSQL's real null
  // placement — so the roster's ordering guarantee is proven by the query rather
  // than by the fixture's insertion order.
  const inventoryFindMany = vi
    .fn()
    .mockImplementation(({ orderBy }: { orderBy?: PrismaOrderBy } = {}) =>
      Promise.resolve(sortByPrismaOrderBy(inventory, orderBy))
    );
  const userFindMany = vi
    .fn()
    .mockImplementation(({ where }: UserFindManyArgs) => {
      const requested = new Set(where?.id?.in ?? []);
      return Promise.resolve(
        orgUsers.filter(
          (user) =>
            requested.has(user.id) && where?.organizationId === ORGANIZATION_ID
        )
      );
    });
  const db = {
    agentComponent: {
      findMany: inventoryFindMany,
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentVersion: { findMany: vi.fn().mockResolvedValue([]) },
    agentComponentSessionUsage: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentInvocation: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
    definitionVersion: { findMany: vi.fn().mockResolvedValue([]) },
    definitionVersionEditor: { findMany: vi.fn().mockResolvedValue([]) },
    sourceOccurrence: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: userFindMany },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
  };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return { inventoryFindMany, userFindMany };
}

const ADA: RosterUser = {
  id: "user-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
};
const GRACE: RosterUser = {
  id: "user-2",
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
};

describe("getDetailForOrg — installer roster (ISS-6768)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("emits one installer per distinct user across the identity's devices", async () => {
    installDetailDb(
      [
        inventoryRow("ac-1", "target-1", ADA),
        inventoryRow("ac-2", "target-2", GRACE),
        // Ada's second machine — the same person, not a second installer.
        inventoryRow("ac-3", "target-3", ADA),
      ],
      [ADA, GRACE]
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.installers).toEqual(["Ada Lovelace", "Grace Hopper"]);
    // Devices stay the device count; the roster is a headcount, not a rehash.
    expect(detail?.computeTargetIds).toHaveLength(3);
  });

  it("resolves installer names through an org-scoped user read, not the row's join", async () => {
    // davetho (ISS-6768): `AgentComponent`, `ComputeTarget`, and `User` carry
    // independent org foreign keys, so a nested `computeTarget.user` projection
    // would hand back whatever user the link points at — including another
    // tenant's. The name must come from a `User` read this org scopes.
    const { inventoryFindMany, userFindMany } = installDetailDb(
      [inventoryRow("ac-1", "target-1", ADA)],
      [ADA]
    );

    await agentComponentsService.getDetailForOrg(ORGANIZATION_ID, SLUG);

    const inventoryArgs = inventoryFindMany.mock.calls
      .map(([call]) => call as { select?: { computeTarget?: unknown } })
      .find((call) => call?.select?.computeTarget);
    expect(inventoryArgs?.select?.computeTarget).not.toMatchObject({
      select: { user: expect.anything() },
    });

    const userArgs = userFindMany.mock.calls.map(
      ([call]) => call as UserFindManyArgs
    );
    expect(userArgs.length).toBeGreaterThan(0);
    for (const args of userArgs) {
      expect(args.where?.organizationId).toBe(ORGANIZATION_ID);
    }
  });

  it("omits an installer whose compute-target user is outside the organization", async () => {
    // The cross-org negative: a stale or inconsistent target link resolves to a
    // user this org cannot read, so the roster drops the row rather than
    // rendering another tenant's name or fallback email.
    const foreign: RosterUser = {
      id: "user-other-org",
      firstName: "Elsewhere",
      lastName: "Person",
      email: "elsewhere@other-tenant.example.com",
    };
    installDetailDb(
      [
        inventoryRow("ac-1", "target-1", foreign),
        inventoryRow("ac-2", "target-2", GRACE),
      ],
      // `foreign` is deliberately absent from the org-scoped read.
      [GRACE]
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.installers).toEqual(["Grace Hopper"]);
    expect(detail?.installers).not.toContain("Elsewhere Person");
    expect(detail?.installers).not.toContain(foreign.email);
  });

  it("orders an install with no lastSeenAt behind one that has it", async () => {
    // davetho (ISS-6768): the roster's "most recently seen install first"
    // guarantee does not hold on a bare `lastSeenAt: "desc"` — PostgreSQL sorts
    // nulls FIRST on a descending sort, so a legacy row that never recorded a
    // timestamp leads the roster ahead of a genuinely recent installer. Only the
    // explicit `nulls: "last"` puts the unknown timestamp behind the known one.
    const legacy: RosterUser = {
      id: "user-legacy",
      firstName: "Legacy",
      lastName: "Install",
      email: "legacy@example.com",
    };
    installDetailDb(
      [
        // Fixture order deliberately leads with the null-timestamp row, so the
        // assertion can only pass if the QUERY reordered it.
        inventoryRow("ac-1", "target-1", legacy, null, null),
        inventoryRow(
          "ac-2",
          "target-2",
          GRACE,
          null,
          new Date("2026-02-01T00:00:00.000Z")
        ),
      ],
      [legacy, GRACE]
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.installers).toEqual(["Grace Hopper", "Legacy Install"]);
  });

  it("keeps two same-named users apart — dedupe is by user id, not name", async () => {
    const otherAda: RosterUser = { ...ADA, id: "user-3" };
    installDetailDb(
      [
        inventoryRow("ac-1", "target-1", ADA),
        inventoryRow("ac-2", "target-2", otherAda),
      ],
      [ADA, otherAda]
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    // Two distinct people who share a display name are two installers; a
    // name-keyed dedupe would collapse them and undercount adoption.
    expect(detail?.installers).toEqual(["Ada Lovelace", "Ada Lovelace"]);
  });

  it("falls back to the email when a user has no name parts", async () => {
    const noName: RosterUser = {
      id: "user-4",
      firstName: null,
      lastName: null,
      email: "noname@example.com",
    };
    installDetailDb([inventoryRow("ac-1", "target-1", noName)], [noName]);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.installers).toEqual(["noname@example.com"]);
  });

  it("does not count a cloud-authored sentinel row as an install (FEA-4247)", async () => {
    // A promoted `CatalogItem` is backfilled onto the org's synthetic "cloud"
    // compute target, whose user is the org's earliest active user — not an
    // installer. Counting it would report a pack nobody installed as
    // "Used by (1) <unrelated person>" on the web Packs detail.
    installDetailDb(
      [inventoryRow("ac-1", "target-cloud", ADA, { cloudAuthored: true })],
      [ADA]
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.installers).toEqual([]);
  });

  it("keeps the real installers of a component that also has a sentinel row", async () => {
    // The control for the case above: the sentinel exclusion must drop only the
    // sentinel, not blank the roster for every identity that carries one.
    installDetailDb(
      [
        inventoryRow("ac-1", "target-cloud", ADA, { cloudAuthored: true }),
        inventoryRow("ac-2", "target-2", GRACE),
      ],
      [ADA, GRACE]
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.installers).toEqual(["Grace Hopper"]);
  });
});
