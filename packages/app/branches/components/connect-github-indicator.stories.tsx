import { GatedMetricIndicatorVariant } from "@repo/app/shared/components/gated-metric-indicator";
import type { Meta, StoryObj } from "@storybook/react";
import { GitHubConnectAction } from "../../github/lib/github-connect-action";
import { ConnectGitHubIndicator } from "./connect-github-indicator";

/**
 * The canonical "connect GitHub" affordance (ISS-7866's one surviving
 * wrapper over the shared `GatedMetricIndicator`), reused across the
 * Branches KPI cards (`card`), the Branches stalled-load slot (`centered`),
 * Insights tiles, and the Sessions delivery metric card. `Card` is also
 * exercised indirectly by `SessionsSummaryCards`' signed-out stories;
 * `Centered` and `Banner` render only here, since their real hosts
 * (`insights-tile.tsx`, `insights-page.tsx`, `branches-stall-cta.tsx`) have
 * no stories of their own. The `notice` variant is gone: ISS-11274 removed
 * the Branches list and detail asks that were its only production hosts, so
 * the variant went with them rather than surviving as a Storybook-only layout.
 */
const meta = {
  title: "Primitives v1.0/Data Display/Connect GitHub Indicator",
  component: ConnectGitHubIndicator,
  tags: ["deprecated", "autodocs"],
  args: {
    connect: {
      action: GitHubConnectAction.Connect,
      onConnect: () => undefined,
    },
  },
} satisfies Meta<typeof ConnectGitHubIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A page-shell empty state, such as the Branches list with no GitHub data yet. */
export const Centered: Story = {
  args: {
    variant: GatedMetricIndicatorVariant.Centered,
  },
};

/** One prompt above a whole KPI row, such as the Insights Delivery section. */
export const Banner: Story = {
  args: {
    variant: GatedMetricIndicatorVariant.Banner,
  },
};
