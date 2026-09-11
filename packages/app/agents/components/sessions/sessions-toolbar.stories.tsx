import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { DATE_RANGES } from "../../../shared/lib/format-utils";
import { SESSIONS_TOGGLEABLE_COLUMNS } from "../../hooks/use-sessions-view-state";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../lib/session-filter-adapter";
import { SessionGroupBy } from "../../lib/session-grouping";
import { SessionsToolbar } from "./sessions-toolbar";

// The Sessions toolbar's states, isolated (#4480).
// ISS-5315 gave this bar the View menu's Group-by section, which is otherwise
// only reachable through a live query on a full Sessions page. (It also gave it
// a Refresh control with an idle/refreshing/disabled cycle; ISS-5975 retired
// that control once ISS-5976 restored automatic freshness, so those three
// stories went with it.) Its siblings in this directory (`sessions-table`,
// `synced-sessions-table`, `sessions-summary-cards`,
// `sessions-active-filters-bar`, `sessions-controls`) all carry a story; this
// was the one that did not.
// `AppCoreStoryProviders` mounts the auth / navigation / feature-flag / query
// ports the toolbar's children read, so the Filter popover and the owner-name
// resolver behave as they do in the shells rather than throwing on a missing
// provider.
/**
 * A toolbar row for a sessions list: a date range control, a Filter button
 * for facets like status or repository, and a View menu for showing and
 * hiding columns. Reach for it instead of building your own filter and sort
 * controls, since it is the exact same toolbar used on both the web Sessions
 * page and its desktop equivalent, so the two never drift apart. Below the
 * controls, a row of removable chips names every active filter so a narrowed
 * down list never reads as a broken column. There is no refresh button here:
 * the session list is expected to keep itself current on its own, and the
 * Group by section in the View menu only appears when you wire up both its
 * value and its change handler.
 */
const meta: Meta<typeof SessionsToolbar> = {
  title: "Composites/Sessions/Listing/Sessions Toolbar",
  component: SessionsToolbar,
  tags: ["autodocs"],
  argTypes: {
    dateRange: {
      control: { type: "radio" },
      options: DATE_RANGES,
      table: { category: "State" },
      description:
        "First-class time window. Drives the list query AND the summary metrics.",
    },
    filters: { control: "object", table: { category: "State" } },
    groupBy: {
      control: { type: "radio" },
      options: Object.values(SessionGroupBy),
      table: { category: "State" },
      description:
        "The View menu's Group by dimension. Renders only when onGroupByChange is wired too.",
    },
    scopeUserId: {
      control: "text",
      table: { category: "State" },
      description:
        "An out-of-facet selected-user narrower the host owns, surfaced in the chip row.",
    },
    visibleColumns: {
      control: false,
      table: { category: "Data" },
      description:
        "A Set of column ids, so it cannot be edited here without replacing it with a plain object.",
    },
    usage: {
      control: "object",
      table: { category: "Data" },
      description:
        "Feeds the Repository, Owner, Harness and Model facet options.",
    },
    includeProjectFilter: {
      control: "boolean",
      table: { category: "Appearance" },
      description:
        "Offer the Project facet. Web only, since desktop cannot resolve cloud projects.",
    },
    includeLinkedEntityColumns: {
      control: "boolean",
      table: { category: "Appearance" },
      description:
        "This surface renders the Owning project and Linked issues columns, so offer their View entries.",
    },
    trailing: {
      control: false,
      table: { category: "Content" },
      description: "Extra actions rendered after the built-in controls.",
    },
    onDateRangeChange: { control: false, table: { category: "Events" } },
    onFiltersChange: { control: false, table: { category: "Events" } },
    onToggleColumn: { control: false, table: { category: "Events" } },
    onClearFilters: { control: false, table: { category: "Events" } },
    onGroupByChange: {
      control: false,
      table: { category: "Events" },
      description:
        "Left unwired here so Default keeps showing the View menu WITHOUT the Group by section.",
    },
    onResetView: {
      control: false,
      table: { category: "Events" },
      description:
        "Left unwired here so the View menu keeps the shape a host without a reset actually renders.",
    },
    onRemoveScopeUser: { control: false, table: { category: "Events" } },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-5xl border-b p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    dateRange: "7d",
    filters: DEFAULT_SESSION_FACET_FILTERS,
    includeLinkedEntityColumns: false,
    includeProjectFilter: false,
    onClearFilters: fn(),
    onDateRangeChange: fn(),
    onFiltersChange: fn(),
    onToggleColumn: fn(),
    visibleColumns: new Set(SESSIONS_TOGGLEABLE_COLUMNS.map((c) => c.id)),
  },
};

export default meta;

type Story = StoryObj<typeof SessionsToolbar>;

/**
 * The bar a host wires minimally: time window, Filter, View. No Group-by
 * section — a surface that cannot band its rows omits the handlers rather than
 * rendering a control that does nothing.
 */
export const Default: Story = {};

/**
 * Group-by wired. Open "View" to see the segmented Group-by section above the
 * column toggles.
 */
export const WithGroupBy: Story = {
  args: {
    groupBy: SessionGroupBy.None,
    onGroupByChange: () => {
      // presentational
    },
  },
};

/**
 * Banding by Status. #4480: the banded column drops out of the show/hide list —
 * the band header states that value for every row, so a Status toggle here would
 * describe a column the grid is not rendering. Open "View" to see Status absent
 * from the column list while the Group-by control above reads "Status".
 */
export const GroupedByStatus: Story = {
  args: {
    groupBy: SessionGroupBy.Status,
    onGroupByChange: () => {
      // presentational
    },
  },
};

/**
 * The active-filter chip row beneath the cluster — the chrome that only appears
 * once a host supplies a narrowed scope. (ISS-6005: the read-source badge this
 * story used to showcase is a strict drop from this toolbar.)
 */
export const WithActiveFilters: Story = {
  args: {
    filters: { ...DEFAULT_SESSION_FACET_FILTERS, statuses: ["active"] },
    groupBy: SessionGroupBy.Harness,
    onGroupByChange: () => {
      // presentational
    },
  },
};

/**
 * The toolbar at a width where the control run genuinely wraps (28rem / 448px),
 * which is the case #4480 hit.
 *
 * Still the band that matters and the story to check when anyone touches this
 * row — ISS-5975 removed the Refresh control the wrap was originally fighting
 * with, so what this now pins is simply that the controls wrap cleanly onto a
 * second line instead of overflowing or colliding.
 */
export const WrappingWidth: Story = {
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
  args: {
    filters: { ...DEFAULT_SESSION_FACET_FILTERS, statuses: ["active"] },
  },
};

/**
 * BELOW the run's wrap floor (16rem / 256px), the width at which the group can
 * no longer shrink without its time-window pills sliding under the controls
 * beside them. Design review measured that overlap at ~290px before `min-w-min`
 * was added, so this pins the last-resort behavior: the run holds its floor
 * rather than letting the pills collide.
 *
 * Nothing on this page is usable at this width; the bar for it is legibility,
 * not layout beauty. `WrappingWidth` above is the case to judge.
 */
export const BelowWrapFloor: Story = {
  decorators: [
    (Story) => (
      <div className="w-full max-w-3xs">
        <Story />
      </div>
    ),
  ],
  args: {
    filters: { ...DEFAULT_SESSION_FACET_FILTERS, statuses: ["active"] },
  },
};
