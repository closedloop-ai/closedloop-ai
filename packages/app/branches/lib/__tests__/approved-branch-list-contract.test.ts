import {
  type BranchAnalytics,
  BranchStatus,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchListFacetAvailability,
  type BranchListFacets,
} from "@repo/api/src/types/branch-list-contract";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { PRIORITY_FILTER_VALUES } from "@repo/api/src/types/priority-filter";
import { describe, expect, it, vi } from "vitest";
import {
  bindApprovedBranchCohortAnalyticsOverFilteredRows,
  buildApprovedBranchCohortRequest,
  selectExactBranchCohortMetrics,
} from "../approved-branch-cohort";
import { bindCanonicalMetricsToFilteredRows } from "../approved-filtered-metrics";
import {
  branchFilterFacetGroups,
  branchServerFacetGroups,
  legacyBranchFilterFacetGroups,
} from "../branch-filter-adapter";
import { repositoryDisplayLabels } from "../branch-repository-display-labels";
import {
  BranchFilterFacet,
  type BranchFilters,
  BranchLastActiveRange,
  type BranchRow,
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
  lastActiveRange,
} from "../branch-row";
import {
  BranchSortDir,
  BranchSortKey,
  sortBranchRows,
} from "../branch-sort-group";
import { unavailableKpi, wireRow } from "./approved-branch-fixtures";

function row(overrides: Partial<BranchRow>): BranchRow {
  return {
    id: "branch-1",
    branchName: "feature/one",
    baseBranch: "main",
    repo: "closedloop-ai/closedloop-ai",
    owner: "Daveth Oakhurst",
    ownerKey: "github:daveth",
    collaborators: [],
    tags: [],
    tagAvailability: BranchTagAvailability.Available,
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prRepo: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: null,
    ahead: null,
    additions: 10,
    deletions: 5,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1 hour ago",
    lastActivityAt: "2026-08-05T12:00:00.000Z",
    canonicalIdentity: "artifact:branch-1",
    ...overrides,
  };
}

describe("approved Branches List contract", () => {
  it("filters owner by stable identity and ANDs collaborator, PR, and tag facets", () => {
    const matching = row({
      collaborators: [{ key: "github:kerensa", name: "Kerensa Whitlock" }],
      prNumber: 42,
      prRepo: "closedloop-ai/closedloop-ai",
      tags: [{ id: "tag-ui", name: "UI", color: "blue" }],
    });
    const filters: BranchFilters = {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["github:daveth"],
      collaborators: ["github:kerensa"],
      pullRequests: ["linked"],
      tags: ["tag-ui"],
    };

    expect(
      filterBranchRows([matching, row({ id: "branch-2" })], filters, {
        approved: true,
      }).map((item) => item.id)
    ).toEqual(["branch-1"]);
  });

  it("keeps unavailable Last active values last in both sort directions", () => {
    const unavailable = row({
      id: "missing",
      lastActivityAt: undefined,
      canonicalIdentity: "artifact:missing",
    });
    const older = row({
      id: "older",
      lastActivityAt: "2026-08-01T12:00:00.000Z",
      canonicalIdentity: "artifact:older",
    });
    const newer = row({
      id: "newer",
      lastActivityAt: "2026-08-04T12:00:00.000Z",
      canonicalIdentity: "artifact:newer",
    });

    expect(
      sortBranchRows(
        [unavailable, older, newer],
        BranchSortKey.LastActivity,
        BranchSortDir.Asc
      ).map((item) => item.id)
    ).toEqual(["older", "newer", "missing"]);
    expect(
      sortBranchRows(
        [unavailable, older, newer],
        BranchSortKey.LastActivity,
        BranchSortDir.Desc
      ).map((item) => item.id)
    ).toEqual(["newer", "older", "missing"]);
  });

  it("uses one half-open Last active bucket and rejects future or malformed values", () => {
    const now = Date.parse("2026-08-05T13:00:00.000Z");

    expect(lastActiveRange("2026-08-05T12:00:00.001Z", now)).toBe(
      BranchLastActiveRange.WithinLastHour
    );
    expect(lastActiveRange("2026-08-05T12:00:00.000Z", now)).toBe(
      BranchLastActiveRange.OneToSixHours
    );
    expect(lastActiveRange("2026-08-05T06:00:00.000Z", now)).toBe(
      BranchLastActiveRange.SevenToTwentyFourHours
    );
    expect(lastActiveRange("2026-08-04T13:00:00.000Z", now)).toBe(
      BranchLastActiveRange.OneDayOrMore
    );
    expect(lastActiveRange("2026-08-06T13:00:00.000Z", now)).toBeNull();
    expect(lastActiveRange("not-a-date", now)).toBeNull();
  });

  it("computes self-excluding facet counts over the other active facets", () => {
    const openDaniel = row({ id: "daveth", status: BranchRowStatus.Open });
    const mergedKris = row({
      id: "kerensa",
      owner: "Kerensa Whitlock",
      ownerKey: "github:kerensa",
      status: BranchRowStatus.Merged,
    });
    const groups = branchFilterFacetGroups(
      [openDaniel, mergedKris],
      {
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["github:daveth"],
        statuses: [BranchRowStatus.Open],
      },
      () => undefined,
      PRIORITY_FILTER_VALUES,
      Date.parse("2026-08-05T13:00:00.000Z")
    );
    const ownerGroup = groups.find(
      (group) => group.id === BranchFilterFacet.Owner
    );
    if (!ownerGroup || ownerGroup.kind === "range") {
      throw new Error("Owner facet missing");
    }

    expect(ownerGroup.options).toEqual([
      { id: "github:daveth", label: "Daveth Oakhurst", count: 1 },
      { id: "github:kerensa", label: "Kerensa Whitlock", count: 0 },
    ]);
  });

  /**
   * ISS-9585 (tamsinb, PR #7954). The client-mode menus are built here, over
   * the same corpus the server-mode menus describe, and were ranked by a bare
   * `localeCompare()` on the label alone — host-dependent, and with no tie-break
   * at all, so two owners sharing a display name came back in row order.
   *
   * The fixture is that tie: one label, two keys. `compareFacetOptions` ranks
   * the id by code unit, so "github:Ada" leads "github:zoe" however the rows
   * arrive. A same-label pair is the only thing that separates the shared
   * comparator from a label-only one on an `en` runner, where the collated and
   * locale orders of the LABEL agree.
   */
  it("breaks a tied owner label by id rather than by row order", () => {
    const zoe = row({
      id: "zoe",
      owner: "Sam Rivera",
      ownerKey: "github:zoe",
    });
    const ada = row({ id: "ada", owner: "Sam Rivera", ownerKey: "github:Ada" });
    const groups = branchFilterFacetGroups(
      [zoe, ada],
      DEFAULT_BRANCH_FILTERS,
      () => undefined,
      PRIORITY_FILTER_VALUES,
      Date.parse("2026-08-05T13:00:00.000Z")
    );
    const ownerGroup = groups.find(
      (group) => group.id === BranchFilterFacet.Owner
    );
    if (!ownerGroup || ownerGroup.kind === "range") {
      throw new Error("Owner facet missing");
    }

    expect(ownerGroup.options.map((option) => option.id)).toEqual([
      "github:Ada",
      "github:zoe",
    ]);
  });

  it("uses the same captured clock for selected rows and Last-active facet counts", () => {
    const now = Date.parse("2026-08-05T13:00:00.000Z");
    const withinHour = row({
      id: "within-hour",
      lastActivityAt: "2026-08-05T12:30:00.000Z",
    });
    const oneToSixHours = row({
      id: "one-to-six",
      lastActivityAt: "2026-08-05T11:59:59.999Z",
    });
    const filters = {
      ...DEFAULT_BRANCH_FILTERS,
      lastActiveRanges: [BranchLastActiveRange.WithinLastHour],
    };

    expect(
      filterBranchRows([withinHour, oneToSixHours], filters, {
        approved: true,
        now,
      }).map((item) => item.id)
    ).toEqual(["within-hour"]);

    const activityGroup = branchFilterFacetGroups(
      [withinHour, oneToSixHours],
      filters,
      () => undefined,
      PRIORITY_FILTER_VALUES,
      now
    ).find((group) => group.id === BranchFilterFacet.LastActive);
    if (!activityGroup || activityGroup.kind === "range") {
      throw new Error("Last-active facet missing");
    }
    expect(activityGroup.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: BranchLastActiveRange.WithinLastHour,
          count: 1,
        }),
        expect.objectContaining({
          id: BranchLastActiveRange.OneToSixHours,
          count: 1,
        }),
      ])
    );
  });

  it("uses compact repository labels only when they are unambiguous", () => {
    const labels = repositoryDisplayLabels([
      row({ id: "one", repo: "acme/web" }),
      row({ id: "two", repo: "closedloop/web" }),
      row({ id: "three", repo: "closedloop/api" }),
    ]);

    expect(labels.get("acme/web")).toBe("acme/web");
    expect(labels.get("closedloop/web")).toBe("closedloop/web");
    expect(labels.get("closedloop/api")).toBe("api");
  });

  it("wires every approved facet and preserves zero-count universe options", () => {
    const onChange = vi.fn();
    const rows = [
      row({
        id: "full",
        ownerKey: undefined,
        collaborators: [
          { key: "github:kerensa", name: "Kerensa Whitlock" },
          { key: "github:kerensa", name: "Kerensa Whitlock" },
        ],
        tags: [{ id: "tag-ui", name: "UI", color: "blue" }],
        hasPullRequest: true,
        prNumber: null,
        lastActivityAt: "not-a-date",
        repo: "standalone",
      }),
      row({
        id: "sparse",
        owner: "Alex",
        ownerKey: undefined,
        collaborators: undefined,
        tags: undefined,
        hasPullRequest: false,
        prNumber: null,
      }),
    ];
    const filters = {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["Daveth Oakhurst"],
      statuses: [BranchRowStatus.Open],
    };
    const groups = branchFilterFacetGroups(
      rows,
      filters,
      onChange,
      PRIORITY_FILTER_VALUES
    );

    const toggleCases = [
      [BranchFilterFacet.Name, "names"],
      [BranchFilterFacet.Owner, "owners"],
      [BranchFilterFacet.Collaborators, "collaborators"],
      [BranchFilterFacet.Status, "statuses"],
      [BranchFilterFacet.PullRequest, "pullRequests"],
      [BranchFilterFacet.LastActive, "lastActiveRanges"],
      [BranchFilterFacet.Repository, "repos"],
      [BranchFilterFacet.Tags, "tags"],
      [BranchFilterFacet.Priority, "priorities"],
    ] as const;
    for (const [facet, key] of toggleCases) {
      const group = groups.find((candidate) => candidate.id === facet);
      expect(group?.kind).not.toBe("range");
      if (!group || group.kind === "range") {
        throw new Error(`Missing toggle group: ${facet}`);
      }
      const value = group.options[0]?.id ?? "missing";
      const current: readonly string[] = filters[key];
      const next = current.includes(value)
        ? current.filter((selected) => selected !== value)
        : [...current, value];
      group.onToggle(value);
      expect(onChange).toHaveBeenLastCalledWith({
        ...filters,
        [key]: next,
      });
    }
    const changes = groups.find(
      (group) => group.id === BranchFilterFacet.Changes
    );
    expect(changes?.kind).toBe("range");
    if (changes?.kind !== "range") {
      throw new Error("Missing Changes range group");
    }
    changes.onChange({ min: 12, max: 3 });
    expect(onChange).toHaveBeenLastCalledWith({
      ...filters,
      locMin: 3,
      locMax: 3,
    });
    expect(onChange).toHaveBeenCalledTimes(groups.length);
    const collaborator = groups.find(
      (group) => group.id === BranchFilterFacet.Collaborators
    );
    const tag = groups.find((group) => group.id === BranchFilterFacet.Tags);
    const repository = groups.find(
      (group) => group.id === BranchFilterFacet.Repository
    );
    expect(collaborator?.kind === "range" ? [] : collaborator?.options).toEqual(
      [{ id: "github:kerensa", label: "Kerensa Whitlock", count: 1 }]
    );
    expect(tag?.kind === "range" ? [] : tag?.options).toEqual([
      { id: "tag-ui", label: "UI", count: 1 },
    ]);
    expect(repository?.kind === "range" ? [] : repository?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "standalone", label: "standalone" }),
      ])
    );
  });

  it("wires producer-owned server facets and legacy session counts", () => {
    const onChange = vi.fn();
    const facets = serverFacets();
    const serverGroups = branchServerFacetGroups(
      facets,
      DEFAULT_BRANCH_FILTERS,
      onChange,
      PRIORITY_FILTER_VALUES
    );
    const serverToggleCases = [
      [BranchFilterFacet.Name, "names"],
      [BranchFilterFacet.Owner, "owners"],
      [BranchFilterFacet.Collaborators, "collaborators"],
      [BranchFilterFacet.Status, "statuses"],
      [BranchFilterFacet.PullRequest, "pullRequests"],
      [BranchFilterFacet.LastActive, "lastActiveRanges"],
      [BranchFilterFacet.Repository, "repos"],
      [BranchFilterFacet.Tags, "tags"],
      [BranchFilterFacet.Priority, "priorities"],
    ] as const;
    for (const [facet, key] of serverToggleCases) {
      const group = serverGroups.find((candidate) => candidate.id === facet);
      expect(group?.kind).not.toBe("range");
      if (!group || group.kind === "range") {
        throw new Error(`Missing server toggle group: ${facet}`);
      }
      group.onToggle("value");
      expect(onChange).toHaveBeenLastCalledWith({
        ...DEFAULT_BRANCH_FILTERS,
        [key]: ["value"],
      });
    }
    const serverChanges = serverGroups.find(
      (group) => group.id === BranchFilterFacet.Changes
    );
    expect(serverChanges?.kind).toBe("range");
    if (serverChanges?.kind !== "range") {
      throw new Error("Missing server Changes range group");
    }
    serverChanges.onChange({ min: -2, max: 5 });
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_BRANCH_FILTERS,
      locMin: 0,
      locMax: 5,
    });
    expect(onChange).toHaveBeenCalledTimes(serverGroups.length);

    onChange.mockClear();
    const legacyGroups = legacyBranchFilterFacetGroups(
      [row({ sessionCount: 1 }), row({ id: "none", sessionCount: 0 })],
      DEFAULT_BRANCH_FILTERS,
      onChange
    );
    const legacyToggleCases = [
      ["status", "statuses"],
      ["owner", "owners"],
      ["repo", "repos"],
      ["session", "sessionPresence"],
    ] as const;
    for (const [facet, key] of legacyToggleCases) {
      const group = legacyGroups.find((candidate) => candidate.id === facet);
      expect(group?.kind).not.toBe("range");
      if (!group || group.kind === "range") {
        throw new Error(`Missing legacy toggle group: ${facet}`);
      }
      const value = group.options[0]?.id ?? "missing";
      group.onToggle(value);
      expect(onChange).toHaveBeenLastCalledWith({
        ...DEFAULT_BRANCH_FILTERS,
        [key]: [value],
      });
    }
    const legacyChanges = legacyGroups.find((group) => group.id === "loc");
    expect(legacyChanges?.kind).toBe("range");
    if (legacyChanges?.kind !== "range") {
      throw new Error("Missing legacy Changes range group");
    }
    legacyChanges.onChange({ min: 1, max: 2 });
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_BRANCH_FILTERS,
      locMin: 1,
      locMax: 2,
    });
    expect(onChange).toHaveBeenCalledTimes(legacyGroups.length);
  });

  it("sorts pull requests by repository then numeric PR number", () => {
    const rows = [
      row({ id: "ten", prRepo: "acme/web", prNumber: 10 }),
      row({ id: "two", prRepo: "acme/web", prNumber: 2 }),
      row({ id: "other", prRepo: "acme/api", prNumber: 9 }),
    ];

    expect(
      sortBranchRows(rows, BranchSortKey.PullRequest, BranchSortDir.Asc).map(
        (item) => item.id
      )
    ).toEqual(["other", "two", "ten"]);
  });

  it("preserves canonical cards without facets and fails unsupported filtered history closed", () => {
    const analytics = canonicalAnalytics();
    const wireRows = [wireRow()];

    expect(
      bindCanonicalMetricsToFilteredRows(
        analytics,
        wireRows,
        DEFAULT_BRANCH_FILTERS
      )
    ).toBe(analytics);

    const narrowed = bindCanonicalMetricsToFilteredRows(
      analytics,
      wireRows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      [wireRows[0]!, wireRow({ id: "branch-2" })]
    );
    expect(narrowed.canonicalMetrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
    expect(narrowed.canonicalMetrics?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 3.5,
    });
    expect(narrowed.canonicalMetrics?.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(narrowed.canonicalMetrics?.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("rebinds the range-scoped companion to the SAME filtered population", () => {
    // ISS-7363: the `...metrics` spread would otherwise carry the producer's
    // UNFILTERED companion through, so a gated tile would report the whole
    // cohort while the four beside it report the filtered one.
    const analytics = canonicalAnalytics();
    const producerCohortCount = 207;
    analytics.canonicalMetrics = {
      ...analytics.canonicalMetrics,
      windowScoped: {
        activeBranches: {
          current: {
            state: BranchMetricAvailability.Complete,
            value: producerCohortCount,
          },
        },
        aiSpendUsd: {
          current: {
            state: BranchMetricAvailability.Complete,
            value: 20.39,
          },
        },
      },
    } as BranchListMetricBundle;
    const wireRows = [wireRow()];

    const narrowed = bindCanonicalMetricsToFilteredRows(
      analytics,
      wireRows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      [wireRows[0]!, wireRow({ id: "branch-2" })]
    );

    expect(
      narrowed.canonicalMetrics?.windowScoped?.activeBranches.current
    ).toEqual(narrowed.canonicalMetrics?.activeBranches.current);
    expect(narrowed.canonicalMetrics?.windowScoped?.aiSpendUsd.current).toEqual(
      narrowed.canonicalMetrics?.aiSpendUsd.current
    );
    // Positive sibling: the producer's cohort figure is what got replaced.
    expect(
      narrowed.canonicalMetrics?.windowScoped?.activeBranches.current.value
    ).not.toBe(producerCohortCount);
  });

  it("deduplicates filtered AI spend without applying branch attribution", () => {
    const first = wireRow();

    const narrowed = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      [first],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 8 },
      [first, wireRow({ id: "branch-2" })]
    );

    expect(narrowed.canonicalMetrics?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 8,
    });
  });

  it("keeps canonical cards when a selected facet does not narrow the cohort", () => {
    const analytics = canonicalAnalytics();
    const rows = [wireRow()];

    expect(
      bindCanonicalMetricsToFilteredRows(
        analytics,
        rows,
        { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
        { session1: 3.5 },
        rows
      )
    ).toBe(analytics);
  });

  it("builds one stable exact-cohort request for the narrowed 30-day List", () => {
    const selected = wireRow({ id: "branch-b" });
    const request = buildApprovedBranchCohortRequest({
      filteredRows: [selected],
      unfilteredRows: [wireRow({ id: "branch-a" }), selected],
      filters: { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      dateRange: "30d",
      startDate: "2026-07-06T12:00:00.000Z",
      endDate: "2026-08-05T12:00:00.000Z",
    });

    expect(request).toEqual({
      branchIds: ["branch-b"],
      startDate: "2026-07-06T12:00:00.000Z",
      endDate: "2026-08-05T12:00:00.000Z",
    });
  });

  it("preserves the exact List boundary across a DST-crossing window", () => {
    const selected = wireRow({ id: "branch-b" });

    expect(
      buildApprovedBranchCohortRequest({
        filteredRows: [selected],
        unfilteredRows: [wireRow({ id: "branch-a" }), selected],
        filters: { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
        dateRange: "30d",
        startDate: "2026-10-21T17:00:00.000Z",
        endDate: "2026-11-20T18:00:00.000Z",
      })
    ).toEqual({
      branchIds: ["branch-b"],
      startDate: "2026-10-21T17:00:00.000Z",
      endDate: "2026-11-20T18:00:00.000Z",
    });
  });

  it("keeps an empty filtered cohort on the truthful fallback", () => {
    const filters = {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["github:daveth"],
    };
    const selected = wireRow();
    expect(
      buildApprovedBranchCohortRequest({
        filteredRows: [],
        unfilteredRows: [selected],
        filters,
        dateRange: "all",
        startDate: undefined,
        endDate: undefined,
      })
    ).toBeNull();
  });

  it("requests exact metrics when active filters retain every known row", () => {
    const selected = wireRow();
    expect(
      buildApprovedBranchCohortRequest({
        filteredRows: [selected],
        unfilteredRows: [selected],
        filters: { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
        dateRange: "all",
        startDate: undefined,
        endDate: undefined,
      })
    ).toEqual({ branchIds: [selected.id] });
  });

  it("builds one stable exact request for a narrowed 101-Branch cohort", () => {
    const filteredRows = Array.from({ length: 101 }, (_, index) =>
      wireRow({ id: `branch-${100 - index}` })
    );

    const request = buildApprovedBranchCohortRequest({
      filteredRows,
      unfilteredRows: [...filteredRows, wireRow({ id: "branch-extra" })],
      filters: { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      dateRange: "all",
      startDate: undefined,
      endDate: undefined,
    });

    expect(request?.branchIds).toHaveLength(101);
    expect(request?.branchIds).toEqual(
      [...new Set(filteredRows.map((item) => item.id))].sort()
    );
  });

  it("uses producer metrics only when every requested Branch identity matched", () => {
    const request = { branchIds: ["branch-1"] };
    const metrics = canonicalAnalytics().canonicalMetrics!;

    expect(
      selectExactBranchCohortMetrics(request, {
        matchedBranchIds: ["branch-1"],
        canonicalMetrics: metrics,
      })
    ).toBe(metrics);
    expect(
      selectExactBranchCohortMetrics(request, {
        matchedBranchIds: [],
        canonicalMetrics: { ...metrics, cohortSize: 0 },
      })
    ).toBeNull();
  });

  it("preserves a valid producer's partial values and comparison evidence", () => {
    const analytics = canonicalAnalytics();
    const producerMetrics: BranchListMetricBundle = {
      ...analytics.canonicalMetrics!,
      aiSpendUsd: {
        current: {
          state: BranchMetricAvailability.Partial,
          value: 4.25,
          coverage: { included: 2, total: 3 },
          disclosure: BranchMetricDisclosure.CostIncomplete,
        },
        comparison: {
          label: BranchMetricComparisonLabel.MonthOverMonth,
          priorWindow: {
            startAt: "2026-06-06T00:00:00.000Z",
            endAt: "2026-07-06T00:00:00.000Z",
          },
          deltaPct: {
            state: BranchMetricAvailability.Partial,
            value: 25,
            coverage: { included: 1, total: 2 },
            disclosure: BranchMetricDisclosure.CostIncomplete,
          },
        },
      },
    };

    // ISS-10734 repoint: the exact-cohort branch runs BEFORE any fallback, so
    // this case reads the same through either binder.
    const bound = bindApprovedBranchCohortAnalyticsOverFilteredRows({
      analytics,
      filteredRows: [wireRow()],
      unfilteredRows: [wireRow(), wireRow({ id: "branch-2" })],
      filters: { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      sessionCostUsd: { session1: 8 },
      request: { branchIds: ["branch-1"] },
      response: {
        matchedBranchIds: ["branch-1"],
        canonicalMetrics: producerMetrics,
      },
    });

    expect(bound.analytics?.canonicalMetrics).toBe(producerMetrics);
    expect(bound.analytics?.canonicalMetrics?.aiSpendUsd).toEqual(
      producerMetrics.aiSpendUsd
    );
  });

  /**
   * ISS-5714 (review thread). Both shells derived "a filter is why there is no
   * comparison" from `bound !== analytics`, and this producer mints a NEW OBJECT
   * on the exact-cohort path too — so a card whose delta came back unavailable
   * from the PRODUCER, for a genuine data gap, was captioned "Comparisons aren't
   * available while filters are applied". The flag now reports the one thing that
   * caption asserts.
   *
   * ISS-10734 narrowed what these cases pin, but not to nothing. No case here
   * reaches a true any more, because the fallback that set the flag is retired
   * and `RECOMPUTE_FALLBACK.blamesFilter` is false. The exact-cohort arm still
   * returns its OWN `false` in `approved-branch-cohort.ts` — that literal IS the
   * ISS-5714 fix, and the first case is what reddens when it flips. The second
   * case takes the declined-fallback arm, which short-circuits on object
   * identity before `blamesFilter` is read, so the flag there is unfalsifiable;
   * the APPLIED fallback arm, where a `blamesFilter` flip is visible, is pinned
   * by `filtered-cohort-recompute.test.ts`.
   */
  describe("comparison suppression provenance", () => {
    const NARROWING = {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["github:daveth"],
    };

    it("does not blame the filter when the exact-cohort producer answered", () => {
      const analytics = canonicalAnalytics();
      const selected = wireRow();
      const request = { branchIds: [selected.id] };
      // A producer bundle whose OWN delta is unavailable, for a data reason.
      const producerMetrics: BranchListMetricBundle = {
        ...analytics.canonicalMetrics!,
        cohortSize: 1,
        medianPrSize: {
          current: { state: BranchMetricAvailability.Complete, value: 148 },
          comparison: {
            label: BranchMetricComparisonLabel.MonthOverMonth,
            priorWindow: {
              startAt: "2026-06-06T00:00:00.000Z",
              endAt: "2026-07-06T00:00:00.000Z",
            },
            deltaPct: {
              state: BranchMetricAvailability.Unavailable,
              value: null,
            },
          },
        },
      };

      const bound = bindApprovedBranchCohortAnalyticsOverFilteredRows({
        analytics,
        filteredRows: [selected],
        unfilteredRows: [selected, wireRow({ id: "branch-2" })],
        filters: NARROWING,
        request,
        response: {
          matchedBranchIds: [selected.id],
          canonicalMetrics: producerMetrics,
        },
      });

      // The producer's metrics are what the cards render...
      expect(bound.analytics?.canonicalMetrics).toBe(producerMetrics);
      // ...and a NEW OBJECT came back, which is exactly the signal the shells
      // used to read. It must not be the one that turns the caption on.
      expect(bound.analytics).not.toBe(analytics);
      expect(bound.comparisonSuppressedByFilter).toBe(false);
    });

    it("does not blame the filter when a facet is active but narrows nothing", () => {
      const analytics = canonicalAnalytics();
      const rows = [wireRow()];
      const bound = bindApprovedBranchCohortAnalyticsOverFilteredRows({
        analytics,
        filteredRows: rows,
        unfilteredRows: rows,
        filters: NARROWING,
        request: null,
        response: null,
      });

      expect(bound.analytics).toBe(analytics);
    });
  });

  // ISS-4737, approved-List arm. The cohort here IS priced — `session1` carries a
  // real `0`, which is a different state from an ABSENT key — and the binder used
  // to key availability on "did any priced session contribute", so it returned a
  // Complete `0` that the card rendered as "$0": a claim the work was free. The
  // shared `reportableSpendUsd` rule collapses an exact zero to no-figure, so this
  // fails against the pre-fix binder and passes with it. The three other producers
  // of this card already call that rule; this was the fourth.
  it("does not fabricate zero spend for a cohort priced to exactly zero", () => {
    const selected = wireRow({ sessionIds: ["session1"] });

    const narrowed = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 0 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(narrowed.canonicalMetrics?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.NoData,
      value: null,
    });
  });

  it("does not fabricate zero spend for a selected cohort with no sessions", () => {
    const selected = wireRow({ sessionIds: [] });
    const narrowed = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      {},
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(narrowed.canonicalMetrics?.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  // The MIRROR of the zero-spend rule above, and deliberately its opposite. A
  // spend of exactly $0 is an ABSENCE of a figure (ISS-4737), so it collapses to
  // `NoData`; a COUNT of exactly 0 is a real, knowable answer — "every branch in
  // this subset is merged, none are active" — so it must stay `Complete` with a
  // rendered `0`. Routing the count through the spend path's availability rule
  // would render a truthful zero as "No data"/"—", which is the same dishonesty
  // as `$0` pointed the other way. This test fails the moment that happens.
  it("reports a real zero for a filtered cohort with no active branches", () => {
    const selected = wireRow({ status: BranchStatus.Merged });
    const narrowed = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, statuses: [BranchRowStatus.Merged] },
      { session1: 0 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(narrowed.canonicalMetrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 0,
    });
  });

  it("fails filtered Active branches closed for an unknown wire status", () => {
    const selected = wireRow({ status: "future" as BranchStatus });
    const narrowed = bindCanonicalMetricsToFilteredRows(
      canonicalAnalytics(),
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(narrowed.canonicalMetrics?.activeBranches.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

function serverFacets(): BranchListFacets {
  const facet = {
    availability: BranchListFacetAvailability.Complete,
    options: [{ id: "value", label: "Value", count: 1 }],
  };
  return {
    names: facet,
    owners: facet,
    collaborators: facet,
    statuses: facet,
    pullRequests: facet,
    lastActiveRanges: facet,
    repositories: facet,
    tags: facet,
  };
}

function canonicalAnalytics(): BranchAnalytics {
  const metric = {
    current: { state: BranchMetricAvailability.Complete, value: 1 } as const,
  };
  const canonicalMetrics: BranchListMetricBundle = {
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    window: {
      startAt: "2026-07-06T00:00:00.000Z",
      endAt: "2026-08-05T00:00:00.000Z",
    },
    cohortSize: 1,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-08-05T12:00:00.000Z",
    },
    activeBranches: metric,
    locPerDollar: metric,
    medianPrSize: metric,
    aiSpendUsd: metric,
    mergeRatePct: metric,
  };
  return {
    viewerScope: BranchViewerScope.Self,
    canonicalMetrics,
    medianPrSize: unavailableKpi(),
    mergeRate: unavailableKpi(),
    medianTimeToMergeMs: unavailableKpi(),
    activePrCount: unavailableKpi(),
    mergedCount: unavailableKpi(),
    leadTimeForChangeMs: unavailableKpi(),
    locPerDollar: unavailableKpi(),
    totalSpendUsd: unavailableKpi(),
    activeBranchCount: unavailableKpi(),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: "unavailable",
    },
  };
}
