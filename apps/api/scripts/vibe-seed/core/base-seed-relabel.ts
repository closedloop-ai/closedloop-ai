import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  type ArtifactStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { deterministicUuid } from "@repo/database/scripts/seed/helpers";
import { refreshPeopleDisplayValuesForUser } from "@/app/custom-fields/people-display-refresh";
import { documentService } from "@/app/documents/document-service";
import { generateArtifactSlug, generateSlug } from "@/lib/slug-generator";
import type { VibeSeedContext } from "../stage";
import { relabelBaseSeedComments } from "./base-seed-comments";
import {
  CUSTOM_FIELD_TEXTS,
  DOCUMENT_BODIES,
  TEMPLATE_TITLES,
} from "./base-seed-labels";
import { findPlacedDocuments } from "./base-seed-placed";
import {
  type PlannedDocument,
  type PlannedProject,
  planBaseSeedContent,
  type SeedRoster,
} from "./base-seed-plan";
import { loadSeedRoster } from "./base-seed-roster";
import { resolveHomeTeamId } from "./org-setup";
import { VIBE_SEED_ORGANIZATION } from "./seed-identity";

/**
 * ISS-12056 (Seed quality), ISS-12135 (bugs 15, 23): turns the base seed's
 * generated projects and documents into a team's real-looking work. Every
 * project, PRD, plan, doc and issue lands where `base-seed-plan.ts` puts it,
 * with its author, owner, status, priority and dates; documents the base seed
 * did not write are created through `documentService.create` (POST
 * /documents). Slugs are minted through the product's counters in creation
 * order, so PRD-1 is the oldest PRD. Projects are found by the base seed's own
 * row ids and documents already placed by their planned title, so a rerun
 * (`--skip-base`) after a run that stopped part way finishes the job without
 * placing anything twice.
 *
 * Dates, authors and statuses are direct writes: no product writer takes a
 * past timestamp or an author other than the caller.
 */

const BASE_DOCUMENT_NAME =
  /^(Seed Document|Seed Feature|Scaled Seed Document)\b/;
const SCALED_DOCUMENT_NAME = /^Scaled Seed Document (\d+)$/;
const TEMPLATE_NAME = /^Seed Template \((\w+)\)$/;
const PROJECT_SLUG = /^PRO-\d+$/;
const BASE_SEED_DOCUMENT_BODY = "Synthetic seed content for development";
const BASE_NAME_PREFIXES = [
  "Seed Document (",
  "Seed Feature (",
  "Scaled Seed Document ",
] as const;

/** Templates predate the work written from them. */
const TEMPLATE_AGE_DAYS = 70;
const DAY_MS = 24 * 60 * 60 * 1000;

const HOME_TEAM = { name: "Product Engineering", slug: "product-engineering" };
const BASE_SEED_SLACK_TEAM = "Seed Workspace";

type BaseDocumentRow = {
  readonly id: string;
  readonly name: string;
  readonly subtype: string | null;
};

export async function relabelBaseSeedContent(
  context: VibeSeedContext
): Promise<void> {
  const roster = await loadSeedRoster(context);
  const plan = planBaseSeedContent(roster, context.now);
  const pending = await findBaseDocuments(context);
  const alreadyPlaced = await findPlacedDocuments(context, plan.documents);
  let placedNow = 0;
  if (pending.length > 0 || alreadyPlaced.size < plan.documents.length) {
    const projectIds = await relabelProjects(context, plan.projects);
    await relabelTemplates(context, roster);
    placedNow = await placeDocuments(context, {
      planned: plan.documents,
      alreadyPlaced: new Set(alreadyPlaced.values()),
      projectIds,
      baseRows: pending,
    });
  }
  const documents =
    placedNow > 0
      ? await findPlacedDocuments(context, plan.documents)
      : alreadyPlaced;
  const comments = await relabelBaseSeedComments(context, roster, documents);
  await relabelOrgDetails(context);
  context.log(
    `placed ${placedNow} document(s) (${documents.size} of ${plan.documents.length} in place), ${comments} comment(s)`
  );
}

async function findBaseDocuments(
  context: VibeSeedContext
): Promise<BaseDocumentRow[]> {
  const rows = await context.prisma.artifact.findMany({
    where: {
      organizationId: context.organizationId,
      type: ArtifactType.Document,
      subtype: { not: DocumentType.Template },
      OR: BASE_NAME_PREFIXES.map((prefix) => ({
        name: { startsWith: prefix },
      })),
    },
    select: { id: true, name: true, subtype: true },
  });
  return rows
    .filter((row) => BASE_DOCUMENT_NAME.test(row.name))
    .sort(compareBaseDocuments);
}

/** One-per-status rows first by name, then scaled rows by their number. */
function compareBaseDocuments(
  left: BaseDocumentRow,
  right: BaseDocumentRow
): number {
  const leftIndex = Number(SCALED_DOCUMENT_NAME.exec(left.name)?.[1] ?? -1);
  const rightIndex = Number(SCALED_DOCUMENT_NAME.exec(right.name)?.[1] ?? -1);
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/**
 * Returns each planned project's id, by its position in the plan. A project
 * that already carries a PRO- slug keeps it, so a rerun mints nothing.
 */
async function relabelProjects(
  context: VibeSeedContext,
  projects: readonly PlannedProject[]
): Promise<string[]> {
  const { prisma, organizationId } = context;
  const ids = projects.map((project) =>
    deterministicUuid(`project:${organizationId}:${project.baseKey}`)
  );
  const rows = await prisma.project.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, slug: true },
  });
  const slugById = new Map(rows.map((row) => [row.id, row.slug]));
  const missing = projects.filter((_project, index) => {
    const id = ids[index];
    return !(id && slugById.has(id));
  });
  if (missing.length > 0) {
    throw new Error(
      `base seed project(s) ${missing.map((project) => `"${project.baseKey}"`).join(", ")} missing; the plan cannot place their work`
    );
  }
  const order = projects
    .map((project, index) => ({ project, index }))
    .sort(
      (left, right) =>
        left.project.createdAt.getTime() - right.project.createdAt.getTime() ||
        left.index - right.index
    );
  for (const { project, index } of order) {
    const id = ids[index] ?? "";
    const slug = slugById.get(id) ?? "";
    await prisma.project.update({
      where: { id },
      data: {
        name: project.name,
        description: project.description,
        priority: project.priority,
        status: project.status,
        assigneeId: project.leadId,
        createdById: project.leadId,
        slug: PROJECT_SLUG.test(slug)
          ? slug
          : await generateSlug(organizationId, SlugPrefix.Project),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      select: { id: true },
    });
  }
  return ids;
}

/** Templates are organization-level, so they leave the projects they were dealt into. */
async function relabelTemplates(
  context: VibeSeedContext,
  roster: SeedRoster
): Promise<void> {
  const { prisma, organizationId } = context;
  const rows = await prisma.artifact.findMany({
    where: {
      organizationId,
      type: ArtifactType.Document,
      name: { startsWith: "Seed Template (" },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  const author = roster.pms[0] ?? roster.admin;
  const createdAt = new Date(
    context.now.getTime() - TEMPLATE_AGE_DAYS * DAY_MS
  );
  for (const row of rows) {
    const templateFor = TEMPLATE_NAME.exec(row.name)?.[1];
    const title = templateFor ? TEMPLATE_TITLES[templateFor] : undefined;
    if (!title) {
      throw new Error(
        `no replacement title for base seed template "${row.name}"`
      );
    }
    await prisma.artifact.update({
      where: { id: row.id },
      data: {
        name: title,
        projectId: null,
        slug: await generateArtifactSlug(organizationId, DocumentType.Template),
        createdById: author,
        assigneeId: null,
        createdAt,
        updatedAt: createdAt,
      },
      select: { id: true },
    });
    await rewriteVersion(context, row.id, title, DocumentType.Template, {
      createdById: author,
      createdAt,
    });
  }
}

type Placement = {
  readonly planned: readonly PlannedDocument[];
  readonly alreadyPlaced: ReadonlySet<PlannedDocument>;
  readonly projectIds: readonly string[];
  readonly baseRows: readonly BaseDocumentRow[];
};

/**
 * Walks the plan oldest first, so slugs number in creation order. A planned
 * document not yet in place takes the next base seed row of its subtype, or is
 * created when the base seed wrote too few; a base row the plan has no place
 * for is an error, because it would land in no project the reader can make
 * sense of. Returns how many documents it placed.
 */
async function placeDocuments(
  context: VibeSeedContext,
  { planned, alreadyPlaced, projectIds, baseRows }: Placement
): Promise<number> {
  const pools = new Map<string, BaseDocumentRow[]>();
  for (const row of baseRows) {
    const pool = pools.get(row.subtype ?? "") ?? [];
    pool.push(row);
    pools.set(row.subtype ?? "", pool);
  }
  let placed = 0;
  const ordered = planned
    .filter((document) => !alreadyPlaced.has(document))
    .sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
    );
  for (const document of ordered) {
    const projectId = projectIds[document.projectIndex];
    if (!projectId) {
      throw new Error(`no project for planned document "${document.title}"`);
    }
    const row = pools.get(document.subtype)?.shift();
    if (row) {
      await relabelDocument(context, row.id, document, projectId);
    } else {
      await createDocument(context, document, projectId);
    }
    placed += 1;
  }
  const leftover = [...pools.values()].flat();
  if (leftover.length > 0) {
    throw new Error(
      `the plan has no place for ${leftover.length} base seed document(s), e.g. "${leftover[0]?.name}" (${leftover[0]?.subtype}); add topics to base-seed-catalog.ts`
    );
  }
  return placed;
}

async function relabelDocument(
  context: VibeSeedContext,
  id: string,
  document: PlannedDocument,
  projectId: string
): Promise<void> {
  await context.prisma.artifact.update({
    where: { id },
    data: {
      name: document.title,
      slug: await generateArtifactSlug(
        context.organizationId,
        document.subtype
      ),
      projectId,
      ...plannedFields(document),
    },
    select: { id: true },
  });
  await rewriteVersion(context, id, document.title, document.subtype, document);
}

async function createDocument(
  context: VibeSeedContext,
  document: PlannedDocument,
  projectId: string
): Promise<void> {
  const created = await documentService.create(
    context.organizationId,
    document.createdById,
    {
      type: document.subtype,
      projectId,
      title: document.title,
      content: versionContent(document.title, document.subtype),
      assigneeId: document.assigneeId,
      status: initialStatus(document),
      priority: document.priority,
    }
  );
  if (!created) {
    throw new Error(`creating ${document.subtype} "${document.title}" failed`);
  }
  await context.prisma.artifact.update({
    where: { id: created.id },
    data: plannedFields(document),
    select: { id: true },
  });
  await context.prisma.documentVersion.updateMany({
    where: { documentId: created.id },
    data: {
      createdById: document.createdById,
      createdAt: document.createdAt,
    },
  });
}

/**
 * The status a document starts at: `document-activity` replays the rest of
 * its history through the product's edit path, so the activity feed shows how
 * it got to where it is.
 */
export function initialStatus(document: PlannedDocument): ArtifactStatus {
  return document.history[0] ?? document.status;
}

function plannedFields(document: PlannedDocument) {
  return {
    status: initialStatus(document),
    priority: document.priority,
    createdById: document.createdById,
    assigneeId: document.assigneeId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

async function rewriteVersion(
  context: VibeSeedContext,
  documentId: string,
  title: string,
  subtype: string,
  authorship: { createdById: string; createdAt: Date }
): Promise<void> {
  await context.prisma.documentVersion.updateMany({
    where: { documentId, content: { contains: BASE_SEED_DOCUMENT_BODY } },
    data: { content: versionContent(title, subtype) },
  });
  await context.prisma.documentVersion.updateMany({
    where: { documentId },
    data: {
      createdById: authorship.createdById,
      createdAt: authorship.createdAt,
    },
  });
}

function versionContent(title: string, subtype: string): string {
  return `# ${title}\n\n${DOCUMENT_BODIES[subtype] ?? ""}`;
}

/** The home team, Slack workspace and custom field values. */
async function relabelOrgDetails(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId } = context;
  const teamId = await resolveHomeTeamId(context);
  await prisma.team.updateMany({
    where: { id: teamId, organizationId, slug: "default" },
    data: HOME_TEAM,
  });
  await prisma.slackIntegration.updateMany({
    where: { organizationId, teamName: BASE_SEED_SLACK_TEAM },
    data: { teamName: VIBE_SEED_ORGANIZATION.name },
  });
  for (const [from, to] of Object.entries(CUSTOM_FIELD_TEXTS)) {
    await prisma.customFieldValue.updateMany({
      where: { organizationId, textValue: from },
      data: { textValue: to, displayValue: to },
    });
  }
  // The base seed writes the PEOPLE value's cached display name by hand; the
  // product's refresh recomputes it from the owner's current name.
  await refreshPeopleDisplayValuesForUser(context.userId, organizationId);
}
