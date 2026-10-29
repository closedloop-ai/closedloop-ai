/**
 * ISS-12600 — the Documents cards' newly scoped filters (owners, tags,
 * favorites, custom-field facets), proven at the REAL services against a DB
 * fake with Prisma's semantics (`prisma-where.test-db`): an absent `where` key
 * constrains nothing, so a predicate the service forgot reaches org B's rows.
 *
 * Each facet matches more of org A than one list page (and, for costs, more
 * than one 500-row cost batch), and org B holds rows that match EVERY facet, so
 * a count over the loaded page or over both organizations fails.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES,
  type CustomFieldFilter,
  CustomFieldFilterOperator,
  CustomFieldQueryRejection,
} from "@repo/api/src/types/custom-field-list-query";
import {
  DOCUMENT_LIST_DEFAULT_LIMIT,
  DocumentType,
} from "@repo/api/src/types/document";
import { DOCUMENT_COST_BATCH_SIZE } from "@repo/api/src/types/document-costs";
import type { DocumentMetricScopeFilters } from "@repo/api/src/types/document-metric-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FixtureRow,
  findManyRows,
  matchesWhere,
} from "@/__tests__/support/documents/prisma-where.test-db";

const store = vi.hoisted(() => ({
  artifacts: [] as Record<string, unknown>[],
  fields: [] as Record<string, unknown>[],
  values: [] as Record<string, unknown>[],
  costedArtifactIds: new Set<string>(),
}));

vi.mock("@repo/database", async (importActual) => {
  const actual = await importActual<typeof import("@repo/database")>();
  const db = {
    artifact: {
      count: async (args: { where?: unknown }) =>
        store.artifacts.filter((row) => matchesWhere(row, args.where)).length,
      findMany: async (args: unknown) => findManyRows(store.artifacts, args),
    },
    customField: {
      findFirst: async (args: { where?: unknown }) =>
        store.fields.find((row) => matchesWhere(row, args.where)) ?? null,
    },
    customFieldValue: {
      findMany: async (args: unknown) => findManyRows(store.values, args),
    },
    artifactLink: {
      findMany: (args: { where: { targetId: { in: string[] } } }) => {
        for (const id of args.where.targetId.in) {
          store.costedArtifactIds.add(id);
        }
        return Promise.resolve([]);
      },
    },
  };
  const withDb = Object.assign(
    async (run: (client: typeof db) => unknown) => await run(db),
    { tx: async (run: () => unknown) => await run() }
  );
  return { ...actual, withDb };
});

import { documentCostScopeService } from "../document-cost-scope-service";
import { documentSummaryService } from "../document-summary-service";

const ORG_A = "00000000-0000-4000-8000-0000000000a0";
const ORG_B = "00000000-0000-4000-8000-0000000000b0";
const USER = "00000000-0000-4000-8000-0000000000c0";
const OWNER_ONE = "00000000-0000-4000-8000-0000000000d1";
const OWNER_TWO = "00000000-0000-4000-8000-0000000000d2";
const OWNER_THREE = "00000000-0000-4000-8000-0000000000d3";
const TAG_RED = "00000000-0000-4000-8000-0000000000e1";
const TAG_BLUE = "00000000-0000-4000-8000-0000000000e2";
const FIELD = "00000000-0000-4000-8000-0000000000f1";
const FOREIGN_FIELD = "00000000-0000-4000-8000-0000000000f9";
const HIGH = "00000000-0000-4000-8000-0000000000f2";
const LOW = "00000000-0000-4000-8000-0000000000f3";
const ORG_A_ROWS = DOCUMENT_COST_BATCH_SIZE * 2;
const OLD = new Date("2025-01-01T00:00:00.000Z");

type Facet = {
  name: string;
  scope: DocumentMetricScopeFilters;
  matches: (index: number) => boolean;
};

const HIGH_FACET: CustomFieldFilter = {
  fieldId: FIELD,
  operator: CustomFieldFilterOperator.IsAnyOf,
  values: [HIGH],
};

const FACETS: Facet[] = [
  {
    name: "tags",
    scope: { tagIds: [TAG_RED] },
    matches: (index) => index % 3 !== 0,
  },
  {
    name: "favorites",
    scope: { favoritesOnly: true },
    matches: (index) => index % 5 !== 0,
  },
  {
    name: "multiple owners with Unassigned",
    scope: { assigneeIds: [OWNER_ONE, OWNER_TWO], includeUnassigned: true },
    matches: (index) => index % 4 !== 2,
  },
  {
    name: "a custom-field facet",
    scope: { customFieldFilters: [HIGH_FACET] },
    matches: (index) => index % 7 !== 0,
  },
];

beforeEach(() => {
  store.costedArtifactIds.clear();
  store.artifacts = [
    ...Array.from({ length: ORG_A_ROWS }, (_, index) => orgARow(index)),
    // Org B: rows that match every facet above, for the same user and field.
    ...Array.from({ length: 40 }, (_, index) => orgBRow(index)),
  ];
  store.fields = [
    {
      id: FIELD,
      organizationId: ORG_A,
      fieldType: CustomFieldType.Enum,
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    },
    {
      id: FOREIGN_FIELD,
      organizationId: ORG_B,
      fieldType: CustomFieldType.Enum,
      isSortable: true,
      isSearchable: true,
      entityTypes: [CustomFieldEntityType.Document],
    },
  ];
  store.values = store.artifacts.map((row, index) => ({
    id: `value-${String(index).padStart(6, "0")}`,
    organizationId: row.organizationId,
    entityType: CustomFieldEntityType.Document,
    customFieldId: FIELD,
    entityId: row.id,
    enumValueId: row.organizationId === ORG_B || index % 7 !== 0 ? HIGH : LOW,
  }));
});

describe.each(FACETS)("$name over the full population of one org", (facet) => {
  const expected = Array.from({ length: ORG_A_ROWS }, (_, index) => index)
    .filter(facet.matches)
    .map(orgAId);

  it("matches more of org A than a page and a cost batch", () => {
    expect(expected.length).toBeGreaterThan(DOCUMENT_LIST_DEFAULT_LIMIT);
    expect(expected.length).toBeGreaterThan(DOCUMENT_COST_BATCH_SIZE);
  });

  it("summarizes exactly org A's matches", async () => {
    const result = await documentSummaryService.summarizeScope(
      { ...facet.scope, organizationId: ORG_A, types: [DocumentType.Prd] },
      USER
    );
    expect(result).toMatchObject({
      ok: true,
      value: { total: expected.length },
    });
  });

  it("costs exactly org A's matches across every batch", async () => {
    const result = await documentCostScopeService.read(ORG_A, USER, {
      artifactIds: [],
      scope: { ...facet.scope, types: [DocumentType.Prd] },
    });
    expect(result.ok).toBe(true);
    expect([...store.costedArtifactIds].sort()).toEqual(expected);
  });
});

describe("custom-field facets the list read would refuse", () => {
  it("refuses another organization's field rather than counting it", async () => {
    const foreign = { ...HIGH_FACET, fieldId: FOREIGN_FIELD };
    await expect(
      documentSummaryService.summarizeScope(
        { organizationId: ORG_A, customFieldFilters: [foreign] },
        USER
      )
    ).resolves.toEqual({
      ok: false,
      error: CustomFieldQueryRejection.UnknownField,
    });
    await expect(
      documentCostScopeService.read(ORG_A, USER, {
        artifactIds: [],
        scope: { customFieldFilters: [foreign] },
      })
    ).resolves.toEqual({
      ok: false,
      error: CustomFieldQueryRejection.UnknownField,
    });
    expect(store.costedArtifactIds.size).toBe(0);
  });
});

// ISS-12600: the facet bound is measured on the subtypes a cost read covers.
describe("custom-field facet bound on the cost read's own population", () => {
  it("is not refused for matches among subtypes costs never read", async () => {
    const issueIds = Array.from(
      { length: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-3${String(index).padStart(11, "0")}`
    );
    for (const id of issueIds) {
      store.artifacts.push({
        ...baseRow(id, ORG_A, null, TAG_BLUE, false),
        subtype: DocumentType.Feature,
      });
      store.values.push({
        id: `value-${id}`,
        organizationId: ORG_A,
        entityType: CustomFieldEntityType.Document,
        customFieldId: FIELD,
        entityId: id,
        enumValueId: HIGH,
      });
    }

    const result = await documentCostScopeService.read(ORG_A, USER, {
      artifactIds: [],
      scope: { customFieldFilters: [HIGH_FACET] },
    });

    expect(result.ok).toBe(true);
    expect([...store.costedArtifactIds].sort()).toEqual(
      Array.from({ length: ORG_A_ROWS }, (_, index) => index)
        .filter((index) => index % 7 !== 0)
        .map(orgAId)
    );
  });
});

function orgAId(index: number): string {
  return `00000000-0000-4000-8000-1${String(index).padStart(11, "0")}`;
}

function orgARow(index: number): FixtureRow {
  return baseRow(
    orgAId(index),
    ORG_A,
    [OWNER_ONE, OWNER_TWO, OWNER_THREE, null][index % 4] ?? null,
    index % 3 === 0 ? TAG_BLUE : TAG_RED,
    index % 5 !== 0
  );
}

function orgBRow(index: number): FixtureRow {
  return baseRow(
    `00000000-0000-4000-8000-2${String(index).padStart(11, "0")}`,
    ORG_B,
    OWNER_ONE,
    TAG_RED,
    true
  );
}

function baseRow(
  id: string,
  organizationId: string,
  assigneeId: string | null,
  tagId: string,
  favorite: boolean
): FixtureRow {
  return {
    id,
    organizationId,
    type: ArtifactType.Document,
    subtype: DocumentType.Prd,
    assigneeId,
    createdAt: OLD,
    updatedAt: OLD,
    tagArtifacts: [{ tagId }],
    favoritedBy: favorite ? [{ userId: USER }] : [],
    targetLinks: [],
    document: { latestVersion: 2 },
  };
}
