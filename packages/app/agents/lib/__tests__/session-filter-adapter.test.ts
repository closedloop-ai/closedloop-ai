import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../../components/sessions/session-list-fixtures";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
  sessionFilterFacetGroups,
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
      {
        model: "claude-opus-4",
        sessionCount: 4,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
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
      "autonomy",
      "harness",
      "model",
      "cost",
      "repo",
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Status",
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
    expect(groups.find((g) => g.id === "model")?.options[0]).toMatchObject({
      id: "claude-opus-4",
      label: "claude-opus-4",
      count: 4,
    });
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
    expect(
      groups.find((g) => g.id === "cost")?.options.map((o) => o.id)
    ).toEqual(["under_1", "from_1_to_10", "from_10_to_50", "from_50"]);
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

  it("includes the requested active, completed, and abandoned status filters", () => {
    const [status] = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );

    expect(status.options.map((option) => option.id)).toEqual(
      expect.arrayContaining([
        SESSION_STATUS.ACTIVE,
        SESSION_STATUS.COMPLETED,
        SESSION_STATUS.ABANDONED,
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
      statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.COMPLETED],
    };
    const groups = sessionFilterFacetGroups(filters, onChange, usage);

    groups.find((g) => g.id === "status")?.onToggle(SESSION_STATUS.ACTIVE);
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      statuses: [SESSION_STATUS.COMPLETED],
    });
  });
});
