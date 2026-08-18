import {
  SESSION_CHANGE_PRESENCE_OPTIONS,
  SESSION_COST_BUCKETS,
  SESSION_PR_ASSOCIATION_OPTIONS,
  SESSION_UNKNOWN_COST_BUCKET_ID,
} from "@repo/api/src/agent-session-filters";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "@repo/api/src/session-autonomy-tiers";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../../components/sessions/session-list-fixtures";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  hasActiveSessionFacet,
  parseSessionFacetFilterParams,
  type SessionFacetFilters,
  sessionFilterFacetGroups,
  writeSessionFacetFilterParams,
} from "../session-filter-adapter";
import { SESSION_STATUS_FILTER_OPTIONS } from "../session-status-filters";

const usage = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Self,
  {
    byUser: [
      {
        userId: "u1",
        userName: "Ada Lovelace",
        userEmail: "ada@example.com",
        userAvatarUrl: "https://img/ada.png",
        sessionCount: 3,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
    byRepository: [
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        sessionCount: 7,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        errorCount: 0,
      },
    ],
    byHarness: [
      {
        harness: "claude",
        sessionCount: 5,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
    byModel: [
      // Cost-attribution lens spans EVERY model a session used (primary plus
      // subagent). The Model facet must NOT read from here (FEA-4303): the
      // subagent-only model below must never surface as a selectable option.
      {
        model: "claude-opus-4",
        sessionCount: 4,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
      {
        model: "claude-haiku-subagent",
        sessionCount: 2,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
    // FEA-4303: the Model facet sources its options from here — the PRIMARY
    // displayed model only. A distinct value proves the facet reads this field,
    // not `byModel`.
    modelFilterOptions: [
      {
        model: "claude-opus-4",
        sessionCount: 4,
      },
    ],
  }
);

describe("sessionFilterFacetGroups", () => {
  it("returns all facet groups in order", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(groups.map((g) => g.id)).toEqual([
      "status",
      "owner",
      "autonomy",
      "harness",
      "model",
      "cost",
      "repo",
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Status",
      "Owner",
      "Autonomy",
      "Harness",
      "Model",
      "Cost",
      "Repository",
    ]);
  });

  it("derives harness and model options from the usage breakdowns", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(groups.find((g) => g.id === "harness")?.options[0]).toMatchObject({
      id: "claude",
      label: "claude",
      count: 5,
    });
    const modelOptions = groups.find((g) => g.id === "model")?.options ?? [];
    expect(modelOptions[0]).toMatchObject({
      id: "claude-opus-4",
      label: "claude-opus-4",
      count: 4,
    });
    // FEA-4303: options come from `modelFilterOptions` (primary model), NOT
    // `byModel`, so a subagent-only model in the cost breakdown is never offered
    // as a selectable filter option that the Model column could not display.
    expect(modelOptions.map((o) => o.id)).not.toContain(
      "claude-haiku-subagent"
    );
  });

  it("exposes fixed autonomy-tier and cost-bucket options", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(
      groups.find((g) => g.id === "autonomy")?.options.map((o) => o.id)
    ).toEqual(["high", "mixed", "guided", "unknown"]);
    // ISS-4481: the Cost facet exposes the numeric buckets PLUS the selectable
    // Unknown/missing-cost option, so the option set equals the displayed cost
    // states ($ figure → a numeric bucket; "—" → Unknown) with no unselectable
    // rendered state.
    expect(
      groups.find((g) => g.id === "cost")?.options.map((o) => o.id)
    ).toEqual([
      "under_1",
      "from_1_to_10",
      "from_10_to_50",
      "from_50",
      SESSION_UNKNOWN_COST_BUCKET_ID,
    ]);
  });

  it("ISS-4481: toggling the Cost Unknown option threads it through costBuckets", () => {
    const onChange = vi.fn();
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      onChange,
      usage
    );

    groups
      .find((g) => g.id === "cost")
      ?.onToggle(SESSION_UNKNOWN_COST_BUCKET_ID);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID],
    });
  });

  it("returns empty harness/model options when no usage summary is provided", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn()
    );
    expect(groups.find((g) => g.id === "harness")?.options).toEqual([]);
    expect(groups.find((g) => g.id === "model")?.options).toEqual([]);
  });

  it("toggles the autonomy and cost facet arrays independently", () => {
    const onChange = vi.fn();
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      onChange,
      usage
    );

    groups.find((g) => g.id === "autonomy")?.onToggle("high");
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      autonomyTiers: ["high"],
    });

    groups.find((g) => g.id === "cost")?.onToggle("from_50");
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      costBuckets: ["from_50"],
    });
  });

  it("always exposes the Owner facet with options derived from the byUser breakdown", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    const owner = groups.find((g) => g.id === "owner");
    expect(owner?.label).toBe("Owner");
    expect(owner?.options[0]).toMatchObject({
      id: "u1",
      label: "Ada Lovelace",
      count: 3,
      searchText: "Ada Lovelace ada@example.com",
    });
  });

  it("returns empty owner options when no usage summary is provided", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn()
    );
    // The facet is still present (unconditional), just without options.
    expect(groups.find((g) => g.id === "owner")).toBeDefined();
    expect(groups.find((g) => g.id === "owner")?.options).toEqual([]);
  });

  it("toggles the owner facet through the canonical userIds filter", () => {
    const onChange = vi.fn();
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      onChange,
      usage
    );

    groups.find((g) => g.id === "owner")?.onToggle("u1");
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      userIds: ["u1"],
    });
  });

  it("omits the Changes and Pull request facets unless the flag opts in", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(groups.find((g) => g.id === "changes")).toBeUndefined();
    expect(groups.find((g) => g.id === "pr")).toBeUndefined();
  });

  it("adds the Changes and Pull request facets before Repository when enabled", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage,
      { includeChangePrFilters: true }
    );
    expect(groups.map((g) => g.id)).toEqual([
      "status",
      "owner",
      "autonomy",
      "harness",
      "model",
      "cost",
      "changes",
      "pr",
      "repo",
    ]);
    expect(
      groups.find((g) => g.id === "changes")?.options.map((o) => o.id)
    ).toEqual(["has_changes", "no_changes"]);
    expect(groups.find((g) => g.id === "pr")?.options.map((o) => o.id)).toEqual(
      ["has_pr", "no_pr"]
    );
  });

  it("toggles the change-presence and pr-association arrays independently", () => {
    const onChange = vi.fn();
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      onChange,
      usage,
      { includeChangePrFilters: true }
    );

    groups.find((g) => g.id === "changes")?.onToggle("has_changes");
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      changePresence: ["has_changes"],
    });

    groups.find((g) => g.id === "pr")?.onToggle("no_pr");
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      prAssociation: ["no_pr"],
    });
  });

  it("derives status options from the canonical filter option contract", () => {
    const [status] = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(status.options).toEqual(
      SESSION_STATUS_FILTER_OPTIONS.map(({ value, label }) => ({
        id: value,
        label,
      }))
    );
  });

  it("includes the canonical active/inactive/error status filters (ISS-4586)", () => {
    const [status] = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );

    expect(status.options.map((option) => option.id)).toEqual(
      expect.arrayContaining([
        SESSION_STATUS.ACTIVE,
        SESSION_STATUS.INACTIVE,
        SESSION_STATUS.ERROR,
      ])
    );
  });

  it("shortens repository labels to the last path segment", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    const repo = groups.find((g) => g.id === "repo");
    expect(repo?.options[0]).toMatchObject({
      id: "closedloop-ai/symphony-alpha",
      label: "symphony-alpha",
      count: 7,
      searchText: "closedloop-ai/symphony-alpha",
    });
  });

  it("returns empty repo options when no usage summary is provided", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn()
    );
    expect(groups.find((g) => g.id === "repo")?.options).toEqual([]);
  });

  it("toggles the matching facet array and preserves the others on change", () => {
    const onChange = vi.fn();
    const filters: SessionFacetFilters = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.ACTIVE],
    };
    const groups = sessionFilterFacetGroups(filters, onChange, usage);

    groups
      .find((g) => g.id === "repo")
      ?.onToggle("closedloop-ai/symphony-alpha");
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.ACTIVE],
      repositories: ["closedloop-ai/symphony-alpha"],
    });
  });

  it("removes an already-selected status value when toggled again", () => {
    const onChange = vi.fn();
    const filters: SessionFacetFilters = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.ACTIVE, "completed"],
    };
    const groups = sessionFilterFacetGroups(filters, onChange, usage);

    groups.find((g) => g.id === "status")?.onToggle(SESSION_STATUS.ACTIVE);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: ["completed"],
    });
  });
});

// FEA-3560: the Sessions list URL mirrors the active facet selections so a
// detail→back (or reload / shared link) restores the filtered view. The generic
// codec is covered in shared/lib/__tests__/facet-filter-params.test.ts; these
// pin the Sessions param mapping itself.
describe("session facet filter URL params", () => {
  it("round-trips every facet through the URL param encoding", () => {
    const filters: SessionFacetFilters = {
      // ISS-4654 (review, #4651): both values must be LIVE facet values — a
      // retired spelling no longer round-trips, it folds (covered below).
      statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE],
      userIds: ["019c2a66-37e4-7221-9c3b-e159549f4c93"],
      repositories: ["closedloop-ai/symphony-alpha"],
      harnesses: ["claude-code"],
      models: ["claude-sonnet-5"],
      autonomyTiers: [SESSION_AUTONOMY_TIER_FILTER_OPTIONS[0].value],
      costBuckets: [SESSION_COST_BUCKETS[0].id],
      changePresence: [SESSION_CHANGE_PRESENCE_OPTIONS[0].id],
      prAssociation: [SESSION_PR_ASSOCIATION_OPTIONS[0].id],
      projectIds: ["019f8008-1969-74f9-b056-99c13cca9a07"],
    };
    const params = new URLSearchParams("page=3&userId=u1");

    writeSessionFacetFilterParams(params, filters);
    const reparsed = parseSessionFacetFilterParams(
      new URLSearchParams(params.toString())
    );

    expect(reparsed).toEqual(filters);
    // Page + selected-user params are owned elsewhere and pass through.
    expect(params.get("page")).toBe("3");
    expect(params.get("userId")).toBe("u1");
  });

  it("leaves an unrecognized status selection alone rather than coercing it onto a facet value", () => {
    // ISS-5592: nothing folds any more, so EVERY value takes this path — an
    // unknown selection stays visible and removable instead of being silently
    // narrowed onto a facet value the user never picked.
    const parsed = parseSessionFacetFilterParams(
      new URLSearchParams("status=not-a-status")
    );

    expect(parsed.statuses).toEqual(["not-a-status"]);
  });

  it("de-duplicates a repeated status selection from a saved view", () => {
    // ISS-5592: the de-dupe is all `dedupeSessionStatusFacetValues` still does.
    // Deleting the retired-fold tests left it with ZERO coverage, so it could be
    // reduced to identity and stay green (review finding). This is the guard.
    const parsed = parseSessionFacetFilterParams(
      new URLSearchParams("status=inactive&status=inactive&status=active")
    );

    expect(parsed.statuses).toEqual([
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ACTIVE,
    ]);
  });

  // ISS-4605 (stage review): a selected Owner/Repository whose usage row dropped
  // out of range must still get a properly-labelled option so the active-filter
  // chip row shows a human label, not the raw wire value (user id / full
  // org/repo). Mirrors the Model facet's out-of-range guarantee (FEA-4303).
  it("keeps an out-of-range Owner selection present, falling back to the raw id", () => {
    const groups = sessionFilterFacetGroups(
      { ...DEFAULT_SESSION_FACET_FILTERS, userIds: ["u-not-in-usage"] },
      vi.fn(),
      usage
    );
    const ownerOption = groups
      .find((g) => g.id === "owner")
      ?.options.find((o) => o.id === "u-not-in-usage");
    // No display name is recoverable for a dropped owner, so the id is the only
    // available label — but the option exists, so the chip stays removable.
    expect(ownerOption).toMatchObject({
      id: "u-not-in-usage",
      label: "u-not-in-usage",
    });
  });

  it("shortens an out-of-range Repository selection instead of leaking org/repo", () => {
    const groups = sessionFilterFacetGroups(
      {
        ...DEFAULT_SESSION_FACET_FILTERS,
        repositories: ["acme-org/out-of-range-repo"],
      },
      vi.fn(),
      usage
    );
    const repoOption = groups
      .find((g) => g.id === "repo")
      ?.options.find((o) => o.id === "acme-org/out-of-range-repo");
    // The chip shows the shortened repo name, never the full `org/repo` value.
    expect(repoOption).toMatchObject({
      id: "acme-org/out-of-range-repo",
      label: "out-of-range-repo",
    });
  });

  // FEA-4177: gates the no-facet usage dedupe — with no facet active the summary
  // read and the facet-option read describe the same scope.
  describe("hasActiveSessionFacet", () => {
    it("is false for the default (all-empty) facet set", () => {
      expect(hasActiveSessionFacet(DEFAULT_SESSION_FACET_FILTERS)).toBe(false);
    });

    it("is true when any single facet has a selection", () => {
      expect(
        hasActiveSessionFacet({
          ...DEFAULT_SESSION_FACET_FILTERS,
          repositories: ["closedloop-ai/symphony-alpha"],
        })
      ).toBe(true);
    });

    // ISS-5355: a Project selection arriving from the project-detail strip's
    // link is a narrowing facet like any other. If it were missed here the
    // Sessions page would reuse its no-facet usage read for a filtered view,
    // and every facet count would describe a wider population than the rows.
    it("is true for a Project-only selection", () => {
      expect(
        hasActiveSessionFacet({
          ...DEFAULT_SESSION_FACET_FILTERS,
          projectIds: [PROJECT_ID],
        })
      ).toBe(true);
    });
  });
});

// ISS-5355 — the Project facet. Web-only: the desktop local producer cannot
// resolve cloud projects, so the dimension is opt-in per surface rather than a
// facet that is permanently empty there.
describe("ISS-5355 Project facet", () => {
  it("is absent unless the host surface opts in", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usageWithProjects()
    );

    expect(groups.map((group) => group.id)).not.toContain("project");
  });

  it("appends Project last without reordering the existing facets", () => {
    const withoutProject = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usageWithProjects(),
      { includeChangePrFilters: true }
    );

    const withProject = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usageWithProjects(),
      { includeChangePrFilters: true, includeProjectFilter: true }
    );

    expect(withProject.map((group) => group.id)).toEqual([
      ...withoutProject.map((group) => group.id),
      "project",
    ]);
    expect(withProject.at(-1)?.label).toBe("Project");
  });

  it("derives options and counts from the usage byProject breakdown", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usageWithProjects(),
      { includeProjectFilter: true }
    );

    // Session-count desc, so the busiest project leads the list.
    expect(projectGroup(groups)?.options).toEqual([
      {
        id: PROJECT_ID,
        label: "Symphony Alpha",
        count: 9,
        searchText: "Symphony Alpha",
      },
      {
        id: OTHER_PROJECT_ID,
        label: "Relay Host",
        count: 2,
        searchText: "Relay Host",
      },
    ]);
  });

  it("offers no options when the usage read carries no project breakdown", () => {
    // The desktop-shaped usage summary omits `byProject` entirely. An absent
    // field must yield an empty option list, never a thrown read.
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage,
      { includeProjectFilter: true }
    );

    expect(projectGroup(groups)?.options).toEqual([]);
  });

  it("keeps an out-of-range Project selection present, falling back to the raw id", () => {
    // The project's usage row dropped out of the active date window. Without an
    // option the chip row could not label or remove the filter that is still
    // narrowing the list.
    const groups = sessionFilterFacetGroups(
      {
        ...DEFAULT_SESSION_FACET_FILTERS,
        projectIds: ["project-out-of-range"],
      },
      vi.fn(),
      usageWithProjects(),
      { includeProjectFilter: true }
    );

    expect(
      projectGroup(groups)?.options.find((o) => o.id === "project-out-of-range")
    ).toMatchObject({
      id: "project-out-of-range",
      label: "project-out-of-range",
    });
  });

  it("toggles projectIds and leaves every other facet untouched", () => {
    const onChange = vi.fn();
    const filters: SessionFacetFilters = {
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.ACTIVE],
    };
    const groups = sessionFilterFacetGroups(
      filters,
      onChange,
      usageWithProjects(),
      {
        includeProjectFilter: true,
      }
    );

    projectGroup(groups)?.onToggle(PROJECT_ID);

    expect(onChange).toHaveBeenCalledWith({
      ...filters,
      projectIds: [PROJECT_ID],
    });
  });

  it("removes an already-selected project when toggled again", () => {
    const onChange = vi.fn();
    const groups = sessionFilterFacetGroups(
      { ...DEFAULT_SESSION_FACET_FILTERS, projectIds: [PROJECT_ID] },
      onChange,
      usageWithProjects(),
      { includeProjectFilter: true }
    );

    projectGroup(groups)?.onToggle(PROJECT_ID);

    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      projectIds: [],
    });
  });

  it("reports the current selection so the popover renders it checked", () => {
    const groups = sessionFilterFacetGroups(
      { ...DEFAULT_SESSION_FACET_FILTERS, projectIds: [PROJECT_ID] },
      vi.fn(),
      usageWithProjects(),
      { includeProjectFilter: true }
    );

    expect(projectGroup(groups)?.selectedValues).toEqual([PROJECT_ID]);
  });

  // ISS-5283: a facet's own counts exclude its own dimension, so the counts the
  // server sends back for `byProject` while a project is selected still describe
  // every project the user could widen to. The adapter must render those counts
  // verbatim rather than re-deriving them from the selection.
  it("renders the server's self-excluding counts unchanged while a project is selected", () => {
    const groups = sessionFilterFacetGroups(
      { ...DEFAULT_SESSION_FACET_FILTERS, projectIds: [PROJECT_ID] },
      vi.fn(),
      usageWithProjects(),
      { includeProjectFilter: true }
    );

    // The unselected project keeps a non-zero count — single-select is not a
    // one-way door.
    expect(
      projectGroup(groups)?.options.find((o) => o.id === OTHER_PROJECT_ID)
        ?.count
    ).toBe(2);
  });
});

const PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a07";
const OTHER_PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a08";

function usageWithProjects() {
  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byProject: [
      { projectId: PROJECT_ID, projectName: "Symphony Alpha", sessionCount: 9 },
      {
        projectId: OTHER_PROJECT_ID,
        projectName: "Relay Host",
        sessionCount: 2,
      },
    ],
  });
}

function projectGroup(groups: ReturnType<typeof sessionFilterFacetGroups>) {
  return groups.find((group) => group.id === "project");
}
