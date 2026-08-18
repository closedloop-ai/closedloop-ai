import { normalizeArtifactSubtype } from "@repo/api/src/types/artifact";
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
// FEA-3956: exhaustive over the generated (widened) enum, which now includes the
// canonical `ISSUE`. `ISSUE` is labeled "issue" (the post-rename display name)
// so a free-text "issue" query is recognized; it is normalized to the persisted
// `FEATURE` before the `subtype IN (...)` filter (rows are stored as FEATURE, so
// searching "issue" must still target FEATURE rows).
const SUBTYPE_LABELS: Record<ArtifactSubtype, string> = {
  [ArtifactSubtype.PRD]: "prd",
  [ArtifactSubtype.IMPLEMENTATION_PLAN]: "implementation plan",
  [ArtifactSubtype.TEMPLATE]: "template",
  [ArtifactSubtype.FEATURE]: "feature",
  [ArtifactSubtype.DOC]: "document",
  [ArtifactSubtype.ISSUE]: "issue",
};

function matchingSubtypes(query: string): ArtifactSubtype[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const matched = (Object.keys(SUBTYPE_LABELS) as ArtifactSubtype[]).filter(
    (subtype) =>
      SUBTYPE_LABELS[subtype].includes(q) || subtype.toLowerCase().includes(q)
  );
  // Map the canonical `ISSUE` label match down to the persisted `FEATURE`
  // subtype and dedupe, so the `subtype IN (...)` filter targets stored rows.
  return [
    ...new Set(matched.map((subtype) => normalizeArtifactSubtype(subtype))),
  ];
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

    // Let the DB do the tag join, recency ordering, and SEARCH_LIMIT cap in one
    // query via the same relation filter searchDocuments uses. A popular org-wide
    // tag can carry thousands of artifacts, so materializing every tagArtifact row
    // and shipping an unbounded IN clause is wasteful when the result is capped.
    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          type: ArtifactType.DOCUMENT,
          tagArtifacts: { some: { tagId } },
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
          // FEA-3956: normalize persisted subtype to canonical DocumentType.
          type: normalizeArtifactSubtype(r.subtype),
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
        // FEA-3956: normalize persisted subtype to canonical DocumentType.
        type: normalizeArtifactSubtype(r.subtype),
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
