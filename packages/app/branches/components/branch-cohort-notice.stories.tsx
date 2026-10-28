import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { BranchCohortNoticeKind } from "../lib/branch-cohort-transparency";
import { BranchCohortNotice } from "./branch-cohort-notice";

/**
 * `BranchCohortNotice` is gated by `BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY`
 * and stays absent for every non-finite-window `kind` (`Hidden`, `Complete`,
 * `Partial`, `Unavailable`) — see `resolveBranchCohortNotice`. `Updating` and
 * `UpdateFailed` are the only two kinds that render anything, both while a
 * finite-window range (Today/Last 7 days/etc.) is loading behind the
 * previous range's still-visible results.
 */
const withCohortTransparency: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

const meta = {
  title: "Composites v1.0/Branches/Branch Cohort Notice",
  component: BranchCohortNotice,
  tags: ["deprecated", "autodocs"],
  decorators: [withCohortTransparency],
  args: {
    rangeLabel: "Last 7 days",
  },
} satisfies Meta<typeof BranchCohortNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The new range's cohort is still loading. Results from the previous range
 * remain visible until it lands — this is what the user sees while it does.
 */
export const Updating: Story = {
  args: {
    model: { kind: BranchCohortNoticeKind.Updating, total: 21 },
  },
};

/** The cohort request for the new range failed; the previous range stays put. */
export const UpdateFailed: Story = {
  args: {
    model: { kind: BranchCohortNoticeKind.UpdateFailed, total: 21 },
  },
};
