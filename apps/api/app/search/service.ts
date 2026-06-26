import { ProjectStatus } from "@repo/api/src/types/project";
import type {
  DocumentSearchResult,
  GlobalSearchResponse,
  ProjectSearchResult,
} from "@repo/api/src/types/search";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

const SEARCH_LIMIT = 25;
const SEARCH_ORDER = {
  orderBy: { updatedAt: "desc" },
  take: SEARCH_LIMIT,
} as const;

const artifactSearchSelect = {
  id: true,
  name: true,
  slug: true,
  subtype: true,
  status: true,
  priority: true,
  updatedAt: true,
  assignee: basicUserSelect,
  project: { select: { name: true } },
} as const;

function ilike(query: string) {
  return { contains: query, mode: "insensitive" } as const;
}

// Human-readable labels for artifact subtypes so a free-text query can match by
// TYPE (e.g. "implementation" or "plan" → IMPLEMENTATION_PLAN), not just title text.
const SUBTYPE_LABELS: Record<ArtifactSubtype, string> = {
  [ArtifactSubtype.PRD]: "prd",
  [ArtifactSubtype.IMPLEMENTATION_PLAN]: "implementation plan",
  [ArtifactSubtype.TEMPLATE]: "template",
  [ArtifactSubtype.FEATURE]: "feature",
};

function matchingSubtypes(query: string): ArtifactSubtype[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  return (Object.keys(SUBTYPE_LABELS) as ArtifactSubtype[]).filter(
    (subtype) =>
      SUBTYPE_LABELS[subtype].includes(q) || subtype.toLowerCase().includes(q)
  );
}

export const searchService = {
  async search(
    organizationId: string,
    query: string
  ): Promise<GlobalSearchResponse> {
    const [documents, projects] = await Promise.all([
      searchDocuments(organizationId, query),
      searchProjects(organizationId, query),
    ]);

    return { query, documents, projects };
  },

  async searchByTag(
    organizationId: string,
    tagId: string
  ): Promise<GlobalSearchResponse> {
    const tag = await withDb((db) =>
      db.tag.findFirst({
        where: { id: tagId, organizationId },
        select: { name: true },
      })
    );

    if (!tag) {
      return { query: "", tagId, documents: [], projects: [] };
    }

    const artifactIds = await withDb((db) =>
      db.tagArtifact.findMany({
        where: { tagId },
        select: { artifactId: true },
      })
    );

    if (artifactIds.length === 0) {
      return {
        query: "",
        tagId,
        tagName: tag.name,
        documents: [],
        projects: [],
      };
    }

    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          id: { in: artifactIds.map((a) => a.artifactId) },
        },
        select: artifactSearchSelect,
        ...SEARCH_ORDER,
      })
    );

    const documents = rows.flatMap((r) => {
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
          projectName: r.project?.name ?? null,
          assignee: r.assignee,
          updatedAt: r.updatedAt,
        },
      ];
    });

    return {
      query: "",
      tagId,
      tagName: tag.name,
      documents,
      projects: [],
    };
  },
};

async function searchDocuments(
  organizationId: string,
  query: string
): Promise<DocumentSearchResult[]> {
  const subtypes = matchingSubtypes(query);
  // Two prioritized passes so an exact name/slug match is never crowded out of the
  // result limit by a broad type/tag clause that has many recent rows. Each pass is
  // independently limited + recency-ordered; text matches take precedence on merge.
  const broadClauses = [
    // Match by TYPE label (e.g. "implementation"/"plan" → IMPLEMENTATION_PLAN).
    ...(subtypes.length > 0 ? [{ subtype: { in: subtypes } }] : []),
    // Match by TAG name (org-scoped) via the tag join.
    { tagArtifacts: { some: { tag: { organizationId, name: ilike(query) } } } },
  ];
  const [textRows, broadRows] = await Promise.all([
    withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          OR: [{ name: ilike(query) }, { slug: ilike(query) }],
        },
        select: artifactSearchSelect,
        ...SEARCH_ORDER,
      })
    ),
    withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          OR: broadClauses,
        },
        select: artifactSearchSelect,
        ...SEARCH_ORDER,
      })
    ),
  ]);

  const seen = new Set<string>();
  const rows: typeof textRows = [];
  for (const row of [...textRows, ...broadRows]) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= SEARCH_LIMIT) {
      break;
    }
  }

  const mapped = rows.flatMap((r) => {
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
        projectName: r.project?.name ?? null,
        assignee: r.assignee,
        updatedAt: r.updatedAt,
      },
    ];
  });

  return rankBySlugMatch(query, mapped, (r) => r.slug);
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
        OR: [
          { name: ilike(query) },
          { description: ilike(query) },
          { slug: ilike(query) },
        ],
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

  return rankBySlugMatch(
    query,
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      priority: r.priority,
      teamName: r.teams[0]?.team.name ?? null,
      teamId: r.teams[0]?.team.id ?? null,
      assignee: r.assignee,
      updatedAt: r.updatedAt,
    })),
    (r) => r.slug
  );
}

function rankBySlugMatch<T>(
  query: string,
  results: T[],
  getSlug: (item: T) => string | null | undefined
): T[] {
  const normalizedQuery = query.toLowerCase();
  const exactMatches: T[] = [];
  const rest: T[] = [];
  for (const item of results) {
    const slug = getSlug(item);
    if (slug && slug.toLowerCase() === normalizedQuery) {
      exactMatches.push(item);
    } else {
      rest.push(item);
    }
  }
  return [...exactMatches, ...rest];
}
