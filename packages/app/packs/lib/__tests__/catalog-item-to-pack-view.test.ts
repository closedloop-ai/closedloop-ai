import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  DistributionTargetingType,
  type DistributionTargetStatusDto,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { describe, expect, it } from "vitest";
import {
  catalogItemToPackView,
  distributionToPackDistribution,
} from "../catalog-item-to-pack-view";
import { toDistributedPackRowsFromDistributions } from "../distributed-pack-row";
import { PackInstallState } from "../install-state";
import type { InstallMatrixTarget } from "../pack-install-matrix";
import { PackContentKind, packDisambiguators } from "../pack-view";

describe("catalogItemToPackView", () => {
  it("preserves canonical catalog component content on pack contents", () => {
    const item = makeCatalogItem({
      components: [
        makeCatalogItem({
          id: "component-with-content",
          targetKind: "agent",
          name: "Planner Agent",
          description: "Plans work",
          content: "# Planner\n\nYou are a planner.",
          parentPackId: "pack-1",
        }),
        makeCatalogItem({
          id: "component-without-content",
          targetKind: "skill",
          name: "Empty Skill",
          description: null,
          content: null,
          parentPackId: "pack-1",
        }),
      ],
    });

    const view = catalogItemToPackView(item);

    expect(view.contents).toEqual([
      {
        name: "Planner Agent",
        kind: PackContentKind.Agent,
        description: "Plans work",
        content: "# Planner\n\nYou are a planner.",
      },
      {
        name: "Empty Skill",
        kind: PackContentKind.Skill,
        description: null,
        content: null,
      },
    ]);
  });

  it("carries the catalog version onto the pack view", () => {
    const view = catalogItemToPackView(makeCatalogItem({ version: "2.3.1" }));

    expect(view.version).toBe("2.3.1");
  });

  it("keeps single-target accessors back-compat (no matrix without targets)", () => {
    // The new install-matrix axis is additive: with no resolved targets, the
    // single-target booleans keep their existing shape and installMatrix stays
    // null so existing consumers are unaffected (FEA-4072a).
    const view = catalogItemToPackView(
      makeCatalogItem(),
      makeDistribution({
        targetStatuses: [
          makeTargetStatus({
            id: "ts-1",
            status: DistributionTargetStatusValue.Installed,
          }),
        ],
      })
    );

    expect(view.installedByMe).toBe(false);
    expect(view.installedHarnesses).toEqual([]);
    expect(view.installMatrix).toBeNull();
  });

  it("populates the per-(target × harness) install matrix when targets are supplied", () => {
    const targets: InstallMatrixTarget[] = [
      {
        computeTargetId: "ct-a",
        computeTargetName: "MacBook A",
        harness: "claude",
        online: true,
      },
      {
        computeTargetId: "ct-b",
        computeTargetName: "MacBook B",
        harness: "codex",
        online: false,
      },
    ];
    const view = catalogItemToPackView(
      makeCatalogItem({ id: "pack-1", name: "Content Pack" }),
      makeDistribution({
        targetStatuses: [
          makeTargetStatus({
            id: "ts-a",
            computeTargetId: "ct-a",
            status: DistributionTargetStatusValue.Installed,
          }),
          makeTargetStatus({
            id: "ts-b",
            computeTargetId: "ct-b",
            status: DistributionTargetStatusValue.Installed,
          }),
        ],
      }),
      targets
    );

    expect(view.installMatrix).toHaveLength(1);
    const matrix = view.installMatrix?.[0];
    expect(matrix?.componentId).toBe("pack-1");
    expect(matrix?.cells).toHaveLength(2);
    expect(matrix?.cells.find((c) => c.computeTargetId === "ct-a")?.state).toBe(
      PackInstallState.Installed
    );
    // ct-b is offline → honest Offline cell even though it reported installed.
    expect(matrix?.cells.find((c) => c.computeTargetId === "ct-b")?.state).toBe(
      PackInstallState.Offline
    );
    // Single-target accessors remain untouched (back-compat).
    expect(view.installedByMe).toBe(false);
  });

  it("leaves the matrix null when a distribution has targets but no statuses were resolved", () => {
    const view = catalogItemToPackView(makeCatalogItem(), makeDistribution(), [
      {
        computeTargetId: "ct-a",
        computeTargetName: "MacBook A",
        harness: "claude",
        online: true,
      },
    ]);

    // Distribution present, targets present, no status rows: every online
    // target with no row is NotInstalled — the matrix exists and is honest.
    expect(view.installMatrix).toHaveLength(1);
    expect(view.installMatrix?.[0]?.cells[0]?.state).toBe(
      PackInstallState.NotInstalled
    );
  });

  it("disambiguates real same-named Pack adapter output on version, not the constant kind", () => {
    // A "Pack" is a targetKind='agent' catalog item, so every same-named Pack
    // shares the category the adapter maps onto `category` (item.targetKind).
    // Category can never separate them — the qualifier must fall through to a
    // dimension that actually differs (version here), for the REAL adapter shape.
    const packs = [
      catalogItemToPackView(
        makeCatalogItem({
          id: "0192f0000000700080000000000000a1",
          targetKind: "agent",
          name: "test-strategist",
          version: "1.4.0",
        })
      ),
      catalogItemToPackView(
        makeCatalogItem({
          id: "0192f0000000700080000000000000a2",
          targetKind: "agent",
          name: "test-strategist",
          version: "2.0.0",
        })
      ),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("0192f0000000700080000000000000a1")).toBe("v1.4.0");
    expect(qualifiers.get("0192f0000000700080000000000000a2")).toBe("v2.0.0");
  });

  it("uses the publisher last resort when name, kind, and version all match", () => {
    // Two org-custom Packs vs. a curated Pack of the same name/version: the
    // adapter derives distinct publishers ("Your organization" vs "ClosedLoop"),
    // which is what a person can actually act on when nothing else differs.
    const packs = [
      catalogItemToPackView(
        makeCatalogItem({
          id: "0192f0000000700080000000000000b1",
          targetKind: "agent",
          name: "audit-ledger",
          version: "1.0.0",
          source: CatalogItemSource.OrgCustom,
        })
      ),
      catalogItemToPackView(
        makeCatalogItem({
          id: "0192f0000000700080000000000000b2",
          targetKind: "agent",
          name: "audit-ledger",
          version: "1.0.0",
          source: CatalogItemSource.Curated,
        })
      ),
    ];

    const qualifiers = packDisambiguators(packs);

    expect(qualifiers.get("0192f0000000700080000000000000b1")).toBe(
      "Your organization"
    );
    expect(qualifiers.get("0192f0000000700080000000000000b2")).toBe(
      "ClosedLoop"
    );
  });
});

describe("distributionToPackDistribution adoption availability", () => {
  it("marks adoption unloaded for a list DTO (empty targetStatuses)", () => {
    // The GET /distributions list read carries no per-target statuses. The
    // mapper must set adoptionLoaded=false so the row reads "Not available",
    // never a fabricated 0 — and must NOT infer availability from `targets`.
    const mapped = distributionToPackDistribution(
      makeDistribution({ targetStatuses: [] })
    );

    expect(mapped.adoptionLoaded).toBe(false);
    expect(mapped.targets).toBeUndefined();
  });

  it("marks adoption loaded for a detail DTO (populated targetStatuses)", () => {
    const mapped = distributionToPackDistribution(
      makeDistribution({
        targetStatuses: [
          makeTargetStatus({ status: DistributionTargetStatusValue.Installed }),
          makeTargetStatus({
            id: "ts-2",
            status: DistributionTargetStatusValue.Failed,
          }),
        ],
      })
    );

    expect(mapped.adoptionLoaded).toBe(true);
    expect(mapped.installedCount).toBe(1);
    expect(mapped.failedCount).toBe(1);
  });
});

describe("toDistributedPackRowsFromDistributions", () => {
  it("emits one row per distribution when a catalog item has multiple", () => {
    // The schema has no (organizationId, catalogItemId) uniqueness constraint,
    // so one catalog item can carry more than one active distribution. Folding
    // to the first per catalog id would silently drop the rest — every
    // distribution must get its own row (keyed by distribution id).
    const catalogById = new Map([
      ["pack-1", makeCatalogItem({ id: "pack-1" })],
    ]);
    const rows = toDistributedPackRowsFromDistributions(
      [
        makeDistribution({ id: "dist-a", catalogItemId: "pack-1" }),
        makeDistribution({ id: "dist-b", catalogItemId: "pack-1" }),
      ],
      catalogById
    );

    expect(rows.map((r) => r.id)).toEqual(["dist-a", "dist-b"]);
    expect(rows.every((r) => r.catalogItemId === "pack-1")).toBe(true);
  });

  it("skips a distribution whose catalog item isn't in the lookup", () => {
    const rows = toDistributedPackRowsFromDistributions(
      [makeDistribution({ id: "orphan", catalogItemId: "missing" })],
      new Map()
    );

    expect(rows).toEqual([]);
  });
});

function makeDistribution(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "pack-1",
    catalogItem: {
      id: "pack-1",
      name: "Content Pack",
      targetKind: "pack",
      source: CatalogItemSource.OrgCustom,
    },
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTargetStatus(
  overrides: Partial<DistributionTargetStatusDto> = {}
): DistributionTargetStatusDto {
  return {
    id: "ts-1",
    distributionId: "dist-1",
    computeTargetId: "ct-1",
    userId: null,
    status: DistributionTargetStatusValue.Installed,
    installedVersion: "1.0.0",
    installRunId: null,
    overriddenLocally: false,
    failureReason: null,
    installedAt: "2026-07-01T00:00:00.000Z",
    enabledAt: null,
    reportedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCatalogItem(
  overrides: Partial<CatalogItemDto> = {}
): CatalogItemDto {
  return {
    id: "pack-1",
    organizationId: "org-1",
    targetKind: "pack",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Content Pack",
    description: "Catalog content pack",
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    parentPackId: null,
    componentUuid: null,
    content: null,
    components: [],
    agentSlug: null,
    logoUrl: null,
    createdById: "user-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}
