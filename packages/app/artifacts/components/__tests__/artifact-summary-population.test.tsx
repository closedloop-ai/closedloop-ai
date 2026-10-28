// @vitest-environment jsdom

/**
 * ISS-12600 — every Documents card is computed over the full filtered
 * population. The API is faked as a population store that answers the scope the
 * cards SEND, so a card fed a loaded page instead of a scope reads the page's
 * figure and fails. The surface is handed only one page of rows throughout.
 */
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  type CustomFieldFilter,
  CustomFieldFilterOperator,
} from "@repo/api/src/types/custom-field-list-query";
import {
  DocumentType,
  type DocumentWithProject,
} from "@repo/api/src/types/document";
import { median } from "@repo/api/src/utils/math";
import { documentsPrototypeColumns } from "@repo/app/artifacts/components/artifact-list-model";
import { ArtifactSummary } from "@repo/app/artifacts/components/artifact-summary";
import { artifactSummaryScope } from "@repo/app/artifacts/components/artifact-summary-scope";
import { documentCustomFieldColumnId } from "@repo/app/documents/components/documents-prototype-custom-fields";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  type ArtifactFilters,
  initialArtifactFilters,
  type CustomFieldFilter as ListFieldFilter,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ArtifactListShellController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { formatCostPreciseOrDash } from "@repo/app/shared/lib/format-utils";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => api,
}));

const OWNER_A = "00000000-0000-4000-8000-00000000000a";
const OWNER_B = "00000000-0000-4000-8000-00000000000b";
const OWNER_C = "00000000-0000-4000-8000-00000000000c";
const TAG_RED = "00000000-0000-4000-8000-0000000000e1";
const TAG_BLUE = "00000000-0000-4000-8000-0000000000e2";
const FIELD_ID = "00000000-0000-4000-8000-0000000000f1";
const OPTION_HIGH = "00000000-0000-4000-8000-0000000000f2";
const OPTION_LOW = "00000000-0000-4000-8000-0000000000f3";
const PAGE_SIZE = 50;
const TYPES = [DocumentType.Prd, DocumentType.ImplementationPlan];

/** One stored artifact, holding exactly the facts the scope filters read. */
type StoredDocument = {
  id: string;
  assigneeId: string | null;
  tagIds: string[];
  favorite: boolean;
  optionId: string;
  cost: number;
  produced: boolean;
};

/** 200 artifacts, so every facet below matches well over one page of rows. */
const STORE: StoredDocument[] = Array.from({ length: 200 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  assigneeId: [OWNER_A, OWNER_B, OWNER_C, null][index % 4] ?? null,
  tagIds: index % 3 === 0 ? [TAG_BLUE] : [TAG_RED],
  favorite: index % 5 !== 0,
  optionId: index % 7 === 0 ? OPTION_LOW : OPTION_HIGH,
  cost: (index % 11) + index / 100,
  produced: index % 2 === 0,
}));

const PRIORITY_FIELD: CustomFieldWithOptions = {
  id: FIELD_ID,
  organizationId: "org-1",
  name: "Priority",
  description: null,
  fieldType: CustomFieldType.Enum,
  createdById: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
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
  enumOptions: [
    {
      id: OPTION_HIGH,
      customFieldId: FIELD_ID,
      name: "High",
      color: "red",
      enabled: true,
      sortOrder: 0,
    },
    {
      id: OPTION_LOW,
      customFieldId: FIELD_ID,
      name: "Low",
      color: "blue",
      enabled: true,
      sortOrder: 1,
    },
  ],
};

const FIELD_COLUMN = {
  ...documentsPrototypeColumns()[0],
  id: documentCustomFieldColumnId(FIELD_ID),
};

/** The four facets the ticket names, each matching more rows than a page. */
const FACETS: {
  name: string;
  filters?: Partial<ArtifactFilters>;
  extensionFilters?: Record<string, ListFieldFilter>;
  matches: (row: StoredDocument) => boolean;
}[] = [
  {
    name: "tags",
    filters: { tags: [TAG_RED] },
    matches: (row) => row.tagIds.includes(TAG_RED),
  },
  {
    name: "favorites",
    filters: { favoritesOnly: true },
    matches: (row) => row.favorite,
  },
  {
    name: "multiple owners",
    filters: { owners: [OWNER_A, OWNER_B] },
    matches: (row) => row.assigneeId === OWNER_A || row.assigneeId === OWNER_B,
  },
  {
    name: "a custom-field filter",
    extensionFilters: {
      [documentCustomFieldColumnId(FIELD_ID)]: { selectedValues: ["High"] },
    },
    matches: (row) => row.optionId === OPTION_HIGH,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url: string) =>
    Promise.resolve(summaryFor(scopeOfQuery(url)))
  );
  api.post.mockImplementation((_url: string, body: { scope?: Scope }) =>
    Promise.resolve(costsFor(body.scope ?? {}))
  );
});

describe("Documents cards over the full filtered population", () => {
  it.each(FACETS)(
    "computes all five cards for $name over every match, not the page",
    async (facet) => {
      const matching = STORE.filter(facet.matches);
      expect(matching.length).toBeGreaterThan(PAGE_SIZE);
      mount(controller(facet), page(matching));

      const costs = matching.map((row) => row.cost);
      const expected = [
        String(matching.length),
        String(matching.filter((row) => row.produced).length),
        String(matching.filter(isRecent).length),
        formatCostPreciseOrDash(sum(costs)),
        formatCostPreciseOrDash(median(costs) ?? undefined),
      ];
      for (const text of expected) {
        expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
      }
      expect(api.get.mock.calls.at(-1)?.[0]).not.toContain("artifactIds");
      expect(api.post.mock.calls.at(-1)?.[1]).toMatchObject({
        artifactIds: [],
      });
      expect(api.post.mock.calls.at(-1)?.[1].scope.artifactIds).toBeUndefined();
    }
  );

  it("keeps every card value through page, sort, group and layout changes", async () => {
    const facet = FACETS[0];
    const matching = STORE.filter(facet.matches);
    const host = mount(controller(facet), page(matching));
    await screen.findAllByText(String(matching.length));
    const before = host.container.textContent;
    const reads = [api.get.mock.calls.length, api.post.mock.calls.length];

    host.rerender(
      summary(
        controller(facet, {
          page: 3,
          pageSize: 25,
          sortActive: true,
          sortBy: "title",
          sortDir: "desc",
          groupBy: "status",
          layout: "board",
        }),
        matching.slice(PAGE_SIZE, PAGE_SIZE * 2).map(toDocument)
      )
    );

    expect(host.container.textContent).toEqual(before);
    expect([api.get.mock.calls.length, api.post.mock.calls.length]).toEqual(
      reads
    );
  });

  it("derives one scope whatever page, sort, group or layout is showing", () => {
    const facet = FACETS[3];
    const scope = (overrides: Partial<ArtifactListShellController>) =>
      artifactSummaryScope(
        controller(facet, overrides),
        "user-1",
        "",
        { types: TYPES },
        undefined,
        undefined,
        [PRIORITY_FIELD]
      );
    expect(scope({ page: 4, layout: "board", groupBy: "owner" })).toEqual(
      scope({})
    );
    expect(scope({}).params.customFieldFilters).toEqual([
      {
        fieldId: FIELD_ID,
        operator: CustomFieldFilterOperator.IsAnyOf,
        values: [OPTION_HIGH],
      },
    ]);
  });

  it("never renders an in-flight response from the previous filter", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    api.get.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          pending.set(
            new URLSearchParams(url.split("?")[1]).getAll("tagIds")[0] ?? "",
            resolve
          );
        })
    );
    const red = FACETS[0];
    const blue = {
      ...red,
      filters: { tags: [TAG_BLUE] },
      matches: (row: StoredDocument) => row.tagIds.includes(TAG_BLUE),
    };
    const host = mount(controller(red), page(STORE.filter(red.matches)));
    await waitFor(() => expect(pending.has(TAG_RED)).toBe(true));
    host.rerender(summary(controller(blue), page(STORE.filter(blue.matches))));
    await waitFor(() => expect(pending.has(TAG_BLUE)).toBe(true));

    await act(async () => {
      pending.get(TAG_RED)?.({ ...summaryFor({}), total: 977 });
      await Promise.resolve();
    });
    expect(screen.queryByText("977")).not.toBeInTheDocument();

    await act(async () => {
      pending.get(TAG_BLUE)?.({ ...summaryFor({}), total: 313 });
      await Promise.resolve();
    });
    expect(await screen.findByText("313")).toBeInTheDocument();
    expect(screen.queryByText("977")).not.toBeInTheDocument();
  });
});

describe("a refused scope falls back to the complete-cohort read", () => {
  const facet = FACETS[0];
  const matching = STORE.filter(facet.matches);

  it.each([
    ["a refused custom-field facet", 400, "custom_field_filter_too_broad"],
    [
      "an older API's strict validator",
      400,
      'Invalid query parameters: Unrecognized key: "tagIds"',
    ],
    ["an over-long request URI", 414, "URI Too Long"],
    ["over-large request headers", 431, "Request Header Fields Too Large"],
  ])("%s", async (_name, status, message) => {
    refuseScope(status, message);
    mount(controller(facet), matching.map(toDocument));

    for (const text of readCardTexts(matching)) {
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }
    expect(
      api.get.mock.calls.some(([url]) => String(url).includes("artifactIds"))
    ).toBe(true);
  });

  it("reads the cohort without sending a scope past the query budget", async () => {
    refuseScope(400, "the scope should never have been sent");
    const tags = [
      TAG_RED,
      ...Array.from(
        { length: 199 },
        (_, index) =>
          `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`
      ),
    ];
    mount(controller({ filters: { tags } }), matching.map(toDocument));

    for (const text of readCardTexts(matching)) {
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }
    expect(
      api.get.mock.calls.every(([url]) => String(url).includes("artifactIds"))
    ).toBe(true);
    expect(
      api.post.mock.calls.every(([, body]) => body.scope === undefined)
    ).toBe(true);
  });
});

describe("a remembered refusal", () => {
  const facet = FACETS[0];
  const matching = STORE.filter(facet.matches);

  it("keeps the cohort cards through an invalidation and a remount, never re-sending the scope", async () => {
    refuseScope(400, "custom_field_filter_too_broad");
    const queryClient = createTestQueryClient();
    const host = mount(
      controller(facet),
      matching.map(toDocument),
      queryClient
    );
    const texts = readCardTexts(matching);
    for (const text of texts) {
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }
    const refusals = scopeRequestCount();

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: documentKeys.summaries(),
      });
    });
    for (const text of texts) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    host.unmount();
    mount(controller(facet), matching.map(toDocument), queryClient);
    for (const text of texts) {
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }
    expect(scopeRequestCount()).toBe(refusals);
  });

  it("falls back for costs alone when only the cost read refuses", async () => {
    refuseScope(400, "custom_field_filter_too_broad", {
      summary: false,
      costs: true,
    });
    mount(controller(facet), matching.map(toDocument));

    for (const text of readCardTexts(matching)) {
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }
    expect(
      api.post.mock.calls.some(([, body]) => body.scope === undefined)
    ).toBe(true);
    // The summary keeps its server scope: no cohort summary read is made.
    expect(
      api.get.mock.calls.some(([url]) => String(url).includes("artifactIds"))
    ).toBe(false);
  });

  it("still sends an oversized scope when no complete cohort exists to fall back to", async () => {
    const tags = [
      TAG_RED,
      ...Array.from(
        { length: 199 },
        (_, index) =>
          `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`
      ),
    ];
    render(summary(controller({ filters: { tags } }), page(matching), false), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    await waitFor(() =>
      expect(
        api.get.mock.calls.some(([url]) => String(url).includes("tagIds"))
      ).toBe(true)
    );
  });
});

/** The server refuses the scope; it answers the complete-cohort id reads. */
function refuseScope(
  status: number,
  message: string,
  refuses: { summary: boolean; costs: boolean } = {
    summary: true,
    costs: true,
  }
) {
  api.get.mockImplementation((url: string) => {
    const ids = new URLSearchParams(url.split("?")[1]).getAll("artifactIds");
    if (ids.length === 0) {
      return refuses.summary
        ? Promise.reject(new ApiError(message, status))
        : Promise.resolve(summaryFor(scopeOfQuery(url)));
    }
    const rows = STORE.filter((row) => ids.includes(row.id));
    return Promise.resolve({
      ...summaryOfRows(rows),
      appliedArtifactIds: ids,
    });
  });
  api.post.mockImplementation(
    (_url: string, body: { scope?: Scope; artifactIds: string[] }) => {
      if (body.scope) {
        return refuses.costs
          ? Promise.reject(new ApiError(message, status))
          : Promise.resolve(costsFor(body.scope));
      }
      const rows = STORE.filter((row) => body.artifactIds.includes(row.id));
      return Promise.resolve({
        ...costsOfRows(rows),
        artifacts: rows.map((row) => ({
          artifactId: row.id,
          totalEstimatedCost: row.cost,
        })),
        sessionCosts: rows.map((row) => ({
          sessionId: row.id,
          totalEstimatedCost: row.cost,
        })),
      });
    }
  );
}

/** The cards only the summary and cost reads can fill, for these rows. */
function readCardTexts(rows: StoredDocument[]): string[] {
  const costs = rows.map((row) => row.cost);
  return [
    String(rows.filter((row) => row.produced).length),
    formatCostPreciseOrDash(sum(costs)),
    formatCostPreciseOrDash(median(costs) ?? undefined),
  ];
}

type Scope = {
  tagIds?: string[];
  assigneeIds?: string[];
  includeUnassigned?: boolean;
  favoritesOnly?: boolean;
  customFieldFilters?: CustomFieldFilter[];
};

/** The fake API's population read, honoring exactly the scope it is sent. */
function matchingRows(scope: Scope): StoredDocument[] {
  return STORE.filter(
    (row) =>
      (!scope.tagIds ||
        row.tagIds.some((tag) => scope.tagIds?.includes(tag))) &&
      (!(scope.assigneeIds || scope.includeUnassigned) ||
        (row.assigneeId !== null &&
          (scope.assigneeIds ?? []).includes(row.assigneeId)) ||
        (row.assigneeId === null && Boolean(scope.includeUnassigned))) &&
      (!scope.favoritesOnly || row.favorite) &&
      (scope.customFieldFilters ?? []).every((filter) =>
        filter.values?.includes(row.optionId)
      )
  );
}

function scopeOfQuery(url: string): Scope {
  const query = new URLSearchParams(url.split("?")[1]);
  const fields = query.get("customFieldFilters");
  return {
    ...(query.has("tagIds") ? { tagIds: query.getAll("tagIds") } : {}),
    ...(query.has("assigneeIds")
      ? { assigneeIds: query.getAll("assigneeIds") }
      : {}),
    includeUnassigned: query.get("includeUnassigned") === "true",
    favoritesOnly: query.get("favoritesOnly") === "true",
    ...(fields ? { customFieldFilters: JSON.parse(fields) } : {}),
  };
}

function summaryFor(scope: Scope) {
  return summaryOfRows(matchingRows(scope));
}

function summaryOfRows(rows: StoredDocument[]) {
  return {
    total: rows.length,
    producedByAgentSessions: rows.filter((row) => row.produced).length,
    updatedInWindow: rows.filter(isRecent).length,
    neverEdited: 0,
    windowDays: 7,
    appliedTypes: TYPES,
  };
}

function costsFor(scope: Scope) {
  return costsOfRows(matchingRows(scope));
}

function costsOfRows(rows: StoredDocument[]) {
  const costs = rows.map((row) => row.cost);
  return {
    artifacts: [],
    totalEstimatedCost: sum(costs),
    medianEstimatedCost: median(costs) ?? undefined,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toDocument(row: StoredDocument): DocumentWithProject {
  return createMockDocument({
    id: row.id,
    type: DocumentType.Prd,
    assigneeId: row.assigneeId,
    updatedAt: new Date(),
  });
}

/** The ONE page of rows the list would have loaded. */
function page(rows: StoredDocument[]): DocumentWithProject[] {
  return rows.slice(0, PAGE_SIZE).map(toDocument);
}

function controller(
  facet: Pick<(typeof FACETS)[number], "filters" | "extensionFilters">,
  overrides: Partial<ArtifactListShellController> = {}
): ArtifactListShellController {
  return {
    filters: { ...initialArtifactFilters, ...facet.filters },
    dateDimension: { present: true, range: "all", setRange: vi.fn() },
    customFieldFilters: {},
    extensionFilters: facet.extensionFilters ?? {},
    extensionColumns: [...documentsPrototypeColumns(), FIELD_COLUMN],
    visibleMetricKeys: new Set([
      "documents",
      "total-cost",
      "median-cost",
      "metric-four",
      "metric-five",
    ]),
    ...overrides,
  } as ArtifactListShellController;
}

function summary(
  shell: ArtifactListShellController,
  documents: DocumentWithProject[],
  complete = true
) {
  return (
    <ArtifactSummary
      complete={complete}
      controller={shell}
      currentUserId="user-1"
      customFields={[PRIORITY_FIELD]}
      documents={documents}
      filterText=""
      isUnsettled={false}
      readError={false}
      readLoading={false}
      searchParams={{ types: TYPES }}
    />
  );
}

function mount(
  shell: ArtifactListShellController,
  documents: DocumentWithProject[],
  queryClient = createTestQueryClient()
) {
  return render(summary(shell, documents), {
    wrapper: createWrapperWithClient(queryClient),
  });
}

/** Requests that carried the server scope rather than the cohort ids. */
function scopeRequestCount(): number {
  return (
    api.get.mock.calls.filter(([url]) => !String(url).includes("artifactIds"))
      .length +
    api.post.mock.calls.filter(([, body]) => body.scope !== undefined).length
  );
}

function isRecent(row: StoredDocument): boolean {
  return row.cost > 5;
}
