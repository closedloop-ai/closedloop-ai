import { SESSION_COST_FILTER_OPTIONS } from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "../../lib/session-filter-adapter";
import { createAgentSessionUsageSummaryFixture } from "./session-list-fixtures";
import { SessionsActiveFiltersBar } from "./sessions-active-filters-bar";

// ISS-5355: the project the detail-page strip links into.
const PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a07";

// A usage summary that names an Owner, several repos, and a couple of harnesses/
// models so the wrap story renders human labels (not raw ids) across many chips.
const usage = createAgentSessionUsageSummaryFixture(
  AgentSessionViewerScope.Organization,
  {
    byUser: [
      {
        userId: "user-ada",
        userName: "Ada Lovelace",
        userEmail: "ada@closedloop.ai",
        userAvatarUrl: null,
        sessionCount: 12,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
    byRepository: [
      "closedloop-ai/symphony-alpha",
      "closedloop-ai/design-system",
      "closedloop-ai/relay-host",
      "closedloop-ai/mcp-server",
      "closedloop-ai/desktop-gateway",
    ].map((repositoryFullName) => ({
      repositoryFullName,
      sessionCount: 3,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    })),
    byHarness: ["claude", "codex"].map((harness) => ({
      harness,
      sessionCount: 4,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    })),
    modelFilterOptions: ["claude-opus-4", "gpt-5.5", "claude-sonnet-4"].map(
      (model) => ({ model, sessionCount: 4 })
    ),
    byProject: [
      {
        projectId: PROJECT_ID,
        projectName: "Symphony Alpha",
        sessionCount: 9,
      },
      {
        projectId: "019f8008-1969-74f9-b056-99c13cca9a08",
        projectName: "Relay Host",
        sessionCount: 2,
      },
    ],
  }
);

// The wrap/overflow story: many facets active at once, exercising the pinned
// row's max-height scroll rather than an unbounded multi-line wrap.
const MANY_FACET_FILTERS: SessionFacetFilters = {
  ...DEFAULT_SESSION_FACET_FILTERS,
  statuses: [SESSION_STATUS.INACTIVE, SESSION_STATUS.ERROR],
  userIds: ["user-ada"],
  repositories: [
    "closedloop-ai/symphony-alpha",
    "closedloop-ai/design-system",
    "closedloop-ai/relay-host",
    "closedloop-ai/mcp-server",
    "closedloop-ai/desktop-gateway",
  ],
  harnesses: ["claude", "codex"],
  models: ["claude-opus-4", "gpt-5.5", "claude-sonnet-4"],
  costBuckets: [SESSION_COST_FILTER_OPTIONS[0].id],
};

const meta = {
  title: "App Core/Agents/Sessions/Sessions Active Filters Bar",
  component: SessionsActiveFiltersBar,
  tags: ["autodocs"],
  argTypes: {
    filters: { control: "object" },
    usage: {
      control: "object",
      description:
        "Supplies the Owner / Repository / Harness / Model labels the chips are named with.",
    },
    includeProjectFilter: {
      control: "boolean",
      description:
        "Offer the Project dimension. Off on desktop, which cannot resolve cloud projects.",
    },
    scopeUserId: {
      control: "text",
      description:
        "Out-of-facet selected-user narrower the host owns, folded in as an Owner chip.",
    },
    onFiltersChange: { control: false, table: { category: "Events" } },
    onClearAll: { control: false, table: { category: "Events" } },
    onRemoveScopeUser: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "padded" },
  // The chip labels resolve owner names through an auth-aware hook, so this bar
  // needs the app-core ports mounted. Without them every story in this file
  // throws "Auth hooks require an <AuthAdapterProvider> ancestor" on mount.
  args: {
    filters: DEFAULT_SESSION_FACET_FILTERS,
    includeProjectFilter: false,
    onClearAll: fn(),
    onFiltersChange: fn(),
    usage,
  },
} satisfies Meta<typeof SessionsActiveFiltersBar>;

export default meta;
type Story = StoryObj<typeof meta>;

function InteractiveBar({
  initial,
  includeProjectFilter,
}: {
  initial: SessionFacetFilters;
  includeProjectFilter?: boolean;
}) {
  const [filters, setFilters] = useState<SessionFacetFilters>(initial);
  return (
    <SessionsActiveFiltersBar
      filters={filters}
      includeProjectFilter={includeProjectFilter}
      onClearAll={() => setFilters(DEFAULT_SESSION_FACET_FILTERS)}
      onFiltersChange={setFilters}
      usage={usage}
    />
  );
}

// No active facets: the bar renders nothing, so the default toolbar stays clean.
export const NoActiveFilters: Story = {};

// A single active facet: one removable chip plus Clear all.
export const SingleChip: Story = {
  render: () => (
    <InteractiveBar
      initial={{
        ...DEFAULT_SESSION_FACET_FILTERS,
        statuses: [SESSION_STATUS.INACTIVE],
      }}
    />
  ),
};

// Two facets: shows the facet-then-selection order and the per-facet remove.
export const StatusAndOwner: Story = {
  render: () => (
    <InteractiveBar
      initial={{
        ...DEFAULT_SESSION_FACET_FILTERS,
        statuses: [SESSION_STATUS.INACTIVE],
        userIds: ["user-ada"],
      }}
    />
  ),
};

// Many chips at once: the row caps its height and scrolls internally instead of
// wrapping to several lines and eating the pinned toolbar's space.
export const ManyChipsWrap: Story = {
  render: () => <InteractiveBar initial={MANY_FACET_FILTERS} />,
};

// ISS-5355 — the Project facet, as it arrives from the project-detail strip's
// link: `?project=<id>&status=active`. The chip names the project by name and
// removes just that narrowing.
export const ProjectFilterFromProjectDetail: Story = {
  render: () => (
    <InteractiveBar
      includeProjectFilter={true}
      initial={{
        ...DEFAULT_SESSION_FACET_FILTERS,
        projectIds: [PROJECT_ID],
        statuses: [SESSION_STATUS.ACTIVE],
      }}
    />
  ),
};

// A Project selection whose usage row dropped out of the active date window:
// the option (and so the chip) survives on the raw id, so the filter that is
// still narrowing the list stays nameable and removable.
export const ProjectFilterOutOfRange: Story = {
  render: () => (
    <InteractiveBar
      includeProjectFilter={true}
      initial={{
        ...DEFAULT_SESSION_FACET_FILTERS,
        projectIds: ["019f8008-1969-74f9-b056-000000000000"],
      }}
    />
  ),
};

// The surface that does not offer the facet (desktop, which cannot resolve
// cloud projects): the same `projectIds` value produces no chip at all, because
// no Project filter was ever applied there.
export const ProjectFilterNotOfferedOnThisSurface: Story = {
  render: () => (
    <InteractiveBar
      initial={{
        ...DEFAULT_SESSION_FACET_FILTERS,
        projectIds: [PROJECT_ID],
        statuses: [SESSION_STATUS.ACTIVE],
      }}
    />
  ),
};
