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
import { AgentsListSurfaceV2 } from "./agents-list-surface-v2";

/**
 * ISS-9398 — every complete state of `AgentsListSurfaceV2`, in one canvas.
 *
 * PRD-730 requires complete state stories for a mounted surface, and this one
 * needs them more than most: three of its four non-population states render the
 * SAME grey centered paragraph, differing only in the sentence. A test asserting
 * that sentence passes without anyone ever seeing that "still fetching",
 * "nothing matched your filter" and "nothing here yet" are visually
 * indistinguishable — which is the kind of thing only a canvas shows.
 *
 * The surface takes no data props; the inventory arrives through
 * `useAgentComponentsDataSource()`. So each story is characterised by the SOURCE
 * its decorator injects, and the two states that need a narrowed view are
 * reached by driving the surface's own controls in a `play` rather than by
 * seeding state the surface owns.
 */

const meta = {
  title: "Composites v1.0/Agents/Workspace/Agents List Surface V2",
  tags: ["deprecated"],
  component: AgentsListSurfaceV2,
  parameters: { layout: "fullscreen" },
  args: {
    getComponentHref: (item: AgentComponent) => `/agents/${item.slug}`,
    persistKey: "agents:storybook",
  },
} satisfies Meta<typeof AgentsListSurfaceV2>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The inventory is a full-page surface; give it a page-shaped frame to read in. */
function SurfaceFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">{children}</div>
  );
}

/**
 * ISS-5697: the app-core harness is global (`.storybook/preview.tsx`), so this
 * decorator carries only the data source and the frame. A story that needs a
 * flag sets `parameters.appCore.enabledFlags`; the rest stay closed by default.
 */
function sourceDecorator(dataSource: AgentComponentsDataSource): Decorator {
  return (Story) => (
    <AgentComponentsDataSourceProvider dataSource={dataSource}>
      <SurfaceFrame>
        <Story />
      </SurfaceFrame>
    </AgentComponentsDataSourceProvider>
  );
}

const PLUGIN_ROWS: AgentComponent[] = [
  makeComponent({
    id: "uuid-story-plugin",
    kind: AgentComponentKind.Plugin,
    name: "acme/release-notes",
    slug: "plugin::acme-release-notes",
  }),
];

/** A read that never settles — the Loading state, held open. */
const PENDING_SOURCE: AgentComponentsDataSource = {
  detail: () => new Promise(() => undefined),
  honorsDateWindow: true,
  list: () => new Promise(() => undefined),
  scope: "storybook-pending",
};

/** A rejected read — the Error state, which must never read as an empty org. */
const REJECTING_SOURCE: AgentComponentsDataSource = {
  detail: () => Promise.reject(new Error("detail unused")),
  honorsDateWindow: true,
  list: () => Promise.reject(new Error("inventory read rejected")),
  scope: "storybook-error",
};

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

/**
 * Nothing narrowing and nothing in the org — the only shape that honestly
 * claims the population is empty.
 */
export const GenuineEmpty: Story = {
  decorators: [sourceDecorator(periodOverPeriodDataSource([], []))],
};

/**
 * The same zero rows, reached by a search the reader typed. Beside
 * {@link GenuineEmpty} this is the pair worth looking at: two different claims,
 * one treatment.
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
 * than a fourth grey line.
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
 * A host that declares the plugin-management capability — desktop. The surface
 * decides that it belongs under this tab, beneath the inventory, behind that
 * rule. Web declares the capability absent and every other story here shows
 * what that looks like: nothing, not a disabled control.
 */
export const PluginManagementPanel: Story = {
  args: {
    pluginManagement: {
      renderPanel: () => (
        <div className="px-4 py-6 text-muted-foreground text-sm">
          Host-supplied plugin management (install / update / uninstall).
        </div>
      ),
    },
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
 * to look at here is the height the pinned strip takes from the table.
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
