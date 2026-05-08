import { ProjectStatus } from "@repo/api/src/types/project";
import type {
  DocumentSearchResult,
  GlobalSearchResponse,
  ProjectSearchResult,
  WorkstreamSearchResult,
} from "@repo/api/src/types/search";
import { ArtifactType, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

const SEARCH_LIMIT = 25;
const SEARCH_ORDER = {
  orderBy: { updatedAt: "desc" },
  take: SEARCH_LIMIT,
} as const;

function ilike(query: string) {
  return { contains: query, mode: "insensitive" } as const;
}

export const searchService = {
  async search(
    organizationId: string,
    query: string
  ): Promise<GlobalSearchResponse> {
    const [documents, workstreams, projects] = await Promise.all([
      searchDocuments(organizationId, query),
      searchWorkstreams(organizationId, query),
      searchProjects(organizationId, query),
    ]);

    return { query, documents, workstreams, projects };
  },
};

async function searchDocuments(
  organizationId: string,
  query: string
): Promise<DocumentSearchResult[]> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.DOCUMENT,
        OR: [{ name: ilike(query) }, { slug: ilike(query) }],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        subtype: true,
        status: true,
        priority: true,
        updatedAt: true,
        assignee: basicUserSelect,
        project: { select: { name: true } },
        workstream: { select: { title: true } },
      },
      ...SEARCH_ORDER,
    })
  );

  return rows.flatMap((r) => {
    if (r.subtype === null) {
      return [];
    }
    return [
      {
        id: r.id,
        title: r.name,
        slug: r.slug ?? "",
        type: r.subtype,
        status: r.status as DocumentSearchResult["status"],
        priority: r.priority,
        projectName: r.project.name,
        workstreamTitle: r.workstream?.title ?? null,
        assignee: r.assignee,
        updatedAt: r.updatedAt,
      },
    ];
  });
}

async function searchWorkstreams(
  organizationId: string,
  query: string
): Promise<WorkstreamSearchResult[]> {
  const rows = await withDb((db) =>
    db.workstream.findMany({
      where: {
        organizationId,
        OR: [{ title: ilike(query) }, { description: ilike(query) }],
      },
      select: {
        id: true,
        title: true,
        slug: true,
        state: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
      ...SEARCH_ORDER,
    })
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    state: r.state,
    projectName: r.project?.name ?? null,
    updatedAt: r.updatedAt,
  }));
}

async function searchProjects(
  organizationId: string,
  query: string
): Promise<ProjectSearchResult[]> {
  const rows = await withDb((db) =>
    db.project.findMany({
      where: {
        organizationId,
        isTemplatesSentinel: false,
        status: { not: ProjectStatus.Archived },
        OR: [{ name: ilike(query) }, { description: ilike(query) }],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        priority: true,
        updatedAt: true,
        assignee: basicUserSelect,
        teams: {
          select: {
            team: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
      ...SEARCH_ORDER,
    })
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    priority: r.priority,
    teamName: r.teams[0]?.team.name ?? null,
    teamId: r.teams[0]?.team.id ?? null,
    assignee: r.assignee,
    updatedAt: r.updatedAt,
  }));
}
