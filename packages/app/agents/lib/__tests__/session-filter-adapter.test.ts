import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
  sessionFilterFacetGroups,
} from "../session-filter-adapter";
import { SESSION_STATUS_LABELS } from "../session-sort-group";

const usage = {
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
} as unknown as AgentSessionUsageSummary;

describe("sessionFilterFacetGroups", () => {
  it("returns Status and Repository groups in order", () => {
    const groups = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(groups.map((g) => g.id)).toEqual(["status", "repo"]);
    expect(groups.map((g) => g.label)).toEqual(["Status", "Repository"]);
  });

  it("derives status options from SESSION_STATUS_LABELS", () => {
    const [status] = sessionFilterFacetGroups(
      DEFAULT_SESSION_FACET_FILTERS,
      vi.fn(),
      usage
    );
    expect(status.options).toEqual(
      Object.entries(SESSION_STATUS_LABELS).map(([id, label]) => ({
        id,
        label,
      }))
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
      statuses: ["active"],
      userIds: [],
      repositories: [],
    };
    const groups = sessionFilterFacetGroups(filters, onChange, usage);

    groups
      .find((g) => g.id === "repo")
      ?.onToggle("closedloop-ai/symphony-alpha");
    expect(onChange).toHaveBeenCalledWith({
      statuses: ["active"],
      userIds: [],
      repositories: ["closedloop-ai/symphony-alpha"],
    });
  });

  it("removes an already-selected status value when toggled again", () => {
    const onChange = vi.fn();
    const filters: SessionFacetFilters = {
      statuses: ["active", "completed"],
      userIds: [],
      repositories: [],
    };
    const groups = sessionFilterFacetGroups(filters, onChange, usage);

    groups.find((g) => g.id === "status")?.onToggle("active");
    expect(onChange).toHaveBeenCalledWith({
      statuses: ["completed"],
      userIds: [],
      repositories: [],
    });
  });
});
