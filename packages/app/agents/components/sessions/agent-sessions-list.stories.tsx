import type { Meta, StoryObj } from "@storybook/react";
import { AgentSessionsListContent } from "./agent-sessions-list";
import {
  mixedAgentSessionListFixtures,
  populatedAgentSessionListFixtures,
} from "./session-list-fixtures";

/**
 * ISS-5451: the shared sessions-list body, isolated.
 *
 * This component is the seam both shells route their query states through — the
 * web `/sessions` page and the desktop `SessionsView` each own filters,
 * pagination and hrefs, and hand the loading/empty/populated decision here. That
 * makes it the one place to check that the three states are mutually exclusive
 * and that none of them lies: loading is a skeleton (not an empty table),
 * an unavailable read is an error (not "no sessions"), and a filtered-away scope
 * says so rather than claiming the org has none.
 *
 * The empty branch delegates to `SessionsEmptyState`, whose own story file
 * covers the reason matrix in more depth; the stories here exist to prove this
 * component ROUTES to the right one from the signals its hosts actually pass.
 *
 * ISS-5697: the local `AppCoreStoryProviders` wrapper this file used to declare
 * is GONE. The preview's global decorator (`.storybook/preview.tsx`) mounts the
 * harness for every story, so the feature-flag port is already here and the
 * only decorator left below is layout. A story that needs a gated column pins
 * the flags as a PARAMETER —
 * `parameters: { appCore: { enabledFlags: ["…"] } }` — never by re-wrapping the
 * tree: a second harness replaces the preview's shared navigation port with a
 * private one (see `apps/storybook/__tests__/app-core-harness-single-mount.test.ts`).
 */
const meta = {
  title: "App Core/Agents/Agent Sessions List",
  component: AgentSessionsListContent,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="w-full p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    items: populatedAgentSessionListFixtures,
    isLoading: false,
    getSessionHref: (item) => `/sessions/${item.id}`,
  },
} satisfies Meta<typeof AgentSessionsListContent>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A populated list. */
export const Populated: Story = {};

/**
 * The mixed fixture set — rows carrying the null / unhydrated field
 * combinations the real producers emit, which is where the honest `—` renderings
 * show up.
 */
export const MixedRows: Story = {
  args: { items: mixedAgentSessionListFixtures },
};

/** The read is in flight. A skeleton, never an empty table. */
export const Loading: Story = {
  args: { isLoading: true, items: [] },
};

/** Zero rows, no filters, read succeeded — the genuinely-empty state. */
export const EmptyGenuine: Story = {
  args: {
    items: [],
    emptySignals: { isUnavailable: false, hasActiveFilters: false },
    hasConnectedAgent: true,
  },
};

/** Zero rows because the active filters exclude them all. */
export const EmptyFiltered: Story = {
  args: {
    items: [],
    emptySignals: { isUnavailable: false, hasActiveFilters: true },
    onClearFilters: () => undefined,
  },
};

/** Zero rows because the read failed — error chrome, not a false all-clear. */
export const EmptyUnavailable: Story = {
  args: {
    items: [],
    emptySignals: { isUnavailable: true, hasActiveFilters: false },
    onRetry: () => undefined,
  },
};

/**
 * The desktop local source still coming up. A quiet holding message with no
 * error chrome and no Retry.
 */
export const EmptySyncing: Story = {
  args: {
    items: [],
    emptySignals: { isUnavailable: true, hasActiveFilters: false },
    isSyncing: true,
  },
};
