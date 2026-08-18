/**
 * ISS-5029: the component detail read must say when its revision history is
 * PARTIAL instead of presenting a capped set exactly like a complete one.
 *
 * Two independent caps can drop a revision, and the marker is their OR:
 *  - the desktop packer dropped retained revisions at its per-family entry cap /
 *    variant byte budget, so they never reached the cloud
 *    (`AgentComponent.variantsTruncated`, folded across the identity's devices);
 *  - this read's own `MAX_COMPONENT_VERSION_ROWS` bound.
 *
 * Both directions are asserted for each: only the pair discriminates a correct
 * implementation from one that is always-true or never-true. The truncation is
 * read from the query whose `take` actually BOUND — never inferred from the
 * returned length, which the UNION-fallback/dedupe in this lane can change
 * independently of whether anything was dropped (the ISS-4797/4799 lesson, #4354).
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import {
  SYNCED_COMPONENT_VARIANTS_MAX,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // ISS-4669/ISS-5363: the detail's three usage lanes share one `RepeatableRead`
  // snapshot, so this path now reaches the isolation-level enum.
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

/**
 * The detail read's own version-history cap (`MAX_COMPONENT_VERSION_ROWS`).
 * Redeclared here because it is a private module bound; the "exactly the cap"
 * case below is what pins the two together — it fails if they ever disagree.
 */
const DETAIL_VERSION_ROWS_CAP = 20;

/**
 * The most revisions of one family a single sync can carry — the shared variants
 * cap plus the primary. Imported from the shared constant, not restated, so this
 * suite cannot drift from the ceiling the service actually applies.
 */
const MAX_REVISIONS_PER_FAMILY_PER_SYNC = SYNCED_COMPONENT_VARIANTS_MAX + 1;

/**
 * ISS-5029 (wongk, #4391): the only cap reason that bounds how many revisions a
 * device holds, and therefore the only one the cloud can reconcile into a proof.
 */
const FAMILY_CAP = SyncedComponentVariantsTruncatedReason.FamilyCap;

/** A device row reporting the one cap reason that proves the cloud is short. */
function familyCapped(overrides: Record<string, unknown> = {}) {
  return {
    variantsTruncated: true,
    variantsTruncatedReason: FAMILY_CAP,
    ...overrides,
  };
}

function inventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ac-1",
    organizationId: ORGANIZATION_ID,
    computeTargetId: "target-1",
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
    metadata: null,
    content: "BODY",
    contentHash: "hash-0",
    resolvedState: "resolved",
    variantsTruncated: false,
    variantsTruncatedReason: null,
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-10T00:00:00.000Z"),
    computeTarget: { id: "target-1", userId: "user-1" },
    sessionUsages: [],
    ...overrides,
  };
}

function versionRow(index: number) {
  return {
    contentHash: `hash-${index}`,
    source: "",
    format: "md",
    firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    content: `BODY ${index}`,
    definitionVersion: null,
  };
}

/**
 * Install a detail-read `db` with `inventory` rows and `versionCount` stored
 * revisions. The version delegate models the real `take` (the production read
 * asks for one row past the cap on purpose), so a slice bug is observable here
 * rather than hidden behind a fixture that returns everything.
 */
function installDetailDb(
  inventory: Record<string, unknown>[],
  versionCount: number
) {
  // Models BOTH reads the service issues: the bounded body page (`take`) and the
  // body-free sentinel probe (`skip: take, take: 1`). Honoring `skip` is what
  // makes a slice/offset bug observable here instead of hidden by a fixture that
  // returns everything.
  const versionFindMany = vi.fn(
    (args: {
      select: Record<string, unknown>;
      skip?: number;
      take?: number;
    }) => {
      const all = Array.from({ length: versionCount }, (_, index) =>
        versionRow(index)
      );
      const from = args.skip ?? 0;
      return Promise.resolve(all.slice(from, from + (args.take ?? all.length)));
    }
  );

  const db = {
    agentComponent: {
      findMany: vi.fn().mockResolvedValue(inventory),
      // ISS-5363: the detail's elsewhere-linked usage lane bounds itself by the
      // LIST's inventory population, which resolves an identity spine first.
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentVersion: { findMany: versionFindMany },
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
    user: { findMany: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
  };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return { versionFindMany };
}

/**
 * A content-hash detail key whose identity spans TWO names — the same bytes
 * installed twice (FEA-4335). Both inventory rows carry the routed fingerprint
 * as their `contentHash`, which is what the identity resolution keys on.
 */
const FINGERPRINT = "a".repeat(64);
const ALIAS_KEY = "aliased-skill";
const HASH_SLUG = encodeComponentSlug(AgentComponentKind.Skill, FINGERPRINT);

function aliasInventoryRow(overrides: Record<string, unknown> = {}) {
  return inventoryRow({
    id: "ac-alias",
    componentKey: ALIAS_KEY,
    externalComponentId: `skill::${ALIAS_KEY}`,
    name: "Aliased Skill",
    contentHash: FINGERPRINT,
    computeTargetId: "target-2",
    computeTarget: { id: "target-2", userId: "user-2" },
    ...overrides,
  });
}

/**
 * Install a detail-read `db` for the multi-name content identity, with
 * `revisionsByKey[name]` stored revisions under each name.
 *
 * The version delegate discriminates the three reads the service issues over
 * that table rather than returning one fixture to all of them — which read sees
 * which rows IS the behavior under test (#4391). Identity resolution selects
 * `componentKey`; the history page and its sentinel select over an `OR` of the
 * identity's names, and are served only the revisions whose name that `OR`
 * actually asked for, so a narrowed predicate shows up as missing revisions
 * instead of being hidden by a permissive double.
 */
function installMultiNameDetailDb(
  inventory: Record<string, unknown>[],
  revisionsByKey: Record<string, number>
) {
  const revisions = Object.entries(revisionsByKey).flatMap(([key, count]) =>
    Array.from({ length: count }, (_, index) => ({
      ...versionRow(index),
      componentKey: key,
      contentHash: `hash-${key}-${index}`,
    }))
  );

  const versionFindMany = vi.fn(
    (args: {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
      skip?: number;
      take?: number;
    }) => {
      if (args.select?.componentKey === true) {
        // Identity resolution: the exact `definitionHash` route matches nothing
        // here (no linked DefinitionVersion), so the coarse `contentHash` route
        // resolves — one routed row per name.
        if (args.where?.definitionVersion) {
          return Promise.resolve([]);
        }
        return Promise.resolve(
          Object.keys(revisionsByKey).map((key) => ({
            componentKey: key,
            contentHash: FINGERPRINT,
          }))
        );
      }
      const or = args.where?.OR;
      if (!Array.isArray(or)) {
        return Promise.resolve([]);
      }
      const asked = new Set(
        or.map(
          (clause: { componentKey?: { equals?: string } }) =>
            clause.componentKey?.equals
        )
      );
      const matched = revisions.filter((row) => asked.has(row.componentKey));
      const from = args.skip ?? 0;
      return Promise.resolve(
        matched.slice(from, from + (args.take ?? matched.length))
      );
    }
  );

  const db = {
    agentComponent: {
      findMany: vi.fn().mockResolvedValue(inventory),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentComponentVersion: { findMany: versionFindMany },
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
    user: { findMany: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
  };
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db)
  );
  return { versionFindMany };
}

describe("getDetailForOrg — ISS-5029 versionsTruncated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listByArtifactIds.mockResolvedValue([]);
  });

  it("OMITS the marker when neither cap bound", async () => {
    installDetailDb([inventoryRow()], 3);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versions).toHaveLength(3);
    // Preserve OMISSION for the ordinary complete case, so an older reader sees
    // byte-identical payload and "absent" unambiguously means "not truncated".
    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("OMITS the marker at EXACTLY the read cap — a full page is not a truncated one", async () => {
    installDetailDb([inventoryRow()], DETAIL_VERSION_ROWS_CAP);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    // The off-by-one that a length comparison gets wrong: the page is full, but
    // nothing was dropped. This also pins the local cap constant against the
    // production one — if they drift, this case reports a phantom truncation.
    expect(detail?.versions).toHaveLength(DETAIL_VERSION_ROWS_CAP);
    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("SETS the marker when the read's own take bound, and still returns exactly the cap", async () => {
    const { versionFindMany } = installDetailDb(
      [inventoryRow()],
      DETAIL_VERSION_ROWS_CAP + 5
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versionsTruncated).toBe(true);
    // The sentinel row is a probe, not payload: the DTO must still carry the cap.
    expect(detail?.versions).toHaveLength(DETAIL_VERSION_ROWS_CAP);
    // The body page is read at EXACTLY the cap; the extra row is probed by a
    // separate body-free query, so the sentinel never costs a 256 KiB body.
    const [bodyRead, sentinelRead] = versionFindMany.mock.calls.map(
      (call) => call[0]
    );
    expect(bodyRead.take).toBe(DETAIL_VERSION_ROWS_CAP);
    expect(bodyRead.select.content).toBe(true);
    expect(sentinelRead.skip).toBe(DETAIL_VERSION_ROWS_CAP);
    expect(sentinelRead.take).toBe(1);
    expect(Object.hasOwn(sentinelRead.select, "content")).toBe(false);
  });

  it("SETS the marker when a DEVICE could not ship everything it holds and the cloud is provably behind", async () => {
    // The sync-side cap: the cloud holds few revisions precisely BECAUSE the
    // packer never shipped the rest. Nothing about the read's own bound can see
    // that — only the persisted marker can.
    installDetailDb([inventoryRow(familyCapped())], 2);

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versions).toHaveLength(2);
    expect(detail?.versionsTruncated).toBe(true);
  });

  it("STAYS SILENT when a device is capped but the cloud already holds more than one sync could carry", async () => {
    // The false positive a bare OR produced. The desktop's retained-revision
    // table is append-only (no prune exists), so a definition edited more than
    // the per-family cap leaves that device's cap bound on EVERY later sync —
    // while the cloud accumulates the union of every subset ever shipped and can
    // by then hold the complete history. Above the one-sync ceiling nothing is
    // provable, so the panel must not claim incompleteness over a list that is
    // demonstrably complete.
    installDetailDb(
      [inventoryRow(familyCapped())],
      MAX_REVISIONS_PER_FAMILY_PER_SYNC + 1
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versions).toHaveLength(
      MAX_REVISIONS_PER_FAMILY_PER_SYNC + 1
    );
    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("SETS the marker at EXACTLY the one-sync ceiling — that count is still reachable in one batch", async () => {
    // The boundary of the proof: a stored family at exactly the ceiling could
    // have arrived in the single sync that reported truncating, so a capped
    // device still proves the cloud is missing at least one revision.
    installDetailDb(
      [inventoryRow(familyCapped())],
      MAX_REVISIONS_PER_FAMILY_PER_SYNC
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versionsTruncated).toBe(true);
  });

  it("STAYS SILENT when the device only hit its BYTE BUDGET, whose stop proves nothing", async () => {
    // wongk, #4391. The gap in the ceiling argument. It is derived from a
    // per-FAMILY cap, which cannot bind unless the family holds more revisions
    // than one sync can carry — that is the lower bound the ceiling compares
    // against. The per-component BYTE BUDGET has no such property: a component
    // with large definition bodies can stop after two shipped revisions on EVERY
    // sync while the cloud, which accumulates the union of every subset ever
    // shipped, already holds the whole history. The stored count then sits far
    // under the ceiling forever and the panel claimed partiality over a complete
    // list — the same false positive the ceiling was introduced to remove, one
    // cap over.
    installDetailDb(
      [
        inventoryRow({
          variantsTruncated: true,
          variantsTruncatedReason:
            SyncedComponentVariantsTruncatedReason.ByteBudget,
        }),
      ],
      2
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versions).toHaveLength(2);
    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("STAYS SILENT on a cap reason this cloud does not recognize", async () => {
    // The forward-compat direction of the same rule. The wire field is an
    // unconstrained string so a reason a newer desktop introduces can never
    // reject a 200-component batch; the cost of that is that this cloud may hold
    // a value it cannot interpret. Unknown must degrade to "no proof" — the same
    // safe default as absent — never to a claim it cannot support.
    installDetailDb(
      [
        inventoryRow({
          variantsTruncated: true,
          variantsTruncatedReason: "some_future_cap",
        }),
      ],
      2
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("STAYS SILENT when a marker-aware device reports truncation with NO reason at all", async () => {
    // The migration-window row: `variants_truncated` was written before the
    // reason column existed, so the boolean is true and the reason is null.
    // Un-reconcilable, therefore not proof.
    installDetailDb(
      [
        inventoryRow({
          variantsTruncated: true,
          variantsTruncatedReason: null,
        }),
      ],
      2
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("the READ cap still wins over the one-sync ceiling", async () => {
    // Ordering guard: a stored family above the ceiling makes the device signal
    // unprovable, but the read's own bound is independent evidence and must
    // still fire. Without it, the ceiling check would suppress a genuine
    // read-side truncation.
    installDetailDb(
      [inventoryRow(familyCapped())],
      DETAIL_VERSION_ROWS_CAP + 5
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versionsTruncated).toBe(true);
  });

  it("folds the device marker across every inventory row — one truncating device is enough", async () => {
    installDetailDb(
      [
        inventoryRow({ variantsTruncated: false }),
        inventoryRow({
          id: "ac-2",
          computeTargetId: "target-2",
          computeTarget: { id: "target-2", userId: "user-2" },
          variantsTruncated: true,
          variantsTruncatedReason: FAMILY_CAP,
        }),
      ],
      2
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    // The cloud's version set is the UNION of what the devices shipped, so a
    // single device that capped makes the org-level history partial.
    expect(detail?.versionsTruncated).toBe(true);
  });

  it("STAYS SILENT when the only truncating device reports on a name the version count does not cover", async () => {
    // #4391 review. The inventory predicate for a content-hash identity is
    // `contentHash IN (…)` with NO name filter, so it can select a device row
    // whose name carries no revision row at all — a family the version count
    // never read. Folding that row in compares a cap on family B against a count
    // for family A: the count under-reads, the one-sync ceiling holds
    // spuriously, and the panel claims partiality over a complete list.
    installDetailDb(
      [
        inventoryRow({ variantsTruncated: false }),
        inventoryRow({
          id: "ac-2",
          computeTargetId: "target-2",
          computeTarget: { id: "target-2", userId: "user-2" },
          componentKey: "other-name",
          name: "Other Name",
          variantsTruncated: true,
          variantsTruncatedReason: FAMILY_CAP,
        }),
      ],
      2
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versions).toHaveLength(2);
    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("reads the identity's revisions under EVERY name that shares the content", async () => {
    // #4391 review. `content-hash-identity.ts` names version history among the
    // reads that "scope usage across EVERY name that shares the content", but
    // the read was issued with `keys[0]` alone. The same bytes installed twice
    // therefore split the family: the selector silently dropped the alternate
    // name's revisions.
    installMultiNameDetailDb([aliasInventoryRow(), inventoryRow()], {
      [COMPONENT_KEY]: 2,
      [ALIAS_KEY]: 2,
    });

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      HASH_SLUG
    );

    expect(detail?.versions).toHaveLength(4);
    expect(Object.hasOwn(detail ?? {}, "versionsTruncated")).toBe(false);
  });

  it("SETS the marker when the identity's revisions ACROSS names exceed the read cap, though neither name alone does", async () => {
    // The capped-set-presented-as-complete case this ticket exists to remove.
    // The sentinel probes the same predicate the body page used, so a per-name
    // predicate reported a split page complete: 12 of 24 revisions, `truncated`
    // false, and the panel rendered that page exactly like a whole history.
    installMultiNameDetailDb([aliasInventoryRow(), inventoryRow()], {
      [COMPONENT_KEY]: 12,
      [ALIAS_KEY]: 12,
    });

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      HASH_SLUG
    );

    expect(detail?.versions).toHaveLength(DETAIL_VERSION_ROWS_CAP);
    expect(detail?.versionsTruncated).toBe(true);
  });

  it("folds a device capped under an ALTERNATE name of the identity, now that the count covers it", async () => {
    // The other side of the family-scoping rule: once both sides name the same
    // set, a cap reported under the alternate name is comparable against the
    // count and must fold in. The union sits at the one-sync ceiling, so every
    // individual family is at or under it too and the proof holds.
    installMultiNameDetailDb(
      [aliasInventoryRow(familyCapped()), inventoryRow()],
      { [COMPONENT_KEY]: 1, [ALIAS_KEY]: 1 }
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      HASH_SLUG
    );

    expect(detail?.versionsTruncated).toBe(true);
  });

  it("still folds a truncating device whose key differs only in CASE", async () => {
    // The negative above must not become a case-sensitivity bug: an event-minted
    // row stores the raw-case subagent type while the read key is normalized, so
    // the same family under two casings is still one family.
    installDetailDb(
      [
        inventoryRow({
          componentKey: COMPONENT_KEY.toUpperCase(),
          variantsTruncated: true,
          variantsTruncatedReason: FAMILY_CAP,
        }),
      ],
      2
    );

    const detail = await agentComponentsService.getDetailForOrg(
      ORGANIZATION_ID,
      SLUG
    );

    expect(detail?.versionsTruncated).toBe(true);
  });
});
