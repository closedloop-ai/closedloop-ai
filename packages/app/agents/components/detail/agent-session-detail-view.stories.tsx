import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  emptyAgentsAgentSessionDetailFixture,
  errorChainAgentSessionDetailFixture,
  longContentAgentSessionDetailFixture,
  noErrorAgentSessionDetailFixture,
  nullDateAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "./agent-session-detail-fixtures";
import { AgentSessionDetailView } from "./agent-session-detail-view";

const meta: Meta<typeof AgentSessionDetailView> = {
  title: "App Core/Agents/Session Detail",
  component: AgentSessionDetailView,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <AppCoreStoryProviders>
        <div className="flex h-screen min-h-0 flex-col bg-background">
          <Story />
        </div>
      </AppCoreStoryProviders>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: {
    backHref: "/sessions",
    isLoading: true,
  },
};

export const NotFound: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
  },
};

export const PopulatedHierarchyTimeline: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const PopulatedToolFlowInitialTab: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const PopulatedEffectivenessInitialTab: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const EmptyAgents: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: emptyAgentsAgentSessionDetailFixture,
  },
};

export const NoError: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: noErrorAgentSessionDetailFixture,
  },
};

export const ErrorChain: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: errorChainAgentSessionDetailFixture,
  },
};

export const RetryErrorSafe: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
  },
};

export const StaleRefetchWithData: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: populatedAgentSessionDetailFixture,
  },
};

export const LongContent: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: longContentAgentSessionDetailFixture,
  },
};

export const NullDate: Story = {
  args: {
    backHref: "/sessions",
    isLoading: false,
    session: nullDateAgentSessionDetailFixture,
  },
};
