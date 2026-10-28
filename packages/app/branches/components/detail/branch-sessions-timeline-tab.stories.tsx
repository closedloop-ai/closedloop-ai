import type { BranchTraceResult } from "@repo/api/src/types/branch-trace";
import type { Meta, StoryObj } from "@storybook/react";
import { createRef } from "react";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import {
  partialSessionsTrace,
  sessionsPanelDetail,
} from "./branch-sessions-panel-fixtures";
import { BranchSessionsTimelineTab } from "./branch-sessions-timeline-tab";

const LOADING_BRANCH_ID = "timeline-loading";
const PARTIAL_BRANCH_ID = "timeline-partial";
const scrollElementRef = createRef<HTMLDivElement>();

const partialDetail = { ...sessionsPanelDetail, id: PARTIAL_BRANCH_ID };
const partialTrace = partialSessionsTrace;

const timelineSource: BranchesDataSource = {
  scope: "timeline-state-story",
  list: () => Promise.reject(new Error("list unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  comments: () => Promise.reject(new Error("comments unused")),
  trace: (id) =>
    id === LOADING_BRANCH_ID ? pendingTrace() : Promise.resolve(partialTrace),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
  pageData: () => Promise.reject(new Error("page data unused")),
};

const meta = {
  title: "Composites v1.0/Branches/Branch Sessions Timeline Tab",
  component: BranchSessionsTimelineTab,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <BranchesDataSourceProvider dataSource={timelineSource}>
        <div className="h-[640px] w-full overflow-hidden">
          <Story />
        </div>
      </BranchesDataSourceProvider>
    ),
  ],
  args: {
    detail: partialDetail,
    scrollElementRef,
  },
} satisfies Meta<typeof BranchSessionsTimelineTab>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Lazy trace acquisition keeps the timeline geometry stable with one bounded skeleton. */
export const Loading: Story = {
  args: {
    detail: { ...partialDetail, id: LOADING_BRANCH_ID },
  },
};

/** One unavailable Session and truncated events remain explicit beside the loaded trace. */
export const TruncatedPartialSessionCoverage: Story = {};

function pendingTrace(): Promise<BranchTraceResult> {
  return new Promise(() => undefined);
}
