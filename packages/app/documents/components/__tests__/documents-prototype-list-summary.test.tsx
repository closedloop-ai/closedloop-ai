// @vitest-environment jsdom

import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
} from "@repo/api/src/types/artifact-status";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  documentsPrototypeColumns,
  issuesPrototypeColumns,
} from "@repo/app/artifacts/components/artifact-list-model";
import { ArtifactSummary } from "@repo/app/artifacts/components/artifact-summary";
import { artifactSummaryScope } from "@repo/app/artifacts/components/artifact-summary-scope";
import { initialArtifactFilters } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ArtifactListShellController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { ArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createWrapper } from "@repo/app/shared/test-utils";
import { TableDatePreset } from "@repo/design-system/components/ui/table-filters";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ summary: vi.fn(), costs: vi.fn() }));
vi.mock("../../hooks/use-documents-summary", () => ({
  useDocumentsSummary: mocks.summary,
}));
vi.mock("../../hooks/use-documents-costs", () => ({
  useDocumentsCosts: mocks.costs,
}));
function controller(
  overrides: Partial<ArtifactListShellController> = {}
): ArtifactListShellController {
  return {
    filters: initialArtifactFilters,
    dateDimension: { present: true, range: "30d", setRange: vi.fn() },
    customFieldFilters: {},
    extensionFilters: {},
    extensionColumns: [
      ...documentsPrototypeColumns(),
      ...issuesPrototypeColumns(),
    ],
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
const documents = [
  createMockDocument({
    id: "prd",
    type: DocumentType.Prd,
    updatedAt: new Date(),
  }),
  createMockDocument({
    id: "doc",
    type: DocumentType.Doc,
    updatedAt: new Date(),
  }),
];
function mount(extra: Partial<Parameters<typeof ArtifactSummary>[0]> = {}) {
  return render(
    <ArtifactSummary
      complete
      controller={controller()}
      currentUserId="user-1"
      documents={documents}
      filterText=""
      isUnsettled={false}
      readError={false}
      readLoading={false}
      searchParams={{
        types: [
          DocumentType.Prd,
          DocumentType.ImplementationPlan,
          DocumentType.Doc,
        ],
      }}
      {...extra}
    />,
    { wrapper: createWrapper() }
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.summary.mockReturnValue({
    data: { total: 2, producedByAgentSessions: 1, updatedInWindow: 2 },
    isLoading: false,
    isError: false,
  });
  mocks.costs.mockReturnValue({
    data: { totalEstimatedCost: 1.25, medianEstimatedCost: 0.625 },
    isLoading: false,
    isError: false,
  });
});
const TAG_ID = "00000000-0000-4000-8000-0000000000a1";
const OWNER_ONE = "00000000-0000-4000-8000-0000000000b1";
const OWNER_TWO = "00000000-0000-4000-8000-0000000000b2";

describe("production prototype metrics", () => {
  it("renders exact five shared cards with real canonical counts and currency, without fake deltas", () => {
    const { container } = mount();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Produced by sessions")).toBeTruthy();
    expect(screen.getByText("Updated this week")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getByText("$0.63")).toBeTruthy();
    expect(container.textContent).not.toContain("+0%");
    expect(mocks.costs.mock.calls[0]?.[0]).toEqual(["prd", "doc"]);
  });
  it("keeps cost bounds stable across ordinary rerenders and changes bounds only with selected range", () => {
    const host = mount();
    const before = mocks.costs.mock.calls[0]?.[1];
    host.rerender(
      <ArtifactSummary
        complete
        controller={controller()}
        currentUserId="user-1"
        documents={documents}
        filterText=""
        isUnsettled={false}
        readError={false}
        readLoading={false}
        searchParams={{}}
      />
    );
    expect(serverRead(mocks.costs)?.[1]).toEqual(before);
    host.rerender(
      <ArtifactSummary
        complete
        controller={controller({
          dateDimension: { present: true, range: "all", setRange: vi.fn() },
        })}
        currentUserId="user-1"
        documents={documents}
        filterText=""
        isUnsettled={false}
        readError={false}
        readLoading={false}
        searchParams={{}}
      />
    );
    expect(serverRead(mocks.costs)?.[1]).toEqual({});
  });
  it("withholds unsettled metrics and does not request costs before a complete read", () => {
    mount({ isUnsettled: true, complete: false });
    expect(screen.queryByText("$1.25")).toBeNull();
    expect(mocks.costs.mock.calls[0]?.[2]).toEqual({ enabled: false });
    expect(mocks.summary.mock.calls[0]?.[1]).toEqual({ enabled: false });
  });
  it("does not turn omitted cost into zero", () => {
    mocks.costs.mockReturnValue({
      data: { artifacts: [] },
      isLoading: false,
      isError: false,
    });
    mount();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
  // ISS-12600: a tag filter is a server scope, not the loaded rows' ids.
  it("scopes every metric of a tag filter on the server, not to loaded rows", () => {
    const c = controller({
      filters: { ...initialArtifactFilters, tags: [TAG_ID] },
    });
    mocks.summary.mockReturnValue({
      data: { total: 1, producedByAgentSessions: 1, updatedInWindow: 1 },
      isLoading: false,
      isError: false,
    });
    mount({ controller: c, documents: documents.slice(0, 1) });
    expect(mocks.summary.mock.calls[0]?.[0].artifactIds).toBeUndefined();
    expect(mocks.summary.mock.calls[0]?.[0].tagIds).toEqual([TAG_ID]);
    expect(mocks.summary.mock.calls[0]?.[1]).toEqual({ enabled: true });
    expect(mocks.costs.mock.calls[0]?.[3]).toMatchObject({ tagIds: [TAG_ID] });
    expect(screen.getAllByText("1").length).toBe(3);
  });
});
it("keeps token-incurrence window independent from the artifact Updated filter", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  mount({
    controller: controller({
      filters: {
        ...initialArtifactFilters,
        updatedPreset: TableDatePreset.Last24h,
      },
    }),
  });
  const start = mocks.costs.mock.calls[0]?.[1].startDate;
  expect(start).toBe("2026-09-07T12:00:00.000Z");
  expect(mocks.summary.mock.calls[0]?.[0].recencyDays).toBe(1);
});
it("scopes an Unassigned display facet as no owner, never as a UUID", () => {
  const scope = artifactSummaryScope(
    controller({
      filters: {
        ...initialArtifactFilters,
        owners: [UNASSIGNED_ASSIGNEE_LABEL],
      },
    }),
    "u",
    "",
    {}
  );
  expect(scope.canSummarize).toBe(true);
  expect(scope.params.assigneeId).toBeUndefined();
  expect(scope.params.assigneeIds).toBeUndefined();
  expect(scope.params.includeUnassigned).toBe(true);
});
describe("canonical summary scopes", () => {
  it("maps mine identity and statuses to API raw enum values across document subtypes", () => {
    const result = artifactSummaryScope(
      controller({
        filters: {
          ...initialArtifactFilters,
          mineOnly: true,
          statuses: [ARTIFACT_STATUS_DETAIL.DocumentApproved],
        },
      }),
      "actual-user",
      "",
      {}
    );
    expect(result.params.assigneeId).toBe("actual-user");
    expect(result.params.status).toContain(DocumentStatus.Approved);
    expect(result.params.recencyDays).toBe(30);
  });
  // ISS-12600: owner unions and favorites are server scopes now.
  it("scopes owner unions and favorites on the server", () => {
    expect(
      artifactSummaryScope(
        controller({
          filters: {
            ...initialArtifactFilters,
            owners: [OWNER_TWO, OWNER_ONE],
          },
        }),
        "u",
        "",
        {}
      )
    ).toEqual({
      canSummarize: true,
      params: { assigneeIds: [OWNER_ONE, OWNER_TWO], recencyDays: 30 },
    });
    expect(
      artifactSummaryScope(
        controller({
          filters: { ...initialArtifactFilters, favoritesOnly: true },
        }),
        "u",
        "",
        {}
      )
    ).toEqual({
      canSummarize: true,
      params: { favoritesOnly: true, recencyDays: 30 },
    });
  });
  it("keeps a filter with no server predicate off the server scope", () => {
    expect(
      artifactSummaryScope(
        controller({
          extensionFilters: { project: { selectedValues: ["a"] } },
        }),
        "u",
        "",
        {}
      ).canSummarize
    ).toBe(false);
  });
});

afterEach(() => vi.useRealTimers());

it("does not show full-document server counts for an Issue-only view", () => {
  const c = controller({
    filters: { ...initialArtifactFilters, kinds: [ArtifactKind.Issue] },
  });
  mount({ controller: c, documents: [], complete: false });
  expect(mocks.summary.mock.calls[0]?.[1]).toEqual({ enabled: false });
  expect(mocks.costs.mock.calls[0]?.[3]).toBeUndefined();
  expect(screen.queryByText("2")).not.toBeInTheDocument();
});

describe("Issue summary authority", () => {
  it("renders Produced by sessions fourth with Issue count and full cost scope", () => {
    mount({
      artifactKind: ArtifactKind.Issue,
      controller: controller({
        dateDimension: { present: true, range: "all", setRange: vi.fn() },
        visibleMetricKeys: new Set([
          "issues",
          "total-cost",
          "median-cost",
          "metric-four",
          "metric-five",
        ]),
      }),
      searchParams: { types: [DocumentType.Feature] },
      documents: [
        createMockDocument({
          type: DocumentType.Feature,
          status: IssueStatus.Backlog,
        }),
      ],
    });
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getByText("Produced by sessions")).toBeInTheDocument();
    expect(serverRead(mocks.costs)?.[3]).toMatchObject({
      types: [DocumentType.Feature],
    });
    expect(serverRead(mocks.summary)?.[0]).toEqual({
      types: [DocumentType.Feature],
    });
    expect(screen.queryByText("Median outcome score")).not.toBeInTheDocument();
  });
  it("maps Issue status facets through IssueStatus, retaining issue subtype scope", () => {
    const scope = artifactSummaryScope(
      controller({
        dateDimension: { present: true, range: "all", setRange: vi.fn() },
        filters: {
          ...initialArtifactFilters,
          statuses: [ARTIFACT_STATUS_ROOT.Todo],
        },
      }),
      "user-1",
      "",
      { types: [DocumentType.Feature] },
      ArtifactKind.Issue
    );
    expect(scope.params.status).toContain(IssueStatus.Todo);
    expect(scope.params.status).not.toContain(DocumentStatus.Draft);
    expect(scope.params.types).toEqual([DocumentType.Feature]);
  });
});

describe("exact complete metric cohorts", () => {
  it("uses canonical matching IDs for Project and Tags filters", () => {
    const result = artifactSummaryScope(
      controller({
        filters: { ...initialArtifactFilters, tags: ["tag-a"] },
        extensionFilters: { project: { selectedValues: ["project-a"] } },
      }),
      "user-1",
      "",
      { types: [DocumentType.Feature] },
      ArtifactKind.Issue,
      ["issue-b", "issue-a", "issue-a"]
    );
    expect(result).toEqual({
      canSummarize: true,
      params: {
        types: [DocumentType.Feature],
        artifactIds: ["issue-a", "issue-b"],
      },
    });
  });
  it("retains empty exact cohorts and never widens incomplete server pages", () => {
    const c = controller({
      extensionFilters: { project: { selectedValues: ["project-a"] } },
    });
    expect(
      artifactSummaryScope(c, "user-1", "", {}, ArtifactKind.Issue, []).params
        .artifactIds
    ).toEqual([]);
    expect(
      artifactSummaryScope(c, "user-1", "", {}, ArtifactKind.Issue).canSummarize
    ).toBe(false);
  });
});

/**
 * The cards issue their server-scope read, then the (normally disabled)
 * complete-cohort fallback read, on every render (ISS-12600).
 */
function serverRead(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls.at(-2);
}
