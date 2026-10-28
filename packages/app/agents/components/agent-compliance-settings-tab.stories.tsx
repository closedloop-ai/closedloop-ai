import type { ComplianceItem } from "@repo/api/src/types/analytics";
import type { Meta, StoryObj } from "@storybook/react";
import { AgentComplianceSettingsTab } from "./agent-compliance-settings-tab";

/**
 * The admin-only Settings tab (FEA-4029) for org-wide distribution compliance
 * gaps — also mounted, via the shared `AgentComplianceTable`, by the Settings
 * v2 Compliance panel. Four real render branches live in this one component:
 * a loading skeleton, an error alert, a "No compliance gaps" empty state, and
 * the populated grid, plus the grid's own truncation footer when the server
 * caps the gap list.
 *
 * The read (`useAgentComponentCompliance`) is a plain `useQuery` against
 * `GET /agent-components/compliance`, so each story drives it through
 * `parameters.appCore.apiRoutes` rather than mocking the hook — the same
 * fixture-transport seam `session-transcript-panel.stories.tsx` uses for its
 * loading/error states.
 */

const COMPLIANCE_ROUTE = "/agent-components/compliance";

const items: ComplianceItem[] = [
  {
    distributionId: "dist-rtk-mcp",
    catalogItemName: "rtk",
    kind: "mcp",
    mode: "auto_install",
    notInstalledCount: 3,
    installedButUnusedCount: 1,
    totalTargetCount: 5,
  },
  {
    distributionId: "dist-pr-review-skill",
    catalogItemName: "pr-review",
    kind: "skill",
    mode: "auto_install",
    notInstalledCount: 0,
    installedButUnusedCount: 4,
    totalTargetCount: 12,
  },
  {
    distributionId: "dist-release-notes-plugin",
    catalogItemName: "release-notes",
    kind: "plugin",
    mode: "auto_install",
    notInstalledCount: 8,
    installedButUnusedCount: 0,
    totalTargetCount: 10,
  },
];

const meta = {
  title: "Composites v1.0/Agents/General/Agent Compliance Settings Tab",
  component: AgentComplianceSettingsTab,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof AgentComplianceSettingsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first-paint state: three skeleton rows while the read is in flight. */
export const Loading: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: COMPLIANCE_ROUTE,
          respond: () => new Promise<never>(() => undefined),
        },
      ],
    },
  },
};

/** The read failed. Renders the server's own message, not a generic fallback. */
export const Errored: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: COMPLIANCE_ROUTE,
          respond: () => ({}),
          status: 500,
          error: "Compliance service is temporarily unavailable.",
        },
      ],
    },
  },
};

/**
 * Every required distribution is installed and in use — the honest "nothing to
 * fix" state, distinct from a load that hasn't run yet.
 */
export const Empty: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: COMPLIANCE_ROUTE,
          respond: () => ({ items: [], total: 0 }),
        },
      ],
    },
  },
};

/**
 * Real gaps across the three severities the grid's per-column coloring can
 * reach: mostly not-installed (red), mostly installed-but-unused (amber), and
 * a distribution nobody has picked up at all.
 */
export const Populated: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: COMPLIANCE_ROUTE,
          respond: () => ({ items, total: items.length }),
        },
      ],
    },
  },
};

/**
 * The server capped the gap list. `AgentComplianceTable`'s own truncation
 * footer names how many of the total are shown, which never renders unless the
 * response actually says `truncated: true`.
 */
export const Truncated: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: COMPLIANCE_ROUTE,
          respond: () => ({ items, total: 12, truncated: true }),
        },
      ],
    },
  },
};
