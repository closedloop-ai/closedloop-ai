import type { Meta, StoryObj } from "@storybook/react";
import { BranchBehindAheadBar } from "./branch-behind-ahead-bar";
import { BranchChangesBar } from "./branch-changes-bar";
import { BranchPRBadge } from "./branch-pr-badge";

/**
 * The three shared Branches cell primitives (Epic B / B3), reused by the
 * Branches list (B4) and the Epic D detail panel. Each degrades to the
 * empty-value affordance ("—") on null — never a fabricated 0.
 */
// A composite showcase of three primitives — no single `component` binding, so
// the render-only stories don't inherit one primitive's required args.
const meta = {
  title: "App Core/Branches/Cell Primitives",
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrBadgeLifecycle: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <BranchPRBadge prNumber={1270} prState="OPEN" repoShortName="web" />
      <BranchPRBadge prNumber={1271} prState="MERGED" repoShortName="web" />
      <BranchPRBadge prNumber={1272} prState="CLOSED" repoShortName="web" />
      <BranchPRBadge
        prNumber={1273}
        prState="OPEN"
        prUrl="https://github.com/acme/web/pull/1273"
        repoShortName="web"
      />
      {/* No PR → empty-value affordance */}
      <BranchPRBadge prNumber={null} />
    </div>
  ),
};

export const BehindAhead: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <BranchBehindAheadBar ahead={2} behind={0} />
      <BranchBehindAheadBar ahead={14} behind={3} />
      {/* No producer in v1 → empty-value affordance */}
      <BranchBehindAheadBar ahead={null} behind={null} />
    </div>
  ),
};

export const Changes: Story = {
  render: () => (
    <div className="flex w-40 flex-col gap-3">
      <BranchChangesBar additions={261} deletions={150} />
      <BranchChangesBar additions={12} deletions={480} />
      {/* Enrichment unpopulated → empty-value affordance */}
      <BranchChangesBar additions={null} deletions={null} />
    </div>
  ),
};
