import type { Meta, StoryObj } from "@storybook/react";
import { BranchShellView } from "./branch-shell-view";
import { populatedDetail } from "./branch-story-metric-fixtures";

/**
 * ISS-10797: Branch detail composed on the canonical shell. Today's two tabs
 * are the Artifact and Sessions panels; Details is read-only until ISS-10995,
 * and Activity reads the live feed since ISS-10980 (these stories mount no
 * query client, so none of them selects it).
 *
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | (all) | a composed screen; each state is its own story, per the Session twin |
 */
const meta: Meta<typeof BranchShellView> = {
  title: "Surfaces v1.0/Branches/Branch Shell View",
  tags: ["deprecated"],
  component: BranchShellView,
  parameters: {
    layout: "fullscreen",
    // These composed-screen fixtures keep states in separate stories.
    controls: { disable: true },
  },
  decorators: [
    (Story) => (
      <div className="flex h-screen min-h-0 flex-col bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  backHref: "/branches",
  branchId: "b-1",
  isError: false,
  isLoading: false,
} as const;

export const Populated: Story = {
  args: { ...base, detail: populatedDetail() },
};

/** No measured diff: Changes reads empty, never `+0 −0`. */
export const WithoutMeasuredChanges: Story = {
  args: {
    ...base,
    detail: { ...populatedDetail(), additions: null, deletions: null },
  },
};

/** Absence delegates to `BranchDetailPage`, which owns all three states. */
export const Loading: Story = {
  args: { ...base, isLoading: true },
};
