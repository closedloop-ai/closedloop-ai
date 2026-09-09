import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { ExternalLinkIcon, FilterXIcon } from "lucide-react";
import { fn } from "storybook/test";
import { SessionGroupBy } from "../../lib/session-grouping";
import { SessionSortDir, SessionSortKey } from "../../lib/session-sort-group";
import { AgentSessionsListContent } from "./agent-sessions-list";
import {
  createAgentSessionListItemFixture,
  mixedAgentSessionListFixtures,
  populatedAgentSessionListFixtures,
} from "./session-list-fixtures";
import { SessionsRecoveryAction } from "./sessions-recovery-action";
import { SyncedSessionsTable } from "./synced-sessions-table";

const meta = {
  title: "App Core/Agents/Sessions/Synced Sessions Table",
  component: SyncedSessionsTable,
  tags: ["autodocs"],
  argTypes: {
    items: { control: "object", table: { category: "Data" } },
    // A `Set`, which an object control would hand back as a plain object and
    // the table would call `.has` on.
    visibleColumns: { control: false, table: { category: "Data" } },
    columnOrder: { control: "object", table: { category: "Data" } },
    emptyState: { control: false, table: { category: "Content" } },
    extraColumnLabel: { control: "text", table: { category: "Content" } },
    renderExtraColumn: { control: false, table: { category: "Content" } },
    getSessionHref: { control: false, table: { category: "Content" } },
    getIssueHref: { control: false, table: { category: "Content" } },
    sortBy: {
      control: "select",
      options: Object.values(SessionSortKey),
      description:
        "Server sort key, not the column id (Owner sorts by `user`).",
      table: { category: "State" },
    },
    sortDir: {
      control: "radio",
      options: Object.values(SessionSortDir),
      table: { category: "State" },
    },
    groupBy: {
      control: "radio",
      options: Object.values(SessionGroupBy),
      table: { category: "State" },
    },
    showLinkedEntityColumns: {
      control: "boolean",
      table: { category: "State" },
    },
    hostScroll: { control: "boolean", table: { category: "Appearance" } },
    mode: {
      control: "radio",
      options: ["auto", "compact", "expanded"],
      table: { category: "Appearance" },
    },
    onSort: { control: false, table: { category: "Events" } },
    onColumnOrderChange: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
    groupBy: SessionGroupBy.None,
    hostScroll: false,
    items: populatedAgentSessionListFixtures,
    onColumnOrderChange: fn(),
    showLinkedEntityColumns: false,
    sortBy: null,
    sortDir: SessionSortDir.Asc,
  },
} satisfies Meta<typeof SyncedSessionsTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const EmptyList: Story = {
  render: () => (
    <AgentSessionsListContent
      getSessionHref={(item) => `/sessions/${item.id}`}
      isLoading={false}
      items={[]}
    />
  ),
};

// PRD-536 §5: a connected org with zero matching rows keeps the neutral
// "filters" message.
export const EmptyWithConnectedAgent: Story = {
  render: () => (
    <AgentSessionsListContent
      getSessionHref={(item) => `/sessions/${item.id}`}
      hasConnectedAgent
      isLoading={false}
      items={[]}
    />
  ),
};

// PRD-536 §5: an org that has never connected an agent gets the onboarding CTA,
// including the host-supplied action button that routes to compute-target setup.
export const EmptyOnboarding: Story = {
  render: () => (
    <AgentSessionsListContent
      getSessionHref={(item) => `/sessions/${item.id}`}
      hasConnectedAgent={false}
      isLoading={false}
      items={[]}
      onboardingAction={<Button size="sm">Connect a compute target</Button>}
    />
  ),
};

// ISS-4534: the errored/unavailable Sessions-list state, whose single primary
// affordance is the host-supplied `SessionsRecoveryAction` recovery Link. This
// is the only state where that button is the sole way out, so it gets a canvas
// here — matching how `EmptyOnboarding` above canvases `onboardingAction`.
export const Errored: Story = {
  render: () => (
    <AgentSessionsListContent
      emptySignals={{ isUnavailable: true, hasActiveFilters: true }}
      errorRecoveryAction={
        <SessionsRecoveryAction
          href="/sessions"
          onClearFilters={() => {
            // presentational-only: the real host resets filter state here.
          }}
        />
      }
      getSessionHref={(item) => `/sessions/${item.id}`}
      isLoading={false}
      items={[]}
    />
  ),
};

export const FilteredEmpty: Story = {
  render: () => (
    <AgentSessionsListContent
      emptyState={
        <EmptyState
          className="py-12"
          description="No synced sessions match the selected filters."
          icon={FilterXIcon}
          title="No matching sessions"
        />
      }
      getSessionHref={(item) => `/sessions/${item.id}`}
      isLoading={false}
      items={[]}
    />
  ),
};

export const MixedFallbacks: Story = {
  args: {
    items: mixedAgentSessionListFixtures,
  },
};

export const OrgMonitoringArtifactColumn: Story = {
  args: {
    extraColumnLabel: "Artifact",
    getSessionHref: (item) => `/acme/sessions/${item.id}`,
    renderExtraColumn: (item) => (
      <Button asChild size="sm" variant="ghost">
        <a href={`/acme/features/${item.sourceArtifact?.slug ?? "FEA-1515"}`}>
          View
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </Button>
    ),
  },
};

export const NonOrgMonitoringNoArtifactColumn: Story = {
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
  },
};

export const AttentionStates: Story = {
  args: {
    extraColumnLabel: "State",
    renderExtraColumn: (item) => (
      <Badge variant={item.awaitingInputSince ? "warning" : "outline"}>
        {item.awaitingInputSince ? "Awaiting input" : "Synced"}
      </Badge>
    ),
  },
};

// ISS-4774 / ISS-5036: the consolidated "Syncing" Status pill. A still-uploading
// row renders ONE pill reading "Syncing" in the Status column — replacing the
// "Active" pill, not joining it — while the inline name-cell sync pills are
// dropped and liveness rides a green dot beside the session name. The second row
// is the contrast: a synced Active row keeps its ordinary "Active" pill and no
// dot, because that pill already carries liveness.
//
// The fold keys on `transcriptDisposition === "syncing"`, NOT on
// `cloudSyncState` (ISS-4846: `reconcileCloudSyncState` maps both `syncing` and
// `failedTransient` onto `pending`, so a `pending`-only fixture would either not
// fold or, worse, imply a retrying row is a healthy one). The fixture carries the
// verdict for that reason.
//
// ISS-5697: this used to carry a bare `AppCoreStoryProviders` wrapper, annotated
// as being what "resolves the flag on". It never did — the wrapper passed no
// `enabledFlags`, so it was identical to the harness default — and there is no
// flag left to resolve either way: `isSyncStateFoldActive` reads only the
// visible-column set, ISS-5366 having retired the gate to its enabled state.
// The wrapper is gone (the preview mounts the harness globally, ISS-5665) and
// the fold presentation below is unchanged.
const syncStateStoryItems = [
  createAgentSessionListItemFixture({
    id: "uploading-session",
    name: "Uploading session",
    status: "active",
    cloudSyncState: AgentSessionCloudSyncState.Pending,
    transcriptDisposition: TranscriptDisposition.Syncing,
  }),
  createAgentSessionListItemFixture({
    id: "synced-session",
    name: "Synced session",
    status: "active",
    cloudSyncState: AgentSessionCloudSyncState.Synced,
  }),
];

export const SyncingStatusPill: Story = {
  render: () => (
    <SyncedSessionsTable
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={syncStateStoryItems}
    />
  ),
};
