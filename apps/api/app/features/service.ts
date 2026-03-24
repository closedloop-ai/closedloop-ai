import type {
  CreateFeatureInput,
  FeatureWithWorkstream,
  FindFeaturesOptions,
  UpdateFeatureInput,
} from "@repo/api/src/types/feature";
import type { BasicUser } from "@repo/api/src/types/user";
import { EntityType, type FeatureStatus, type Priority, withDb } from "@repo/database";
import {
  generateSlug as generateTypedSlug,
  SlugPrefix,
} from "@/lib/slug-generator";
import { featureIncludeWithContext } from "./feature-utils";

export const featuresService = {
  async findAll(
    options: FindFeaturesOptions & { organizationId: string }
  ): Promise<FeatureWithWorkstream[]> {
    const {
      organizationId,
      workstreamId,
      projectId,
      status,
      priority,
      assigneeId,
    } = options;

    const features = await withDb((db) =>
      db.feature.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(status ? { status } : {}),
          ...(priority ? { priority } : {}),
          ...(assigneeId ? { assigneeId } : {}),
        },
        include: featureIncludeWithContext,
        orderBy: { createdAt: "desc" },
      })
    );

    return features.map(toFeatureWithWorkstream);
  },

  async findById(
    id: string,
    organizationId: string
  ): Promise<FeatureWithWorkstream | null> {
    const feature = await withDb((db) =>
      db.feature.findFirst({
        where: { id, organizationId },
        include: featureIncludeWithContext,
      })
    );

    if (!feature) {
      return null;
    }

    return toFeatureWithWorkstream(feature);
  },

  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<FeatureWithWorkstream | null> {
    const feature = await withDb((db) =>
      db.feature.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        include: featureIncludeWithContext,
      })
    );

    if (!feature) {
      return null;
    }

    return toFeatureWithWorkstream(feature);
  },

  async create(
    organizationId: string,
    userId: string,
    input: CreateFeatureInput
  ): Promise<FeatureWithWorkstream> {
    const slug = await generateTypedSlug(organizationId, SlugPrefix.Feature);

    const feature = await withDb((db) =>
      db.feature.create({
        data: {
          ...input,
          organizationId,
          slug,
          createdById: userId,
        },
        include: featureIncludeWithContext,
      })
    );

    return toFeatureWithWorkstream(feature);
  },

  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateFeatureInput, "id">
  ): Promise<FeatureWithWorkstream> {
    const feature = await withDb((db) =>
      db.feature.update({
        where: { id, organizationId },
        data: input,
        include: featureIncludeWithContext,
      })
    );

    return toFeatureWithWorkstream(feature);
  },

  /**
   * Public metadata lookup by slug. Returns only title and status.
   * No org scoping — used by OG metadata for link previews.
   *
   * Note: queries slug without organizationId so the composite unique index
   * (organizationId, slug) won't be used (seq scan). Fine for now — this is
   * low-traffic (link unfurling only). When we move to org-scoped URLs the
   * caller will have organizationId and the existing index kicks in.
   */
  findMetaBySlug(
    slug: string
  ): Promise<{ title: string; status: string } | null> {
    return withDb((db) =>
      db.feature.findFirst({
        where: { slug },
        select: { title: true, status: true },
      })
    );
  },

  async delete(id: string, organizationId: string): Promise<void> {
    await withDb.tx(async (tx) => {
      await tx.entityLink.deleteMany({
        where: {
          organizationId,
          OR: [
            { sourceId: id, sourceType: EntityType.FEATURE },
            { targetId: id, targetType: EntityType.FEATURE },
          ],
        },
      });
      await tx.feature.delete({ where: { id, organizationId } });
    });
  },
};

// Type for raw Prisma result before transformation
type RawFeatureWithContext = {
  id: string;
  organizationId: string;
  workstreamId: string | null;
  projectId: string;
  title: string;
  slug: string;
  description: string | null;
  status: FeatureStatus;
  priority: Priority;
  assigneeId: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  workstream: { id: string; title: string; state: string } | null;
  project: {
    id: string;
    organizationId: string;
    name: string;
    teams: { team: { id: string; name: string } }[];
  } | null;
  assignee: BasicUser | null;
  createdBy: BasicUser | null;
};

function toFeatureWithWorkstream(
  raw: RawFeatureWithContext
): FeatureWithWorkstream {
  return {
    ...raw,
    project: raw.project
      ? {
          id: raw.project.id,
          name: raw.project.name,
          teams: raw.project.teams.map((pt) => pt.team),
        }
      : null,
  };
}
