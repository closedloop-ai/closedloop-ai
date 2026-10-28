import { createCatalogItem, updateCatalogItem } from "@/app/catalog/service";
import { CatalogTargetKind } from "@/app/catalog/validators";
import type { VibeSeedContext } from "../stage";
import { SEED_PACKS } from "./content";

/**
 * ISS-12017: the org's own Packs and their components, written through the
 * catalog service the Packs screen calls. `createCatalogItem` stores each
 * component's body as version 1 and `updateCatalogItem` appends version 2, the
 * POST and PATCH /catalog paths. An item that already exists is reused, and a
 * component that already has a second version is not edited again.
 */

const REVISED_VERSION_COUNT = 2;

type CatalogItemSpec = {
  readonly targetKind: string;
  readonly name: string;
  readonly description: string;
  readonly parentPackId?: string;
  readonly content?: string;
};

/** Ids of the seeded Packs, in `SEED_PACKS` order. */
export async function seedCatalogPacks(
  context: VibeSeedContext
): Promise<string[]> {
  const packIds: string[] = [];
  let components = 0;
  for (const pack of SEED_PACKS) {
    const packId = await ensureCatalogItem(context, {
      targetKind: CatalogTargetKind.Pack,
      name: pack.name,
      description: pack.description,
    });
    packIds.push(packId);
    for (const component of pack.components) {
      const componentId = await ensureCatalogItem(context, {
        targetKind: component.targetKind,
        name: component.name,
        description: component.description,
        parentPackId: packId,
        content: component.content,
      });
      await ensureRevision(context, componentId, component.revisedContent);
      components += 1;
    }
  }
  context.log(`catalog: ${packIds.length} pack(s), ${components} component(s)`);
  return packIds;
}

async function ensureCatalogItem(
  context: VibeSeedContext,
  spec: CatalogItemSpec
): Promise<string> {
  const existing = await context.prisma.catalogItem.findFirst({
    where: {
      organizationId: context.organizationId,
      targetKind: spec.targetKind,
      name: spec.name,
      parentPackId: spec.parentPackId ?? null,
      archived: false,
    },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }
  const created = await createCatalogItem({
    organizationId: context.organizationId,
    userId: context.userId,
    targetKind: spec.targetKind,
    name: spec.name,
    description: spec.description,
    ...(spec.parentPackId === undefined
      ? {}
      : { parentPackId: spec.parentPackId }),
    ...(spec.content === undefined ? {} : { content: spec.content }),
  });
  if (!created.ok) {
    throw new Error(
      `creating catalog item ${spec.name} failed with status ${created.error}`
    );
  }
  return created.value.id;
}

async function ensureRevision(
  context: VibeSeedContext,
  catalogItemId: string,
  revisedContent: string
): Promise<void> {
  const versions = await context.prisma.catalogItemVersion.count({
    where: { catalogItemId },
  });
  if (versions >= REVISED_VERSION_COUNT) {
    return;
  }
  const updated = await updateCatalogItem({
    id: catalogItemId,
    organizationId: context.organizationId,
    userId: context.userId,
    content: revisedContent,
  });
  if (!updated.ok) {
    throw new Error(
      `revising catalog item ${catalogItemId} failed with status ${updated.error}`
    );
  }
}
