import {
  type AgentComponent,
  AgentComponentKind,
} from "@repo/api/src/types/agent-component";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { userEvent, within } from "storybook/test";
import { AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../data-source/provider";
import {
  FIXTURE_COMPONENTS,
  makeComponent,
  periodOverPeriodDataSource,
} from "./agent-component-fixtures";
import { AgentsGroupedList } from "./agents-grouped-list";

/**
 * T-3.4: the DEFAULT (flag-off) Agents catalog layout — still the live
 * fallback `apps/app/.../agents/components/agents-list-host.tsx` and
 * `apps/desktop/.../agents-view.tsx` both mount whenever
 * `AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY` is off, at 719 lines and (until
 * this file) zero Storybook coverage.
 *
 * The surface takes no data props — the inventory arrives through
 * `useAgentComponentsDataSource()` — so, mirroring
 * `AgentsListSurfaceV2`'s own story file, each state here is characterised by
 * the SOURCE its decorator injects rather than by args.
 */

const meta = {
  title: "Composites v1.0/Agents/Workspace/Agents Grouped List",
  component: AgentsGroupedList,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    getComponentHref: (item: AgentComponent) => `/agents/${item.slug}`,
    persistKey: "agents:storybook-grouped-list",
  },
} satisfies Meta<typeof AgentsGroupedList>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The inventory is a full-page surface; give it a page-shaped frame to read in. */
function SurfaceFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">{children}</div>
  );
}

function sourceDecorator(dataSource: AgentComponentsDataSource): Decorator {
  return (Story) => (
    <AgentComponentsDataSourceProvider dataSource={dataSource}>
      <SurfaceFrame>
        <Story />
      </SurfaceFrame>
    </AgentComponentsDataSourceProvider>
  );
}

/** A read that never settles — the Loading state, held open. */
const PENDING_SOURCE: AgentComponentsDataSource = {
  detail: () => new Promise(() => undefined),
  honorsDateWindow: true,
  list: () => new Promise(() => undefined),
  scope: "storybook-grouped-pending",
};

/** A rejected read — the Error state, which must never read as an empty org. */
const REJECTING_SOURCE: AgentComponentsDataSource = {
  detail: () => Promise.reject(new Error("detail unused")),
  honorsDateWindow: true,
  list: () => Promise.reject(new Error("inventory read rejected")),
  scope: "storybook-grouped-error",
};

const PLUGIN_ROWS: AgentComponent[] = [
  makeComponent({
    id: "uuid-story-grouped-plugin",
    kind: AgentComponentKind.Plugin,
    name: "acme/release-notes",
    slug: "plugin::acme-release-notes",
  }),
];

const SEARCH_LABEL = "Search components";
const PLUGINS_TAB_LABEL = "Plugins";
/** A term no fixture name contains, so the filter empties the list honestly. */
const NO_MATCH_TERM = "zzz-nothing-matches";

export const Default: Story = {
  decorators: [
    sourceDecorator(
      periodOverPeriodDataSource(FIXTURE_COMPONENTS, FIXTURE_COMPONENTS)
    ),
  ],
};

export const Loading: Story = {
  decorators: [sourceDecorator(PENDING_SOURCE)],
};

export const FailedRead: Story = {
  decorators: [sourceDecorator(REJECTING_SOURCE)],
};

/** Nothing narrowing and nothing in the org. */
export const GenuineEmpty: Story = {
  decorators: [sourceDecorator(periodOverPeriodDataSource([], []))],
};

/**
 * The same zero rows, reached by a search the reader typed. Beside
 * {@link GenuineEmpty} this is the pair worth looking at: two different claims,
 * one treatment. Ported from `AgentsListSurfaceV2`'s own `FilteredEmpty` story.
 */
export const FilteredEmpty: Story = {
  decorators: [
    sourceDecorator(
      periodOverPeriodDataSource(FIXTURE_COMPONENTS, FIXTURE_COMPONENTS)
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText(SEARCH_LABEL), NO_MATCH_TERM);
  },
};

/**
 * FEA-4086: the Plugins tab is an installed-plugins inventory, so its empty
 * means "nothing is installed" and earns a composed title + description rather
 * than a fourth grey line. Ported from `AgentsListSurfaceV2`'s own
 * `PluginsInventoryEmpty` story — none of the fixture rows here are Plugin kind,
 * so switching to the tab lands on the honest install-state empty.
 */
export const PluginsInventoryEmpty: Story = {
  decorators: [
    sourceDecorator(
      periodOverPeriodDataSource(FIXTURE_COMPONENTS, FIXTURE_COMPONENTS)
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText(PLUGINS_TAB_LABEL));
  },
};

/**
 * The surface-injected `pluginsFooter` slot (desktop's plugin management panel)
 * rendered beneath the Plugins inventory. Mirrors `AgentsListSurfaceV2`'s own
 * `PluginManagementPanel` story, adapted to this component's `pluginsFooter`
 * prop instead of `pluginManagement.renderPanel`.
 */
export const PluginsFooter: Story = {
  args: {
    pluginsFooter: (
      <div className="px-4 py-6 text-muted-foreground text-sm">
        Host-supplied plugin management (install / update / uninstall).
      </div>
    ),
  },
  decorators: [
    sourceDecorator(periodOverPeriodDataSource(PLUGIN_ROWS, PLUGIN_ROWS)),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText(PLUGINS_TAB_LABEL));
  },
};

/**
 * ISS-5530: the KPI strip pinned above the scroll plane instead of inside it.
 * The strip summarizes the whole filtered population, so scrolling the table
 * right to reach the trailing columns used to drag it sideways out of view. What
 * to look at here is the height the pinned strip takes from the table. Mirrors
 * `AgentsListSurfaceV2`'s own `MetricsPinned` story.
 */
export const MetricsPinned: Story = {
  decorators: [
    sourceDecorator(
      periodOverPeriodDataSource(FIXTURE_COMPONENTS, FIXTURE_COMPONENTS)
    ),
  ],
  parameters: {
    appCore: { enabledFlags: [AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY] },
  },
};
