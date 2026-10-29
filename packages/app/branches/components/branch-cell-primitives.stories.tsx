import { GitHubPRState } from "@repo/api/src/types/github-status";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchBehindAheadBar } from "./branch-behind-ahead-bar";
import { BranchChangesBar } from "./branch-changes-bar";
import { BranchPRBadge } from "./branch-pr-badge";

/**
 * The three shared Branches cell primitives (Epic B / B3), reused by the
 * Branches list (B4) and the Epic D detail panel. The changes bar degrades to
 * the unavailable word on null, the other two to the empty-value affordance
 * ("—") — never a fabricated 0.
 */
// A composite showcase of three primitives — no single `component` binding, so
// the render-only stories don't inherit one primitive's required args.
const meta = {
  title: "Primitives v1.0/Data Display/Tables/Branch Cell Primitives",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const PrBadgeLifecycle: Story = {
  tags: ["!manifest"],
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
      {/* ISS-8422: a PR nobody observed — the number is real, the state is not.
          Muted is also what an unrecognized state falls back to, so the two are
          told apart by the word, never the hue. */}
      <BranchPRBadge prNumber={1274} prState={null} repoShortName="web" />
      {/* No PR → empty-value affordance */}
      <BranchPRBadge prNumber={null} />
    </div>
  ),
};

/**
 * ISS-8422's word at the width it actually ships at. The lifecycle story above
 * lays out with `flex-wrap`, so every chip gets its natural width and the
 * crowding is invisible — which is how the unobserved case's first draft shipped
 * with its PR number squeezed out of the cell entirely. `pr` is a 200px track,
 * so these boxes are its 176px CONTENT width after `GridTableCell` padding.
 *
 * ISS-7362 pins the number as `shrink-0`, so what can still give here is the
 * repo prefix (first) and then the state word. Both ellipsize.
 */
export const PrBadgeUnobservedAtColumnWidth: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="flex flex-col gap-3">
      {["web", "closedloop-designer"].map((repo) => (
        <div className="w-[176px] border border-dashed" key={repo}>
          <BranchPRBadge prNumber={1274} prState={null} repoShortName={repo} />
        </div>
      ))}
      {/* The content width left at the 60px floor a user can drag a column to
          (`MIN_COLUMN_WIDTH_PX`, less the same padding). */}
      <div className="w-[36px] border border-dashed">
        <BranchPRBadge prNumber={1274} prState={null} repoShortName="web" />
      </div>
    </div>
  ),
};

/**
 * The chip inside a track NARROWER than the real "Pull request" column, which
 * ISS-8422 widened from the 150px this story was written against to 200px. The
 * ~125px box below is now a deliberately pessimistic width rather than the
 * shipped one — kept, because the claim it makes (the prefix is the only part
 * that may be elided) has to hold at every width a user can drag to, and
 * `PrBadgeUnobservedAtColumnWidth` above covers the shipped 176px content box.
 * The repo prefix is the only part that may be elided; the PR number is what
 * tells one row from the next, so it survives every width shown.
 */
export const PrBadgeNarrowColumn: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="flex w-32 flex-col gap-2 border border-dashed">
      <BranchPRBadge
        prNumber={4242}
        prState={GitHubPRState.Open}
        repoShortName="acme/frontend"
      />
      <BranchPRBadge
        prNumber={1270}
        prState={GitHubPRState.Merged}
        repoShortName="closedloop-ai/closedloop-ai"
      />
      <BranchPRBadge
        prNumber={9}
        prState={GitHubPRState.Closed}
        repoShortName="web"
      />
      {/* No repo prefix → the number is the whole label. */}
      <BranchPRBadge prNumber={331} prState={GitHubPRState.Open} />
    </div>
  ),
};

export const BehindAhead: Story = {
  tags: ["!manifest"],
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
  tags: ["!manifest"],
  render: () => (
    <div className="flex w-40 flex-col gap-3">
      <BranchChangesBar additions={261} deletions={150} />
      <BranchChangesBar additions={12} deletions={480} />
      {/* Enrichment unpopulated → unavailable word */}
      <BranchChangesBar additions={null} deletions={null} />
    </div>
  ),
};
