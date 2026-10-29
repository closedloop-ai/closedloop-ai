import {
  type Artifact,
  ArtifactSubtype,
  ArtifactType,
} from "@repo/api/src/types/artifact.ts";
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field.ts";
import {
  type CustomFieldFilter,
  CustomFieldFilterOperator,
} from "@repo/api/src/types/custom-field-list-query.ts";
import {
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  documentTypeInputSchema,
  normalizeDocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document.ts";
import {
  type DocumentCostsRequest,
  type DocumentCostsResponse,
  documentCostsRequestSchema,
} from "@repo/api/src/types/document-costs.ts";
import {
  DOCUMENT_SUMMARY_WINDOW_DAYS,
  type DocumentListSummary,
} from "@repo/api/src/types/document-list-summary.ts";
import { customFieldFilterSetSchema } from "@repo/api/src/types/document-metric-scope.ts";
import { median } from "@repo/api/src/utils/math.ts";

/**
 * ISS-12600 population store shared by the web (`documents-summary-scope.spec`)
 * and Electron (`documents-summary-scope.spec`) regressions.
 *
 * Every response is COMPUTED from the scope the client submitted, never served
 * as a fixed body: a card fed a loaded page, or a scope the fixture does not
 * honor, reads a different figure than {@link expectedCards} and fails.
 * `@repo/*` subpaths carry the `.ts` suffix because this module is also loaded
 * by the Electron spec loader (`apps/desktop/test/AGENTS.md` -> Import hazard).
 */

export const POPULATION_SIZE = 130;
export const LIST_PAGE_SIZE = 25;

const DAY_MS = 86_400_000;
const NOW_MS = Date.now();
const ORG_ID = "00000000-0000-4000-8000-0000000000a0";
const WINDOW_DAYS = DOCUMENT_SUMMARY_WINDOW_DAYS;

export const OWNER_A_ID = "00000000-0000-4000-8000-00000000000a";
export const OWNER_B_ID = "00000000-0000-4000-8000-00000000000b";
export const OWNER_C_ID = "00000000-0000-4000-8000-00000000000c";
export const TAG_RED_ID = "00000000-0000-4000-8000-0000000000e1";
export const TAG_BLUE_ID = "00000000-0000-4000-8000-0000000000e2";
export const FIELD_ID = "00000000-0000-4000-8000-0000000000f1";

export const OWNER_A_NAME = "Avery Alpha";
export const OWNER_B_NAME = "Blake Bravo";
export const OWNER_C_NAME = "Casey Charlie";
export const TAG_RED_NAME = "scope-red";
export const TAG_BLUE_NAME = "scope-blue";
export const FIELD_NAME = "Review lane";
export const LANE_ALPHA = "Lane Alpha";
export const LANE_BETA = "Lane Beta";

export const OWNERS = [
  { id: OWNER_A_ID, firstName: "Avery", lastName: "Alpha" },
  { id: OWNER_B_ID, firstName: "Blake", lastName: "Bravo" },
  { id: OWNER_C_ID, firstName: "Casey", lastName: "Charlie" },
].map((owner) => ({
  ...owner,
  email: `${owner.firstName.toLowerCase()}@example.com`,
  avatarUrl: null,
}));

const TAGS = {
  [TAG_RED_ID]: { id: TAG_RED_ID, name: TAG_RED_NAME, color: "red" as const },
  [TAG_BLUE_ID]: {
    id: TAG_BLUE_ID,
    name: TAG_BLUE_NAME,
    color: "blue" as const,
  },
};

/** The custom-field definition `GET /custom-fields` answers. */
export const LANE_FIELD: CustomFieldWithOptions = {
  id: FIELD_ID,
  organizationId: ORG_ID,
  name: FIELD_NAME,
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: new Date(NOW_MS),
  updatedAt: new Date(NOW_MS),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: true,
  entityTypes: [CustomFieldEntityType.Document],
  referenceTargetSources: [],
  showInTable: true,
  isSearchable: true,
  isSortable: true,
  enumOptions: [],
};

/** One stored artifact: the document row plus the facts only the server holds. */
type StoredDocument = {
  document: DocumentWithProject;
  favorite: boolean;
  lane: string;
  cost: number;
  produced: boolean;
};

const POPULATION: StoredDocument[] = Array.from(
  { length: POPULATION_SIZE },
  (_unused, index) => {
    const owner = [...OWNERS, null][index % 4] ?? null;
    const lane = index % 7 === 0 ? LANE_BETA : LANE_ALPHA;
    // Recent rows sit 1-5 days back and the rest 15-25, so the seven-day
    // window and the default 30-day range never land on a boundary.
    const ageDays = index % 3 === 0 ? 15 + (index % 11) : 1 + (index % 5);
    const updatedAt = new Date(NOW_MS - ageDays * DAY_MS);
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const customField: CustomFieldValueDetail = {
      id: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
      customFieldId: FIELD_ID,
      entityId: id,
      name: FIELD_NAME,
      fieldType: CustomFieldType.Text,
      displayValue: lane,
      showInTable: true,
      textValue: lane,
      numberValue: null,
      dateValue: null,
      enumValue: null,
      multiEnumValues: [],
      peopleValues: [],
      referenceValues: [],
    };
    return {
      document: {
        id,
        organizationId: ORG_ID,
        projectId: null,
        project: null,
        type: DocumentType.Doc,
        title: `Scope population document ${String(index + 1).padStart(3, "0")}`,
        slug: `scope-population-${index + 1}`,
        fileName: null,
        status: DocumentStatus.Draft,
        priority: null,
        latestVersion: 1,
        createdById: OWNER_A_ID,
        assigneeId: owner?.id ?? null,
        assignee: owner,
        approverId: null,
        approver: null,
        repositorySnapshot: { repositories: [], source: SnapshotSource.None },
        templateForType: null,
        sortOrder: null,
        createdAt: updatedAt,
        updatedAt,
        tags: [index % 3 === 0 ? TAGS[TAG_BLUE_ID] : TAGS[TAG_RED_ID]],
        customFields: [customField],
      },
      favorite: index % 5 !== 0,
      lane,
      cost: (index % 11) + index / 100,
      produced: index % 2 === 0,
    };
  }
);

/** The rows `GET /documents` serves, before the request's own filters. */
export const POPULATION_DOCUMENTS = POPULATION.map((row) => row.document);

/** Favorites as `GET /artifacts/favorites` answers them (identity is all it reads). */
export const FAVORITE_IDS = POPULATION.filter((row) => row.favorite).map(
  (row) => row.document.id
);

/**
 * The five cards' labels. Literals because the components that own them
 * (`artifact-list-model.tsx`) cannot load under the Electron spec loader;
 * `documents-summary-scope-population.unit.spec.ts` pins the three that live in
 * a loadable module to their canonical constants.
 */
export const CARD_LABELS = {
  documents: "Documents",
  updatedThisWeek: "Updated this week",
  producedBySessions: "Produced by sessions",
  totalCost: "Est. Total",
  medianCost: "Median token cost",
} as const;

/** A favorite as `GET /artifacts/favorites` answers it. */
export function favoriteArtifact(id: string): Artifact {
  const document = POPULATION_DOCUMENTS.find(
    (candidate) => candidate.id === id
  );
  if (!document) {
    throw new Error(`No population document ${id}`);
  }
  return {
    id,
    organizationId: document.organizationId,
    projectId: null,
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Doc,
    name: document.title,
    slug: document.slug,
    status: document.status,
    priority: null,
    assigneeId: document.assigneeId,
    assignee: document.assignee,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: document.createdAt,
    createdById: document.createdById,
    updatedAt: document.updatedAt,
  };
}

/** The four filters the ticket names, each matching more rows than one page. */
export const ScopeFacet = {
  Tags: "tags",
  Favorites: "favorites",
  Owners: "owners",
  CustomField: "customField",
} as const;
export type ScopeFacet = (typeof ScopeFacet)[keyof typeof ScopeFacet];

/** What a request narrows by, in the vocabulary the metric endpoints share. */
export type PopulationScope = {
  artifactIds?: string[];
  assigneeId?: string;
  assigneeIds?: string[];
  customFieldFilters?: CustomFieldFilter[];
  favoritesOnly?: boolean;
  includeUnassigned?: boolean;
  recencyDays?: number;
  search?: string;
  tagIds?: string[];
  types?: DocumentType[];
};

/** The scope a `GET /documents/summary` or `GET /documents` request carries. */
export function scopeFromQuery(url: URL): PopulationScope {
  const params = url.searchParams;
  const list = (key: string) => {
    const values = params.getAll(key);
    return values.length > 0 ? values : undefined;
  };
  const custom = params.get("customFieldFilters");
  const recency = params.get("recencyDays");
  return {
    artifactIds: params.has("artifactIds")
      ? params.getAll("artifactIds").filter(Boolean)
      : undefined,
    assigneeId: params.get("assigneeId") ?? undefined,
    assigneeIds: list("assigneeIds"),
    customFieldFilters: custom
      ? customFieldFilterSetSchema.parse(JSON.parse(custom))
      : undefined,
    favoritesOnly: params.get("favoritesOnly") === "true" || undefined,
    includeUnassigned: params.get("includeUnassigned") === "true" || undefined,
    recencyDays: recency === null ? undefined : Number(recency),
    search: params.get("search") ?? undefined,
    tagIds: list("tagIds"),
    types: list("types")?.map((type) =>
      normalizeDocumentType(documentTypeInputSchema.parse(type))
    ),
  };
}

function matchesScope(row: StoredDocument, scope: PopulationScope): boolean {
  const { document } = row;
  const hasOwnerScope =
    scope.assigneeIds !== undefined || scope.includeUnassigned === true;
  const ownerMatches =
    (scope.assigneeIds?.includes(document.assigneeId ?? "") ?? false) ||
    (scope.includeUnassigned === true && document.assigneeId === null);
  return (
    (scope.artifactIds === undefined ||
      scope.artifactIds.includes(document.id)) &&
    (scope.types === undefined || scope.types.includes(document.type)) &&
    (scope.search === undefined ||
      document.title.toLowerCase().includes(scope.search.toLowerCase())) &&
    (scope.recencyDays === undefined ||
      NOW_MS - new Date(document.updatedAt).getTime() <=
        scope.recencyDays * DAY_MS) &&
    (scope.assigneeId === undefined ||
      document.assigneeId === scope.assigneeId) &&
    (!hasOwnerScope || ownerMatches) &&
    (scope.tagIds === undefined ||
      (document.tags ?? []).some((tag) => scope.tagIds?.includes(tag.id))) &&
    (scope.favoritesOnly !== true || row.favorite) &&
    (scope.customFieldFilters ?? []).every(
      (filter) =>
        filter.fieldId === FIELD_ID &&
        filter.operator === CustomFieldFilterOperator.IsAnyOf &&
        (filter.values ?? []).includes(row.lane)
    )
  );
}

function matching(scope: PopulationScope): StoredDocument[] {
  return POPULATION.filter((row) => matchesScope(row, scope));
}

/** The rows `GET /documents` serves: the list narrows by type, search and recency only. */
export function answerList(url: URL): DocumentWithProject[] {
  const { types, search, recencyDays } = scopeFromQuery(url);
  return matching({ types, search, recencyDays }).map((row) => row.document);
}

/** `GET /documents/summary`, computed over the scope the request carried. */
export function answerSummary(url: URL): DocumentListSummary {
  const scope = scopeFromQuery(url);
  const rows = matching(scope);
  return {
    ...(scope.artifactIds
      ? { appliedArtifactIds: rows.map((row) => row.document.id) }
      : {}),
    ...(scope.types ? { appliedTypes: scope.types } : {}),
    total: rows.length,
    producedByAgentSessions: rows.filter((row) => row.produced).length,
    updatedInWindow: rows.filter(isUpdatedInWindow).length,
    neverEdited: rows.length,
    windowDays: WINDOW_DAYS,
  };
}

/**
 * The wire body of a `POST /documents/costs`, parsed with the route's own
 * strict schema so a field the API would reject fails the fixture too.
 */
export function parseCostsRequest(raw: unknown): DocumentCostsRequest {
  return documentCostsRequestSchema.parse(raw);
}

/** `POST /documents/costs`, computed over `scope` or, absent it, `artifactIds`. */
export function answerCosts(
  request: DocumentCostsRequest
): DocumentCostsResponse {
  const scope: PopulationScope = request.scope ?? {};
  const rows = matching({
    ...scope,
    artifactIds:
      scope.artifactIds ?? (request.scope ? undefined : request.artifactIds),
  });
  const costs = rows.map((row) => row.cost);
  return {
    artifacts: rows.map((row) => ({
      artifactId: row.document.id,
      totalEstimatedCost: row.cost,
    })),
    ...(rows.length > 0
      ? {
          totalEstimatedCost: sum(costs),
          medianEstimatedCost: median(costs) ?? undefined,
        }
      : {}),
    sessionCosts: [],
  };
}

/** The five card values over a facet's FULL population, as numbers. */
export function expectedCards(scope: PopulationScope) {
  const rows = matching({ ...scope, recencyDays: 30 });
  const costs = rows.map((row) => row.cost);
  return {
    count: rows.length,
    producedBySessions: rows.filter((row) => row.produced).length,
    updatedThisWeek: rows.filter(isUpdatedInWindow).length,
    totalCost: sum(costs),
    medianCost: median(costs) ?? 0,
  };
}

/** The scope a facet's UI selection is expected to put on the wire. */
export const FACET_SCOPES: Record<ScopeFacet, PopulationScope> = {
  [ScopeFacet.Tags]: { tagIds: [TAG_BLUE_ID] },
  [ScopeFacet.Favorites]: { favoritesOnly: true },
  [ScopeFacet.Owners]: { assigneeIds: [OWNER_A_ID, OWNER_B_ID] },
  [ScopeFacet.CustomField]: {
    customFieldFilters: [
      {
        fieldId: FIELD_ID,
        operator: CustomFieldFilterOperator.IsAnyOf,
        values: [LANE_ALPHA],
      },
    ],
  },
};

function isUpdatedInWindow(row: StoredDocument): boolean {
  return (
    NOW_MS - new Date(row.document.updatedAt).getTime() <= WINDOW_DAYS * DAY_MS
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
