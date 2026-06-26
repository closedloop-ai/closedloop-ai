import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { ExternalLinkIcon, FilterXIcon } from "lucide-react";
import { AgentSessionsListContent } from "./agent-sessions-list";
import {
  mixedAgentSessionListFixtures,
  populatedAgentSessionListFixtures,
} from "./session-list-fixtures";
import { SyncedSessionsTable } from "./synced-sessions-table";

const meta = {
  title: "App Core/Agents/Synced Sessions Table",
  component: SyncedSessionsTable,
  parameters: {
    layout: "padded",
  },
  args: {
    getSessionHref: (item) => `/sessions/${item.id}`,
    items: populatedAgentSessionListFixtures,
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
