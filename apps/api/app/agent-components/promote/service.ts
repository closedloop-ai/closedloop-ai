import "server-only";

import type { PromoteResponse } from "@repo/api/src/types/distribution";
import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { withDb } from "@repo/database";
import { deriveComponentUuid } from "@/app/catalog/component-uuid";
import { getPrismaErrorCode, getPrismaP2002Target } from "@/lib/db-utils";

/**
 * The AgentComponent fields snapshotted into the promoted CatalogItemVersion
 * content. The cloud never stores a component's raw source text (that lives on
 * the desktop), so we snapshot the discovered definition's identity + metadata
 * into an installable JSON descriptor — enough for the desktop install path to
 * materialize the component instead of receiving an empty payload.
 */
type PromoteSourceComponent = {
  id: string;
  componentKind: string;
  name: string | null;
  description: string | null;
  componentKey: string | null;
  harness: string | null;
  version: string | null;
  sourceUrl: string | null;
  installPath: string | null;
  scope: string | null;
  metadata: unknown;
};

export type PromoteInput = {
  organizationId: string;
  userId: string;
  agentComponentId: string;
  name?: string;
  description?: string;
  targetKind?: string;
  sortOrder?: number;
};

/**
 * Version-1 content payload for a promoted CatalogItem. Serialized to the
 * `CatalogItemVersion.content` text column so the item is non-empty and the
 * auto-install Distribution has something installable (FEA-2923 §J). This is a
 * stable, self-describing descriptor keyed on the promoted component's identity.
 */
export type PromotedComponentContent = {
  promotedFrom: {
    agentComponentId: string;
    componentKey: string | null;
  };
  kind: string;
  name: string;
  description: string | null;
  harness: string | null;
  version: string | null;
  sourceUrl: string | null;
  installPath: string | null;
  scope: string | null;
  metadata: unknown;
};

function buildPromotedContent(
  component: PromoteSourceComponent,
  itemName: string,
  itemDescription: string | null
): PromotedComponentContent {
  return {
    promotedFrom: {
      agentComponentId: component.id,
      componentKey: component.componentKey,
    },
    kind: component.componentKind,
    name: itemName,
    description: itemDescription,
    harness: component.harness,
    version: component.version,
    sourceUrl: component.sourceUrl,
    installPath: component.installPath,
    scope: component.scope,
    metadata: component.metadata ?? null,
  };
}

/**
 * Kinds that are observable/inventory-only and NEVER distributable via the
 * catalog (FEA-3048): built-in CLI `Tool`s (Read/Grep/Bash …) and `Config`
 * (memory & config). Their `componentKind` is surfaced for usage analytics but
 * promoting one would fabricate a CatalogItem/Distribution for a built-in the
 * desktop can neither install nor own. This is the authoritative server-side
 * guard mirroring the web `isObservedKind` exclusion — the admin-gated UI hides
 * the Promote button for these kinds, but the route must not trust the client's
 * `agentComponentId` to reference a distributable kind.
 */
const NON_PROMOTABLE_KINDS: ReadonlySet<string> = new Set(["tool", "config"]);

/**
 * Result discriminator so the route can 404 when the component is missing (or
 * belongs to another org) without leaking the difference between the two, and
 * reject an observable-only kind (`tool`/`config`) that must never be promoted.
 */
export type PromoteResult =
  | { ok: true; response: PromoteResponse }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_promotable"; kind: string };

/** The promoted CatalogItem for a source component + its org-wide auto-install
 * distribution id (null when the item exists but its AutoInstall/All
 * distribution was later removed or retargeted). */
type PromotedItem = { catalogItemId: string; distributionId: string | null };

/**
 * Idempotency lookup (FEA-3050): find the existing promotion of
 * `agentComponentId` in this org, if one exists. A promotion is an org-scoped
 * CatalogItem carrying the source component id (the partial unique index keeps
 * it at most one per org). Its org-wide AutoInstall/All Distribution is created
 * with it in one transaction; `distributionId` is null only if that
 * distribution was subsequently removed/retargeted out of band.
 */
async function findPromotedItem(
  organizationId: string,
  agentComponentId: string
): Promise<PromotedItem | null> {
  const existing = await withDb((db) =>
    db.catalogItem.findFirst({
      where: {
        organizationId,
        sourceAgentComponentId: agentComponentId,
      },
      select: {
        id: true,
        distributions: {
          where: {
            mode: DistributionMode.AutoInstall,
            targetingType: DistributionTargetingType.All,
          },
          select: { id: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    })
  );

  if (!existing) {
    return null;
  }

  return {
    catalogItemId: existing.id,
    distributionId: existing.distributions[0]?.id ?? null,
  };
}

/**
 * Resolve an existing promotion to a response. If the item still has its
 * org-wide AutoInstall/All Distribution, return it as-is; if that distribution
 * was removed/retargeted out of band, self-heal by recreating it on the
 * existing item (promote's contract is "this component auto-installs org-wide")
 * rather than creating a duplicate item or surfacing an error.
 */
async function resolvePromotion(
  promoted: PromotedItem,
  organizationId: string,
  userId: string
): Promise<PromoteResponse> {
  if (promoted.distributionId) {
    return {
      catalogItemId: promoted.catalogItemId,
      distributionId: promoted.distributionId,
    };
  }

  // Self-heal without re-opening the duplicate race the main path just closed:
  // two callers can both observe `distributionId` null here (e.g. after an admin
  // deletes the distribution) and, since there is no unique constraint on
  // distributions to catch a P2002, both would `create` a second AutoInstall/All
  // distribution on the same item. Serialize concurrent self-heals for this item
  // under a transaction-scoped advisory lock and re-check inside it so the loser
  // observes the winner's committed distribution instead of creating another
  // (mirrors the per-record lock in agent-sessions/service.ts).
  const distributionId = await withDb.tx(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`promote:distribution:${promoted.catalogItemId}`}))`;

    const current = await tx.distribution.findFirst({
      where: {
        catalogItemId: promoted.catalogItemId,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (current) {
      return current.id;
    }

    const created = await tx.distribution.create({
      data: {
        organizationId,
        catalogItemId: promoted.catalogItemId,
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
        desiredEnabled: true,
        createdById: userId,
      },
      select: { id: true },
    });
    return created.id;
  });

  return {
    catalogItemId: promoted.catalogItemId,
    distributionId,
  };
}

/**
 * True when `error` is the P2002 unique-constraint violation from the FEA-3050
 * promotion index on (organization_id, source_agent_component_id). Verifies the
 * conflict target (not just the P2002 code) so an unrelated future unique
 * constraint on these writes is never silently swallowed — handling both the
 * constraint-name string and the field/column array shapes Prisma adapters may
 * report (apps/api/AGENTS.md).
 */
function isPromotionSourceComponentUniqueError(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }

  const target = getPrismaP2002Target(error);
  if (Array.isArray(target)) {
    return target.some(
      (field) =>
        field === "sourceAgentComponentId" ||
        field === "source_agent_component_id"
    );
  }
  return (
    typeof target === "string" && target.includes("source_agent_component_id")
  );
}

/**
 * Best-of-breed promote (FEA-2923 §J): snapshot a discovered `AgentComponent`
 * into a `CatalogItem` + initial `CatalogItemVersion` (installable content) and
 * create an org-wide auto-install `Distribution` so every laptop converges on
 * the chosen best component.
 *
 * Every query is org-scoped: the source component must belong to
 * `input.organizationId`, and the created rows carry it. Creating the item,
 * version, and distribution runs in one transaction so a promotion is atomic —
 * the distribution is never persisted pointing at a contentless item.
 *
 * Idempotent (FEA-3050): a component already promoted in this org returns the
 * existing CatalogItem + AutoInstall/All Distribution instead of creating a
 * second one, so a double-click or client retry never fans out duplicate org-
 * wide distributions. A concurrent race that slips past the pre-insert check is
 * caught by the partial unique index on (organization_id,
 * source_agent_component_id) and recovered as the existing promotion.
 */
export async function promoteAgentComponent(
  input: PromoteInput
): Promise<PromoteResult> {
  const component = await withDb((db) =>
    db.agentComponent.findFirst({
      where: {
        id: input.agentComponentId,
        organizationId: input.organizationId,
      },
      select: {
        id: true,
        componentKind: true,
        name: true,
        description: true,
        componentKey: true,
        harness: true,
        version: true,
        sourceUrl: true,
        installPath: true,
        scope: true,
        metadata: true,
      },
    })
  );

  if (!component) {
    return { ok: false, reason: "not_found" };
  }

  // Reject observable-only kinds (FEA-3048): a built-in Tool/Config is not a
  // distributable component, so it must never be turned into a CatalogItem +
  // org-wide Distribution — even if an admin POSTs its id directly.
  if (NON_PROMOTABLE_KINDS.has(component.componentKind)) {
    return {
      ok: false,
      reason: "not_promotable",
      kind: component.componentKind,
    };
  }

  const existing = await findPromotedItem(
    input.organizationId,
    input.agentComponentId
  );
  if (existing) {
    return {
      ok: true,
      response: await resolvePromotion(
        existing,
        input.organizationId,
        input.userId
      ),
    };
  }

  const itemName =
    input.name ?? component.name ?? `Promoted ${component.componentKind}`;
  const itemDescription = input.description ?? component.description ?? null;
  const targetKind = input.targetKind ?? component.componentKind;
  const content = buildPromotedContent(component, itemName, itemDescription);
  // Serialize once and reuse for both the persisted version body and the
  // content-addressed identity, so the promoted item's componentUuid is derived
  // from the exact content that is stored (same shared helper as every other
  // content-bearing writer). Provenance is the discovered component's origin.
  const serializedContent = JSON.stringify(content);

  let response: PromoteResponse;
  try {
    response = await withDb.tx(async (tx) => {
      const catalogItem = await tx.catalogItem.create({
        data: {
          organizationId: input.organizationId,
          targetKind,
          source: "org_custom",
          scope: "org",
          name: itemName,
          description: itemDescription,
          sortOrder: input.sortOrder ?? 0,
          enabled: true,
          archived: false,
          createdById: input.userId,
          sourceAgentComponentId: input.agentComponentId,
          componentUuid: deriveComponentUuid({
            content: serializedContent,
            sourceRepo: component.sourceUrl,
            organizationId: input.organizationId,
          }),
        },
        select: { id: true },
      });

      // Snapshot an installable initial version so the auto-install Distribution
      // has non-null content (an empty CatalogItem would be un-installable and
      // silently skipped by the desktop / listAgentsForContextPack).
      await tx.catalogItemVersion.create({
        data: {
          catalogItemId: catalogItem.id,
          version: 1,
          name: itemName,
          content: serializedContent,
          changeNote:
            "Promoted from discovered component (FEA-2923 best-of-breed)",
          changedById: input.userId,
        },
      });

      const distribution = await tx.distribution.create({
        data: {
          organizationId: input.organizationId,
          catalogItemId: catalogItem.id,
          mode: DistributionMode.AutoInstall,
          targetingType: DistributionTargetingType.All,
          desiredEnabled: true,
          createdById: input.userId,
        },
        select: { id: true },
      });

      return {
        catalogItemId: catalogItem.id,
        distributionId: distribution.id,
      };
    });
  } catch (error) {
    // Concurrency-safe idempotency: a racing promotion that committed between
    // the pre-insert check and this transaction trips the partial unique index
    // on (organization_id, source_agent_component_id) → P2002. Recover it as the
    // existing promotion instead of surfacing a duplicate-key error to the admin.
    if (isPromotionSourceComponentUniqueError(error)) {
      const raced = await findPromotedItem(
        input.organizationId,
        input.agentComponentId
      );
      if (raced) {
        return {
          ok: true,
          response: await resolvePromotion(
            raced,
            input.organizationId,
            input.userId
          ),
        };
      }
    }
    throw error;
  }

  return { ok: true, response };
}
