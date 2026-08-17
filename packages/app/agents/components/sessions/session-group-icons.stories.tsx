import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  buildSessionGroups,
  SESSION_GROUP_BY_LABELS,
  SessionGroupBy,
} from "../../lib/session-grouping";
import { SESSION_GROUP_ICONS } from "./session-group-icons";
import { createSessionTableRowFixture } from "./session-list-fixtures";

/**
 * ISS-5698: the "Group by" band-header icon map, rendered where it is actually
 * consumed.
 *
 * `SESSION_GROUP_ICONS` is a `Record<SessionGroupBy, ReactNode>`, not a
 * component, so there is nothing to mount on its own. The thing that reads it is
 * `GridTable`'s `groupIcon`, which hands it straight to `GroupSectionHeader`, so
 * that catalog component is what these stories mount, with the map supplying the
 * `icon` slot exactly as `sessions-table.tsx` does
 * (`groupIcon={SESSION_GROUP_ICONS[groupBy]}`).
 *
 * The map's whole job is that ONE dimension gets ONE glyph on both the web
 * Sessions table and the shared synced table. A unit test can assert three keys
 * exist. Only a render answers whether the three glyphs are actually
 * distinguishable from each other at 16px in a muted band header, which is the
 * question a reader has when they scan a banded list.
 */
const meta = {
  title: "App Core/Agents/Session Group Icons",
  component: GroupSectionHeader,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    icon: SESSION_GROUP_ICONS[SessionGroupBy.Status],
    isOpen: true,
    label: SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
    onToggle: fn(),
  },
} satisfies Meta<typeof GroupSectionHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Rows spanning every band each dimension can produce, so the composite story
 * below bands REAL data rather than a hand-written list of labels.
 *
 * Built from `createSessionTableRowFixture` (ISS-5697's one definition) with only
 * the three banded fields overridden, so a new required `SessionTableRow` field
 * lands here for free instead of being re-spelled.
 *
 * The set is chosen so each dimension exercises its fallback as well as its happy
 * path: a display-only status (`stale`, which must band under its own pill word
 * rather than being folded into Active), an empty harness (which bands as
 * "Unspecified"), and a row with no owner (which bands as "Unattributed").
 */
const BANDED_ROWS = [
  createSessionTableRowFixture({
    harness: "claude",
    id: "ses-active",
    name: "agent/refactor-auth-guard",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "user-1", name: "Daniel Ochoa" },
  }),
  createSessionTableRowFixture({
    harness: "codex",
    id: "ses-failed",
    name: "agent/migrate-session-status",
    status: SESSION_STATUS.ERROR,
    user: { id: "user-2", name: "Priya Raman" },
  }),
  createSessionTableRowFixture({
    harness: "Claude",
    id: "ses-stale",
    name: "agent/backfill-golden-sessions",
    status: DISPLAYED_SESSION_STATUS.STALE,
    user: { id: "user-1", name: "Daniel Ochoa" },
  }),
  createSessionTableRowFixture({
    harness: "",
    id: "ses-unattributed",
    name: "agent/nightly-review-crew",
    status: DISPLAYED_SESSION_STATUS.WAITING,
    user: null,
  }),
];

/** Every dimension that actually renders a band header, in View-menu order. */
const BANDED_DIMENSIONS = [
  SessionGroupBy.Status,
  SessionGroupBy.Harness,
  SessionGroupBy.Owner,
] as const;

/**
 * The collapsed story's band label, shared by its args and its `play`. The header
 * carries no test id, and the two icons inside it contribute no text, so the
 * label IS the button's accessible name and is how the play finds it.
 */
const COLLAPSED_BAND_LABEL = SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE];

/**
 * Banding on Status: a filled circle-dot, the glyph the Status facet and the
 * status pills already read as "run state". The label is the PILL's word, not the
 * stored one. `buildSessionGroups` routes through `SESSION_STATUS_LABELS`, so the
 * band and the cell beneath it cannot name one value two ways.
 */
export const Status: Story = {};

/**
 * Banding on Harness: a bot glyph. This is the one dimension whose icon has to
 * survive sitting next to a `HarnessBadge` in the row beneath it without reading
 * as a second badge, which is why it is a bare muted icon rather than a chip.
 */
export const Harness: Story = {
  args: {
    icon: SESSION_GROUP_ICONS[SessionGroupBy.Harness],
    label: "Claude",
  },
};

/**
 * Banding on Owner: a person glyph. Bands key on the user id and only LABEL with
 * the display name, so two people who happen to share a name stay two bands. The
 * header itself can only ever show the name.
 */
export const Owner: Story = {
  args: {
    icon: SESSION_GROUP_ICONS[SessionGroupBy.Owner],
    label: "Daniel Ochoa",
  },
};

/**
 * `SessionGroupBy.None` maps to `null`, and this is what that renders: chevron,
 * then label, with no icon slot and no gap left behind for one.
 *
 * No production surface reaches this. With grouping off there is no band header
 * at all, so the entry exists purely to make the `Record<SessionGroupBy,
 * ReactNode>` annotation exhaustive, which is what forces a newly added grouping
 * dimension to fail typecheck until it is given a glyph. The story pins that the
 * null is a real, laid-out state rather than a hole, so the exhaustiveness trick
 * cannot be "fixed" into an absent key.
 */
export const NoDimensionIcon: Story = {
  args: {
    icon: SESSION_GROUP_ICONS[SessionGroupBy.None],
    label: SESSION_GROUP_BY_LABELS[SessionGroupBy.None],
  },
};

/**
 * A collapsed band. The chevron flips to point right and the header reports
 * `aria-expanded="false"`, the disclosure contract (WCAG 2.1 SC 4.1.2), which is
 * the only thing telling a screen-reader user that the rows are hidden rather
 * than absent.
 *
 * The `play` clicks it, so this is a real regression test for the toggle rather
 * than a mount: the sweep executes it, and a header that stopped calling
 * `onToggle` would fail here instead of shipping a band nobody can reopen.
 */
export const Collapsed: Story = {
  args: {
    icon: SESSION_GROUP_ICONS[SessionGroupBy.Status],
    isOpen: false,
    label: COLLAPSED_BAND_LABEL,
    onToggle: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole("button", { name: COLLAPSED_BAND_LABEL });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(header);
    await expect(args.onToggle).toHaveBeenCalledTimes(1);
  },
};

/**
 * All three glyphs at once, over bands built by the real `buildSessionGroups`
 * from the real row fixtures. This is the only view that answers whether the dot,
 * the bot and the person are actually telling a reader which dimension they are
 * looking at.
 *
 * It also pins the labels the bands carry, which is where the map's value lives:
 * `error` bands as "Failed" like its pill, `stale` keeps its own word instead of
 * being folded into Active, `Claude` and `claude` are one harness, and a row with
 * no owner bands as "Unattributed" rather than vanishing.
 *
 * No counts, deliberately. `SessionsTable` passes `showGroupCount={false}`
 * because the list is server-paginated and a number here would read as the
 * population when it only ever means "on this page".
 */
export const AllDimensions: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {BANDED_DIMENSIONS.map((dimension) => (
        <BandStack dimension={dimension} key={dimension} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The band names what the PILL names, not the wire word: `error` is "Failed".
    await expect(
      canvas.getByRole("button", {
        name: SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
      })
    ).toBeInTheDocument();
    // ISS-5366: a display-only status must NOT fold into Active, or the band
    // would contradict the pill in the row beneath it.
    await expect(
      canvas.getByRole("button", {
        name: SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE],
      })
    ).toBeInTheDocument();
  },
};

/**
 * The crowding case: a long owner name in a narrow pane, which is the desktop
 * Sessions view at its default width with the rail open. The header is a single
 * flex line with no truncation of its own, so this is where a band label pushes
 * past the pane rather than eliding. Worth seeing before someone adds a count or
 * a second affordance to the right of it.
 */
export const LongBandLabel: Story = {
  args: {
    icon: SESSION_GROUP_ICONS[SessionGroupBy.Owner],
    label: "Alexandra Constantinopoulos-Whitfield (Platform Infrastructure)",
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-xs">
        <Story />
      </div>
    ),
  ],
};

/** Shared no-op for the composite story, whose headers are read, not driven. */
const noopToggle = fn();

/**
 * One dimension's real bands, captioned with the View-menu label for the
 * dimension so the glyph can be read against the word it stands for.
 */
function BandStack({
  dimension,
}: Readonly<{ dimension: (typeof BANDED_DIMENSIONS)[number] }>) {
  const bands = buildSessionGroups(BANDED_ROWS, dimension) ?? [];
  return (
    <section className="flex flex-col">
      <p className="pb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {SESSION_GROUP_BY_LABELS[dimension]}
      </p>
      {bands.map((band) => (
        <GroupSectionHeader
          icon={SESSION_GROUP_ICONS[dimension]}
          isOpen
          key={band.key}
          label={band.label}
          onToggle={noopToggle}
        />
      ))}
    </section>
  );
}
