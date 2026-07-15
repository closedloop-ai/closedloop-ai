/**
 * Unit tests for promoteAgentComponent (FEA-2923 §J best-of-breed promote).
 *
 * Prisma is fully mocked. Tests assert the runtime-correctness gap the audit
 * flagged: promote must snapshot an installable CatalogItemVersion.content so
 * the auto-install Distribution is not an empty payload. Also covers org-scoping
 * and the not-found path.
 */
import { computeComponentUuid } from "@repo/api/src/component-identity";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromotedComponentContent } from "./service";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

import { promoteAgentComponent } from "./service";

const ORG = "org-promote-1111";
const USER = "user-promote-1111";
const COMPONENT_ID = "ac-promote-uuid-1";

type CreateCall = { data: Record<string, unknown> };

function makeComponent(overrides: Record<string, unknown> = {}) {
  return {
    id: COMPONENT_ID,
    componentKind: "skill",
    name: "My Skill",
    description: "A discovered skill",
    componentKey: "my-skill",
    harness: "claude",
    version: "1.2.3",
    sourceUrl: "https://example.com/skill",
    installPath: "/home/user/.skills/my-skill",
    scope: "user",
    metadata: { foo: "bar" },
    ...overrides,
  };
}

/**
 * Wire withDb (component lookup + idempotency lookup) and withDb.tx (create
 * item/version/dist). Records every create call so tests can assert on the
 * written data. `existingPromotion` is what the FEA-3050 idempotency
 * `catalogItem.findFirst` returns (null = no prior promotion → create path).
 */
function installDb(
  component: Record<string, unknown> | null,
  existingPromotion: Record<string, unknown> | null = null
) {
  const itemCreate = vi
    .fn()
    .mockResolvedValue({ id: "catalog-item-created-1" });
  const versionCreate = vi.fn().mockResolvedValue({ id: "version-1" });
  const distributionCreate = vi
    .fn()
    .mockResolvedValue({ id: "distribution-created-1" });

  const findFirst = vi.fn().mockResolvedValue(component);
  const catalogItemFindFirst = vi.fn().mockResolvedValue(existingPromotion);
  // resolvePromotion's self-heal path re-checks for a live AutoInstall/All
  // distribution inside its lock before creating one; null = none exists yet.
  const distributionFindFirst = vi.fn().mockResolvedValue(null);
  const executeRaw = vi.fn().mockResolvedValue(1);

  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) =>
    cb({
      agentComponent: { findFirst },
      catalogItem: { findFirst: catalogItemFindFirst },
    })
  );
  mocks.withDb.tx.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({
      catalogItem: { create: itemCreate },
      catalogItemVersion: { create: versionCreate },
      // Both the main create path and the self-heal path run in a tx; the
      // self-heal path also acquires an advisory lock and re-checks first.
      distribution: {
        create: distributionCreate,
        findFirst: distributionFindFirst,
      },
      $executeRaw: executeRaw,
    })
  );

  return {
    findFirst,
    catalogItemFindFirst,
    distributionFindFirst,
    executeRaw,
    itemCreate,
    versionCreate,
    distributionCreate,
  };
}

describe("promoteAgentComponent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up the source component scoped to the calling org", async () => {
    const { findFirst } = installDb(makeComponent());

    await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      id: COMPONENT_ID,
      organizationId: ORG,
    });
  });

  it("returns not_found when the component does not belong to the org", async () => {
    installDb(null);

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an observable-only Tool kind as not_promotable (FEA-3048)", async () => {
    const { itemCreate, distributionCreate } = installDb(
      makeComponent({ componentKind: "tool" })
    );

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    // A built-in Tool must never become a CatalogItem / Distribution.
    expect(result).toEqual({
      ok: false,
      reason: "not_promotable",
      kind: "tool",
    });
    expect(itemCreate).not.toHaveBeenCalled();
    expect(distributionCreate).not.toHaveBeenCalled();
  });

  it("rejects an observable-only Config kind as not_promotable (FEA-3048)", async () => {
    const { itemCreate, distributionCreate } = installDb(
      makeComponent({ componentKind: "config" })
    );

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_promotable",
      kind: "config",
    });
    expect(itemCreate).not.toHaveBeenCalled();
    expect(distributionCreate).not.toHaveBeenCalled();
  });

  it("snapshots an installable CatalogItemVersion (non-empty content) so the auto-install distribution has something installable", async () => {
    const { versionCreate } = installDb(makeComponent());

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(result.ok).toBe(true);

    // The version MUST be created with non-null content — the whole point of
    // the fix. A null/empty content would make the distribution un-installable.
    const versionCall = versionCreate.mock.calls[0]?.[0];
    expect(versionCall).toBeDefined();
    const versionData = (versionCall as CreateCall).data;
    expect(versionData.version).toBe(1);
    expect(typeof versionData.content).toBe("string");
    expect((versionData.content as string).length).toBeGreaterThan(0);

    const content = JSON.parse(
      versionData.content as string
    ) as PromotedComponentContent;
    expect(content.kind).toBe("skill");
    expect(content.name).toBe("My Skill");
    expect(content.harness).toBe("claude");
    expect(content.version).toBe("1.2.3");
    expect(content.metadata).toEqual({ foo: "bar" });
    expect(content.promotedFrom).toEqual({
      agentComponentId: COMPONENT_ID,
      componentKey: "my-skill",
    });
  });

  // The promote path is another content-bearing CatalogItem writer, so it must
  // set the same content-addressed identity as every other writer, derived
  // through the shared deriveComponentUuid helper from the exact serialized
  // content it persists (source = the discovered component's origin url).
  it("sets componentUuid on the promoted catalog item via the shared derivation", async () => {
    const { itemCreate, versionCreate } = installDb(makeComponent());

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(result.ok).toBe(true);

    const itemCall = itemCreate.mock.calls[0]?.[0];
    const versionCall = versionCreate.mock.calls[0]?.[0];
    expect(itemCall).toBeDefined();
    expect(versionCall).toBeDefined();
    const createData = (itemCall as CreateCall).data;
    const versionData = (versionCall as CreateCall).data;
    // Derived from the SAME serialized body stored on the version row, keyed on
    // the discovered component's origin url and the promoting org.
    expect(createData.componentUuid).toBe(
      computeComponentUuid({
        source: "https://example.com/skill",
        owner: ORG,
        content: versionData.content as string,
      })
    );
  });

  it("creates the version under the created catalog item (wired to the new item id)", async () => {
    const { itemCreate, versionCreate } = installDb(makeComponent());
    itemCreate.mockResolvedValue({ id: "new-item-xyz" });

    await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    const versionCall = versionCreate.mock.calls[0]?.[0];
    expect(versionCall).toBeDefined();
    const versionData = (versionCall as CreateCall).data;
    expect(versionData.catalogItemId).toBe("new-item-xyz");
  });

  it("creates an org-wide auto-install distribution and returns both ids", async () => {
    const { itemCreate, distributionCreate } = installDb(makeComponent());
    itemCreate.mockResolvedValue({ id: "item-final" });
    distributionCreate.mockResolvedValue({ id: "dist-final" });

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    const distributionCall = distributionCreate.mock.calls[0]?.[0];
    expect(distributionCall).toBeDefined();
    const distData = (distributionCall as CreateCall).data;
    expect(distData).toMatchObject({
      organizationId: ORG,
      catalogItemId: "item-final",
      mode: "auto_install",
      targetingType: "all",
      desiredEnabled: true,
    });

    expect(result).toEqual({
      ok: true,
      response: { catalogItemId: "item-final", distributionId: "dist-final" },
    });
  });

  it("stamps the source component id on the created item so the promotion is dedup-able (FEA-3050)", async () => {
    const { itemCreate } = installDb(makeComponent());

    await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    const itemCall = itemCreate.mock.calls[0]?.[0];
    expect(itemCall).toBeDefined();
    const itemData = (itemCall as CreateCall).data;
    expect(itemData.sourceAgentComponentId).toBe(COMPONENT_ID);
  });

  it("is idempotent: returns the existing promotion without creating a duplicate (FEA-3050)", async () => {
    const { catalogItemFindFirst, itemCreate, distributionCreate } = installDb(
      makeComponent(),
      {
        id: "existing-item-1",
        distributions: [{ id: "existing-dist-1" }],
      }
    );

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    // The idempotency lookup is org-scoped on the source component id.
    expect(catalogItemFindFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      organizationId: ORG,
      sourceAgentComponentId: COMPONENT_ID,
    });
    // No second CatalogItem / Distribution is created.
    expect(itemCreate).not.toHaveBeenCalled();
    expect(distributionCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      response: {
        catalogItemId: "existing-item-1",
        distributionId: "existing-dist-1",
      },
    });
  });

  it("recovers a concurrent double-promote (P2002 on the partial unique index) as the existing promotion (FEA-3050)", async () => {
    const { catalogItemFindFirst } = installDb(makeComponent());
    // Pre-insert check sees nothing; the racing insert wins first, so our tx
    // trips the unique index; the post-race lookup then finds the winner.
    catalogItemFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "raced-item-1",
      distributions: [{ id: "raced-dist-1" }],
    });
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["organization_id", "source_agent_component_id"] },
    });
    mocks.withDb.tx.mockRejectedValueOnce(p2002);

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(result).toEqual({
      ok: true,
      response: {
        catalogItemId: "raced-item-1",
        distributionId: "raced-dist-1",
      },
    });
  });

  it("recovers the race when the P2002 target is reported as a constraint-name string (FEA-3050)", async () => {
    const { catalogItemFindFirst } = installDb(makeComponent());
    catalogItemFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "raced-item-2",
      distributions: [{ id: "raced-dist-2" }],
    });
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: {
        target: "catalog_items_organization_id_source_agent_component_id_key",
      },
    });
    mocks.withDb.tx.mockRejectedValueOnce(p2002);

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(result).toEqual({
      ok: true,
      response: {
        catalogItemId: "raced-item-2",
        distributionId: "raced-dist-2",
      },
    });
  });

  it("self-heals a promotion whose auto-install distribution was removed (FEA-3050)", async () => {
    const { itemCreate, distributionCreate, executeRaw } = installDb(
      makeComponent(),
      {
        id: "orphaned-item-1",
        distributions: [],
      }
    );
    distributionCreate.mockResolvedValue({ id: "healed-dist-1" });

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    // The self-heal serializes under a transaction advisory lock so two racing
    // callers can't each create a second AutoInstall/All distribution.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    // No duplicate item is created; the missing AutoInstall/All distribution is
    // recreated on the existing item instead of 500ing.
    expect(itemCreate).not.toHaveBeenCalled();
    const distributionCall = distributionCreate.mock.calls[0]?.[0];
    expect(distributionCall).toBeDefined();
    const healed = (distributionCall as CreateCall).data;
    expect(healed).toMatchObject({
      organizationId: ORG,
      catalogItemId: "orphaned-item-1",
      mode: "auto_install",
      targetingType: "all",
      desiredEnabled: true,
    });
    expect(result).toEqual({
      ok: true,
      response: {
        catalogItemId: "orphaned-item-1",
        distributionId: "healed-dist-1",
      },
    });
  });

  it("self-heal returns the racing winner's distribution without creating a duplicate (FEA-3050)", async () => {
    const { distributionCreate, distributionFindFirst } = installDb(
      makeComponent(),
      {
        id: "orphaned-item-2",
        distributions: [],
      }
    );
    // The pre-lock idempotency lookup saw no live distribution, but a concurrent
    // self-heal committed one before this caller took the lock; the in-lock
    // re-check observes it, so we return it instead of creating a second.
    distributionFindFirst.mockResolvedValue({ id: "winner-dist-1" });

    const result = await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
    });

    expect(distributionCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      response: {
        catalogItemId: "orphaned-item-2",
        distributionId: "winner-dist-1",
      },
    });
  });

  it("rethrows a non-P2002 transaction error", async () => {
    installDb(makeComponent());
    mocks.withDb.tx.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      promoteAgentComponent({
        organizationId: ORG,
        userId: USER,
        agentComponentId: COMPONENT_ID,
      })
    ).rejects.toThrow("connection reset");
  });

  it("rethrows a P2002 from an unrelated unique constraint instead of masking it (FEA-3050)", async () => {
    const { catalogItemFindFirst } = installDb(makeComponent());
    const unrelatedP2002 = Object.assign(
      new Error("Unique constraint failed"),
      {
        code: "P2002",
        meta: { target: ["catalog_item_id", "version"] },
      }
    );
    mocks.withDb.tx.mockRejectedValueOnce(unrelatedP2002);

    await expect(
      promoteAgentComponent({
        organizationId: ORG,
        userId: USER,
        agentComponentId: COMPONENT_ID,
      })
    ).rejects.toThrow("Unique constraint failed");
    // The recovery re-query is never consulted for an unrelated constraint.
    expect(catalogItemFindFirst).toHaveBeenCalledTimes(1);
  });

  it("honors explicit name/description/targetKind overrides in the snapshot", async () => {
    const { itemCreate, versionCreate } = installDb(makeComponent());

    await promoteAgentComponent({
      organizationId: ORG,
      userId: USER,
      agentComponentId: COMPONENT_ID,
      name: "Team Best Skill",
      description: "Curated by admin",
      targetKind: "plugin",
    });

    const itemCall = itemCreate.mock.calls[0]?.[0];
    expect(itemCall).toBeDefined();
    const itemData = (itemCall as CreateCall).data;
    expect(itemData.name).toBe("Team Best Skill");
    expect(itemData.description).toBe("Curated by admin");
    expect(itemData.targetKind).toBe("plugin");

    const versionCall = versionCreate.mock.calls[0]?.[0];
    expect(versionCall).toBeDefined();
    const content = JSON.parse(
      (versionCall as CreateCall).data.content as string
    ) as PromotedComponentContent;
    expect(content.name).toBe("Team Best Skill");
    expect(content.description).toBe("Curated by admin");
  });
});
