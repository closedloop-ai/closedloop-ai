import { DocumentType } from "@repo/api/src/types/document";
import { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import { ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { ActivityBrief } from "./activity-brief";
import {
  ACTIVITY_FIXTURE_LINKS,
  ACTIVITY_FIXTURE_NOW,
  ACTIVITY_QUERY_DATA,
} from "./activity-catalog.fixtures";
import {
  DOCUMENT_EXAMPLE_ROWS,
  SESSION_EXAMPLE_ROWS,
} from "./activity-example-timelines.fixtures";

/**
 * ISS-12579 (DI-09): the Activity brief, the short history at the foot of an
 * issue's Artifact tab, below the linked work card (layout ruled on
 * ISS-12570, Nerys 2026-10-19). It reads oldest first, top down:
 *
 * - the first two events (who created the issue and what came next);
 * - everything between folds into one row, "Show N events: changed …", that
 *   opens the Activity tab (no inline expand). Comments fold with the events:
 *   they live in the comments rail (Nerys, 2026-10-21, ISS-12576);
 * - the last two events.
 *
 * It is a bordered group, like the linked work card above it. Rows are the
 * shared Activity timeline rows, so an event reads the same here and on the
 * Activity tab.
 *
 * Controls table:
 * | Prop | Control | Why |
 * |---|---|---|
 * | edge | number | rows kept at each end before the middle folds |
 * | artifactKind | select | whose feed; a Session words statuses its own way |
 * | documentType | select | the "created this …" noun and the status vocabulary |
 * | onShowActivity | action | every fold row calls it, logged in Actions |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | rows | the example timelines; each story picks its own |
 * | links | host-supplied links, fixed fixtures |
 * | now | pinned to the fixtures' clock so relative times are deterministic |
 * | className | layout passthrough for the host |
 */
const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Activity Brief",
  component: ActivityBrief,
  tags: ["preview", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
  argTypes: {
    edge: { control: { type: "number", min: 1, max: 5 } },
    artifactKind: {
      control: "select",
      options: Object.values(ActivityArtifactKind),
    },
    documentType: { control: "select", options: Object.values(DocumentType) },
    onShowActivity: { action: "showActivity" },
    rows: { control: false },
    links: { control: false },
    now: { control: false },
    className: { control: false },
  },
  args: {
    rows: DOCUMENT_EXAMPLE_ROWS,
    edge: 2,
    onShowActivity: fn(),
    artifactKind: ActivityArtifactKind.Document,
    documentType: DocumentType.Feature,
    links: ACTIVITY_FIXTURE_LINKS,
    now: ACTIVITY_FIXTURE_NOW,
    className: ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS,
  },
} satisfies Meta<typeof ActivityBrief>;

export default meta;
type Story = StoryObj<typeof meta>;

const SHOW_EVENTS_RE = /^Show \d+ events/;

/**
 * An issue's three weeks: the creation and the next event, one fold for
 * everything between (its comments included), and the last two events. The
 * fold opens the Activity tab.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const [fold, ...more] = canvas.getAllByRole("button", {
      name: SHOW_EVENTS_RE,
    });
    await expect(more).toHaveLength(0);
    const lists = canvas.getAllByRole("list", { name: "Activity" });
    await expect(lists[0]).toHaveTextContent("created this issue");
    // The middle's comments are folded: they are in the comments rail.
    await expect(
      canvas.queryByRole("link", { name: "View comment" })
    ).toBeNull();
    if (fold === undefined) {
      throw new Error("no fold row");
    }
    await userEvent.click(fold);
    await expect(args.onShowActivity).toHaveBeenCalledTimes(1);
  },
};

/**
 * A Session's history: one fold, worded with the Session vocabulary.
 */
export const Session: Story = {
  args: {
    rows: SESSION_EXAMPLE_ROWS,
    artifactKind: ActivityArtifactKind.Session,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("button", { name: SHOW_EVENTS_RE })
    ).toHaveLength(1);
  },
};

/** A short history fits both ends: every event shows and nothing folds. */
export const FewEvents: Story = {
  args: { rows: DOCUMENT_EXAMPLE_ROWS.slice(0, 4) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: SHOW_EVENTS_RE })
    ).toBeNull();
  },
};

/** The issue's brief in the dark theme. */
export const Dark: Story = {
  globals: { theme: "dark" },
};
