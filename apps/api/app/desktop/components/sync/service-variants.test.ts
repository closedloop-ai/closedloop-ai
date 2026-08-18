/**
 * @file service-variants.test.ts
 * @description ISS-4662 (item 1) — cloud ingest for the RETAINED
 * per-content-hash variants (ISS-4564) the desktop now ships on
 * `SyncedComponent.variants[]`.
 *
 * The sibling `service.test.ts` covers the primary component/version lane; this
 * file covers ONLY the additive variant lane and its version-skew matrix, so
 * neither file drifts toward the file-size ceiling.
 *
 * The skew matrix is the point: this field crosses a repo boundary, so it must
 * behave for a NEW desktop (variants present), an OLD desktop (key omitted), and
 * a NEWER desktop than this cloud (unknown key inside a variant).
 */
import { Status } from "@repo/api/src/types/result";
import { SyncedComponentVariantsTruncatedReason } from "@repo/api/src/types/synced-component-content";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findOwnedById: vi.fn(),
  upsert: vi.fn(),
  versionUpsert: vi.fn(),
  versionUpdate: vi.fn(),
  versionCreateMany: vi.fn(),
  versionUpdateMany: vi.fn(),
  registerDefinitionVersion: vi.fn(),
  relinkActiveForComputeTarget: vi.fn(),
  componentFindMany: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  indexManyAfterCommit: vi.fn(),
  removeManyAfterCommit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  SourceAccessState: { accessible: "accessible", inaccessible: "inaccessible" },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: mocks.findOwnedById },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: mocks.logInfo, warn: mocks.logWarn },
}));

vi.mock("@/app/agent-sessions/service/component-invocations", () => ({
  agentComponentInvocationsService: {
    relinkActiveForComputeTarget: mocks.relinkActiveForComputeTarget,
  },
}));

vi.mock("@/app/definition-registry/service", () => ({
  registerDefinitionVersion: mocks.registerDefinitionVersion,
}));

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      indexManyAfterCommit: mocks.indexManyAfterCommit,
      removeManyAfterCommit: mocks.removeManyAfterCommit,
    },
  };
});

import { desktopComponentsSyncService } from "./service";

const ORG_ID = "org-variants-1";
const USER_ID = "user-variants-1";
const CLERK_USER_ID = "clerk-variants-1";
const COMPUTE_TARGET_ID = "target-variants-1";

function buildComponent(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "agent::reviewer",
    componentKind: "agent",
    harness: "claude",
    name: "Reviewer",
    componentKey: "reviewer",
    version: null,
    description: null,
    sourceUrl: null,
    installPath: "/home/u/.claude/agents/reviewer.md",
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    content: "PRIMARY BODY",
    contentHash: "hash-primary",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-10T00:00:00.000Z",
    uninstalledAt: null,
    ...overrides,
  };
}

function buildInput(components: Record<string, unknown>[]) {
  return {
    clerkUserId: CLERK_USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    organizationId: ORG_ID,
    payload: {
      schemaVersion: 1 as const,
      batchId: "22222222-2222-4222-8222-222222222222",
      syncMode: "incremental" as const,
      componentCount: components.length,
      components,
    } as never,
    userId: USER_ID,
    isOrgPolicyEnabled: async () => true,
  };
}

function installOwnedTarget() {
  mocks.findOwnedById.mockResolvedValue({ id: COMPUTE_TARGET_ID });
  mocks.upsert.mockImplementation((args: { create: Record<string, unknown> }) =>
    Promise.resolve({
      id: "ac-1",
      organizationId: ORG_ID,
      componentKind: args.create.componentKind,
      externalComponentId: args.create.externalComponentId,
      name: args.create.name ?? null,
      componentKey: args.create.componentKey ?? null,
      description: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      uninstalledAt: null,
      contentHash: args.create.contentHash ?? null,
    })
  );
  mocks.versionUpsert.mockResolvedValue({});
  mocks.versionUpdate.mockResolvedValue({});
  mocks.versionCreateMany.mockResolvedValue({ count: 0 });
  mocks.versionUpdateMany.mockResolvedValue({ count: 0 });
  mocks.registerDefinitionVersion.mockResolvedValue("definition-version-1");
  mocks.relinkActiveForComputeTarget.mockResolvedValue(0);
  mocks.componentFindMany.mockResolvedValue([]);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      agentComponent: {
        findMany: mocks.componentFindMany,
        upsert: mocks.upsert,
      },
      agentComponentVersion: {
        upsert: mocks.versionUpsert,
        update: mocks.versionUpdate,
        createMany: mocks.versionCreateMany,
        updateMany: mocks.versionUpdateMany,
      },
    })
  );
}

/**
 * Every content hash the service wrote a version row for, primary first.
 *
 * ISS-4662: the PRIMARY still goes through `upsert` (it also drives the F1
 * DefinitionVersion registration), while VARIANTS are written set-based through
 * one `createMany` for the whole batch — so a variant hash is read off the
 * createMany payload, not off a per-variant upsert call.
 */
function writtenVersionHashes(): string[] {
  const primary = mocks.versionUpsert.mock.calls.map(
    (call) =>
      call[0].where.organizationId_componentKind_componentKey_source_contentHash
        .contentHash
  );
  return [...primary, ...variantRows().map((row) => row.contentHash)];
}

/** The variant rows handed to the single batch `createMany`, in order. */
function variantRows(): Record<string, string>[] {
  return mocks.versionCreateMany.mock.calls.flatMap(
    (call) => call[0].data as Record<string, string>[]
  );
}

describe("desktopComponentsSyncService.sync — ISS-4662 retained variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installOwnedTarget();
  });

  it("writes one version row per retained variant alongside the primary", async () => {
    const result = await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [
            {
              contentHash: "hash-project",
              content: "PROJECT BODY",
              format: "md",
              firstSeenAt: "2026-01-03T00:00:00.000Z",
              lastSeenAt: "2026-01-09T00:00:00.000Z",
            },
          ],
        }),
      ])
    );

    expect(result.ok).toBe(true);
    expect(writtenVersionHashes()).toEqual(["hash-primary", "hash-project"]);
  });

  it("keys the variant row on the SAME version identity as the primary, differing only by content hash", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [{ contentHash: "hash-project", content: "PROJECT BODY" }],
        }),
      ])
    );

    const [variantRow] = variantRows();
    expect(variantRow).toMatchObject({
      // org comes from the authenticated caller, never the payload
      organizationId: ORG_ID,
      componentKind: "agent",
      componentKey: "reviewer",
      // the "" source sentinel the desktop collector's version identity uses
      source: "",
      contentHash: "hash-project",
      content: "PROJECT BODY",
    });
    // skipDuplicates makes the batch insert an ON CONFLICT DO NOTHING, so a
    // revision the cloud already has is never rewritten.
    expect(mocks.versionCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it("does not register a DefinitionVersion for a variant (its provenance belongs to the primary's file)", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [{ contentHash: "hash-project", content: "PROJECT BODY" }],
        }),
      ])
    );

    // Exactly one F1 registry write — the primary's. Stamping a variant with the
    // primary's installPath/accessState would be fabricated source evidence.
    expect(mocks.registerDefinitionVersion).toHaveBeenCalledTimes(1);
    expect(mocks.registerDefinitionVersion.mock.calls[0][1].content).toBe(
      "PRIMARY BODY"
    );
  });

  it("falls back to the component-level inferred format when a variant omits its own", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          componentKind: "mcp",
          installPath: "/home/u/.claude/mcp/thing.json",
          variants: [{ contentHash: "hash-b", content: "{}" }],
        }),
      ])
    );

    // Never null (which the read path silently renders as Markdown) and never a
    // fabricated value — the existing shared inferComponentFormat SSOT.
    expect(variantRows()[0]?.format).toBe("json");
  });

  it("skips a variant whose hash equals the primary's instead of re-upserting it", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [{ contentHash: "hash-primary", content: "PRIMARY BODY" }],
        }),
      ])
    );

    expect(writtenVersionHashes()).toEqual(["hash-primary"]);
  });

  it("writes retained variants even when the primary display row carries no content", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          content: null,
          contentHash: null,
          variants: [{ contentHash: "hash-only", content: "ONLY BODY" }],
        }),
      ])
    );

    // The primary version upsert is gated on content/contentHash, so the variant
    // must not be gated behind it — otherwise these bytes are lost entirely.
    expect(writtenVersionHashes()).toEqual(["hash-only"]);
  });

  // -------------------------------------------------------------------------
  // Version skew
  // -------------------------------------------------------------------------

  it("OLD desktop: a payload that omits `variants` writes exactly the one primary version row", async () => {
    const component = buildComponent();
    expect(Object.hasOwn(component, "variants")).toBe(false);

    const result = await desktopComponentsSyncService.sync(
      buildInput([component])
    );

    expect(result.ok).toBe(true);
    expect(writtenVersionHashes()).toEqual(["hash-primary"]);
  });

  it("degrades an explicitly empty or null `variants` to the old behaviour rather than failing", async () => {
    for (const variants of [[], null, undefined]) {
      vi.clearAllMocks();
      installOwnedTarget();
      const result = await desktopComponentsSyncService.sync(
        buildInput([buildComponent({ variants })])
      );
      expect(result.ok).toBe(true);
      expect(writtenVersionHashes()).toEqual(["hash-primary"]);
    }
  });

  it("NEWER desktop: an unknown extra field on a variant never drops the component", async () => {
    const result = await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [
            {
              contentHash: "hash-project",
              content: "PROJECT BODY",
              // A field a future desktop starts sending that this cloud does not
              // know. It must be ignored, not reject the unit.
              somethingNewer: "from-the-future",
            },
          ],
        }),
      ])
    );

    expect(result.ok).toBe(true);
    expect(writtenVersionHashes()).toEqual(["hash-primary", "hash-project"]);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("still gates variants behind the ownership check (no write on an unowned target)", async () => {
    mocks.findOwnedById.mockResolvedValue(null);

    const result = await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [{ contentHash: "hash-project", content: "PROJECT BODY" }],
        }),
      ])
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(Status.Forbidden);
    }
    expect(mocks.versionUpsert).not.toHaveBeenCalled();
    expect(mocks.versionCreateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Review follow-ups (#4295)
  // -------------------------------------------------------------------------

  it("writes a whole batch's variants in ONE set-based insert, not one round trip each", async () => {
    const components = Array.from({ length: 20 }, (_, i) =>
      buildComponent({
        externalId: `agent::a-${i}`,
        componentKey: `a-${i}`,
        contentHash: `hash-primary-${i}`,
        variants: [
          { contentHash: `hash-v1-${i}`, content: "V1" },
          { contentHash: `hash-v2-${i}`, content: "V2" },
        ],
      })
    );

    await desktopComponentsSyncService.sync(buildInput(components));

    // 20 components x 2 variants = 40 rows, but exactly ONE insert. The per-request
    // limiter bounds connections, not total database work, so a per-variant upsert
    // loop was a self-inflicted load multiplier (wongk, #4295).
    expect(mocks.versionCreateMany).toHaveBeenCalledTimes(1);
    expect(variantRows()).toHaveLength(40);
  });

  it("widens an existing version window monotonically instead of moving it backward", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variants: [
            {
              contentHash: "hash-project",
              content: "PROJECT BODY",
              firstSeenAt: "2026-01-03T00:00:00.000Z",
              lastSeenAt: "2026-01-09T00:00:00.000Z",
            },
          ],
        }),
      ])
    );

    // Version identity is org-global, so an older retained observation from one
    // desktop must never overwrite a newer one already recorded from another.
    const guards = mocks.versionUpdateMany.mock.calls.map(
      (call) => call[0].where
    );
    expect(guards.some((where) => where.firstSeenAt?.gt !== undefined)).toBe(
      true
    );
    expect(guards.some((where) => where.lastSeenAt?.lt !== undefined)).toBe(
      true
    );
    for (const where of guards) {
      expect(where.OR.length).toBeGreaterThan(0);
      for (const identity of where.OR) {
        expect(identity).toMatchObject({
          organizationId: ORG_ID,
          componentKind: "agent",
          source: "",
        });
      }
    }
  });

  it("seeds the PRIMARY version row from the desktop's per-revision first-observation", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          contentFirstSeenAt: "2026-01-04T00:00:00.000Z",
          lastSeenAt: "2026-01-10T00:00:00.000Z",
        }),
      ])
    );

    // Both lanes must mean the same thing by firstSeenAt. Seeding the primary
    // from lastSeenAt (the sync at which the hash surfaced) while variants carry
    // their true local dates made the same two revisions order differently on
    // web than on Desktop (closedloop-ai-stage, #4295).
    expect(mocks.versionUpsert.mock.calls[0][0].create.firstSeenAt).toEqual(
      new Date("2026-01-04T00:00:00.000Z")
    );
  });

  it("OLD desktop: falls back to the previous lastSeenAt seeding when contentFirstSeenAt is absent", async () => {
    const component = buildComponent();
    expect(Object.hasOwn(component, "contentFirstSeenAt")).toBe(false);

    await desktopComponentsSyncService.sync(buildInput([component]));

    expect(mocks.versionUpsert.mock.calls[0][0].create.firstSeenAt).toEqual(
      new Date("2026-01-10T00:00:00.000Z")
    );
  });
});

describe("desktopComponentsSyncService.sync — ISS-5029 variantsTruncated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installOwnedTarget();
  });

  it("persists the marker AND its cap reason on BOTH create and update", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variantsTruncated: true,
          variantsTruncatedReason:
            SyncedComponentVariantsTruncatedReason.FamilyCap,
        }),
      ])
    );

    const args = mocks.upsert.mock.calls[0][0];
    expect(args.create.variantsTruncated).toBe(true);
    expect(args.create.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.FamilyCap
    );
    // The update branch matters most: an existing row that starts truncating
    // must begin saying so on the very next sync, not only on first insert.
    expect(args.update.variantsTruncated).toBe(true);
    expect(args.update.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.FamilyCap
    );
  });

  it("stores an unrecognized cap reason VERBATIM rather than dropping it", async () => {
    // Forward-compat storage: a reason a newer desktop introduces survives until
    // this side learns it. The READER is what maps unknown to "no proof".
    await desktopComponentsSyncService.sync(
      buildInput([
        buildComponent({
          variantsTruncated: true,
          variantsTruncatedReason: "some_future_cap",
        }),
      ])
    );

    const args = mocks.upsert.mock.calls[0][0];
    expect(args.update.variantsTruncatedReason).toBe("some_future_cap");
  });

  it("an explicit false CLEARS the stored claim and its reason", async () => {
    await desktopComponentsSyncService.sync(
      buildInput([buildComponent({ variantsTruncated: false })])
    );

    const args = mocks.upsert.mock.calls[0][0];
    expect(args.create.variantsTruncated).toBe(false);
    // NOT `undefined` (a Prisma no-op): a marker-aware packer stating it dropped
    // nothing is a real claim, and a component whose history fell back under the
    // cap would otherwise keep claiming truncation forever.
    expect(args.update.variantsTruncated).toBe(false);
    expect(args.update.variantsTruncatedReason).toBeNull();
  });

  it("OLD desktop: an omitted marker is a Prisma NO-OP, so it cannot clear a peer device's stored true", async () => {
    // wongk, #4391. Folding absent to `false` (the first cut) let a desktop that
    // predates the marker overwrite a `true` an UPGRADED device on the same
    // identity had just recorded — a plain version-skew regression. Absent means
    // "no opinion", so both keys are omitted: `update` leaves the stored value
    // alone and `create` takes the column's `false` default.
    const component = buildComponent();
    expect(Object.hasOwn(component, "variantsTruncated")).toBe(false);

    const result = await desktopComponentsSyncService.sync(
      buildInput([component])
    );

    expect(result.ok).toBe(true);
    const args = mocks.upsert.mock.calls[0][0];
    expect(Object.hasOwn(args.create, "variantsTruncated")).toBe(false);
    expect(Object.hasOwn(args.update, "variantsTruncated")).toBe(false);
    expect(Object.hasOwn(args.update, "variantsTruncatedReason")).toBe(false);
  });
});
