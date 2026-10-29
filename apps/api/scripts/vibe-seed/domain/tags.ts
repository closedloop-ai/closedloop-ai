import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { TagEntityType } from "@repo/api/src/types/tag";
import { tagService } from "@/app/tags/service";
import type { ActivityActor } from "@/lib/artifact-activity-capture";
import type { VibeSeedContext } from "../stage";
import { SEED_TAGS } from "./content";

/**
 * ISS-12017: tags and their links, written through `tagService.create` and
 * `tagService.applyTag`, the paths `POST /tags` and the tag-artifact route
 * call. `applyTag` treats an existing link as a no-op, so a re-run adds nothing.
 */

/** How many of each entity kind carry a tag; a slice of the org, not all of it. */
const TAGGED_DOCUMENT_COUNT = 24;
const TAGGED_SESSION_COUNT = 6;
const TAGGED_PROJECT_COUNT = 6;
/**
 * ISS-12135: a document carries the tag its project's work is about, and the
 * urgent and high-priority ones also carry the launch tag, so chips match the
 * page they sit on.
 */
const DOCUMENT_TAG_BY_PROJECT: Readonly<Record<string, string>> = {
  "Billing Platform": "billing",
  "Mobile Onboarding": "onboarding",
  "Search Relevance": "performance",
  "Developer Experience": "performance",
  "Platform Foundation": "tech-debt",
  "Notifications Overhaul": "customer-reported",
  "Checkout Redesign": "q4-launch",
};
const LAUNCH_TAG = "q4-launch";
const LAUNCH_PRIORITIES: ReadonlySet<string> = new Set([
  Priority.High,
  Priority.Urgent,
]);

type TagLink = {
  readonly tagId: string;
  readonly entityType: TagEntityType;
  readonly entityId: string;
};

export async function seedTags(context: VibeSeedContext): Promise<void> {
  const tagIds = await ensureSeedTags(context);
  const links = await planTagLinks(context, tagIds);
  const actor: ActivityActor = {
    userId: context.userId,
    authMethod: "session",
  };
  for (const link of links) {
    await tagService.applyTag(
      link.tagId,
      link.entityType,
      link.entityId,
      context.organizationId,
      actor
    );
  }
  context.log(`tags: ${tagIds.length} tag(s), ${links.length} link(s)`);
}

async function ensureSeedTags(context: VibeSeedContext): Promise<string[]> {
  const ids: string[] = [];
  for (const tag of SEED_TAGS) {
    const existing = await tagService.findByExactName(
      context.organizationId,
      tag.name
    );
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await tagService.create(
      context.organizationId,
      context.userId,
      { name: tag.name, color: tag.color }
    );
    ids.push(created.id);
  }
  return ids;
}

async function planTagLinks(
  context: VibeSeedContext,
  tagIds: readonly string[]
): Promise<TagLink[]> {
  const { prisma, organizationId } = context;
  const [documents, sessions, projects] = await Promise.all([
    prisma.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.Document,
        subtype: { in: [DocumentType.Prd, DocumentType.ImplementationPlan] },
        project: { name: { in: Object.keys(DOCUMENT_TAG_BY_PROJECT) } },
      },
      orderBy: [{ slug: "asc" }, { id: "asc" }],
      take: TAGGED_DOCUMENT_COUNT,
      select: { id: true, priority: true, project: { select: { name: true } } },
    }),
    prisma.artifact.findMany({
      where: { organizationId, type: ArtifactType.Session },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: TAGGED_SESSION_COUNT,
      select: { id: true },
    }),
    prisma.project.findMany({
      where: { organizationId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: TAGGED_PROJECT_COUNT,
      select: { id: true },
    }),
  ]);
  const tagAt = (index: number) => tagIds[index % tagIds.length];
  const links: TagLink[] = documentTagLinks(documents, tagIds);
  links.push(
    ...sessions.map((session, index) => ({
      tagId: tagAt(index + 2),
      entityType: TagEntityType.Artifact,
      entityId: session.id,
    })),
    ...projects.map((project, index) => ({
      tagId: tagAt(index),
      entityType: TagEntityType.Project,
      entityId: project.id,
    }))
  );
  return links;
}

function documentTagLinks(
  documents: readonly {
    id: string;
    priority: string | null;
    project: { name: string } | null;
  }[],
  tagIds: readonly string[]
): TagLink[] {
  const idByName = new Map(
    SEED_TAGS.map((tag, index) => [tag.name, tagIds[index]])
  );
  return documents.flatMap((document) => {
    const names = [DOCUMENT_TAG_BY_PROJECT[document.project?.name ?? ""]];
    if (document.priority && LAUNCH_PRIORITIES.has(document.priority)) {
      names.push(LAUNCH_TAG);
    }
    return [...new Set(names)].flatMap((name) => {
      const tagId = name ? idByName.get(name) : undefined;
      return tagId
        ? [{ tagId, entityType: TagEntityType.Artifact, entityId: document.id }]
        : [];
    });
  });
}
