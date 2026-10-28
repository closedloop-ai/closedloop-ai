import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
// Shared fixtures exercise the same presentation used by Branch Sessions.
import {
  completeSessionsTrace,
  partialSessionsTrace,
  sessionsPanelDetail,
} from "../../branches/components/detail/branch-sessions-panel-fixtures";
import {
  RELATED_SESSIONS_EMPTY_MESSAGE,
  RELATED_SESSIONS_ERROR_MESSAGE,
} from "../lib/related-sessions-labels";
import { DocumentSessionsPanel } from "./document-sessions-tab";

const data: DocumentSessionsResponse = {
  detail: {
    id: "document-fixture",
    sessions: sessionsPanelDetail.sessions,
    mergedTrace: [],
    estimatedCostUsd: sessionsPanelDetail.estimatedCostUsd,
    attributedCostUsd: sessionsPanelDetail.estimatedCostUsd,
  },
  trace: completeSessionsTrace,
};

// Controls: loading and error expose host state; data is a fixed trace fixture;
// onRetry is an action. Empty and partial populations have separate stories.
const meta = {
  title: "Composites v1.0/Documents/Document Sessions Tab",
  tags: ["deprecated"],
  component: DocumentSessionsPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    data: { control: false },
    isLoading: { control: "boolean" },
    isError: { control: "boolean" },
    onRetry: { action: "retry" },
  },
  args: { data, isLoading: false, isError: false, onRetry: fn() },
} satisfies Meta<typeof DocumentSessionsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Combined session trace", { exact: false })
    ).toHaveTextContent("2 sessions");
    await expect(canvas.queryByText("LOC/$")).toBeNull();
    await expect(canvas.queryByText("PR timeline")).toBeNull();
  },
};
export const Loading: Story = { args: { data: undefined, isLoading: true } };
export const Empty: Story = {
  args: {
    data: {
      ...data,
      trace: {
        ...completeSessionsTrace,
        items: [],
        sessions: [],
        qualifyingSessionCount: 0,
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(RELATED_SESSIONS_EMPTY_MESSAGE)
    ).toBeVisible();
  },
};
export const FailedRetrieval: Story = {
  args: { isError: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      RELATED_SESSIONS_ERROR_MESSAGE
    );
  },
};
export const Partial: Story = {
  args: { data: { ...data, trace: partialSessionsTrace } },
};
export const Narrow: Story = { globals: { viewport: { value: "390-844" } } };
