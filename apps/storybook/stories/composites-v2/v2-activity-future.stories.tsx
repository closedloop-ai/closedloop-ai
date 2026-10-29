import type { User } from "@repo/api/src/types/user";
import {
  ACTIVITY_FIXTURE_LINKS,
  ACTIVITY_FIXTURE_NOW,
  ACTIVITY_QUERY_DATA,
  EMILY,
  JAKE,
  newestFirst,
  RYAN,
} from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { ActivityEntry } from "@repo/app/documents/components/artifact-activity/activity-entry";
import {
  SESSION_EXAMPLE_ROWS,
  SINGLE_ACTOR_ROWS,
} from "@repo/app/documents/components/artifact-activity/activity-example-timelines.fixtures";
import { ActivityParts } from "@repo/app/documents/components/artifact-activity/activity-parts";
import {
  ActivityTimeline,
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "@repo/app/documents/components/artifact-activity/activity-timeline";
import {
  ActivityActorAvatar,
  ActivityActorName,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-actor";
import {
  ActivityArtifactKind,
  ActivityCard,
  ActivityCardLayout,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import {
  describeActivityParts,
  resolveActivityActor,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-formatting";
import { ActivityDirectoryStatus } from "@repo/app/documents/components/feed-sidebar/sources/activity-types";
import { ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

// FUTURE (V2) — NOT FOR BUILD (ISS-12117). Explorations of what the Activity
// timeline may grow into once V1 ships and production shows which groupings
// are worth having. Nothing here is exported to the app; it is composed in
// this file from the V1 pieces, so engineering can see the direction without
// mistaking it for scope. The collapse rules are an open decision with Cosimo
// and Daveth.
//
// - Collapsed Card: the same actor's CONTINUOUS run within one day folds into
//   "Emily made 4 changes"; another actor breaks the run, and a run never spans
//   more than a day.
// - Hidden Items Break: a long middle of the history folds into "46 hidden
//   items · Load more".
// - Expanded Detail Card: one row whose summary opens into its detail (the
//   `detail` slot `ActivityEntry` documents and V1 leaves unused).
//
// Controls are disabled: each story is one fixed exploration.

const meta = {
  title: "Composites/Shared/Activity/Future (Not For Build)",
  tags: ["experimental"],
  parameters: {
    layout: "padded",
    controls: { disable: true },
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
  decorators: [
    (Story) => (
      <div
        className={`flex flex-col gap-3 ${ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS}`}
      >
        <Badge className="self-start" variant="warning">
          V2 — not for build
        </Badge>
        <Story />
      </div>
    ),
  ],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const MADE_CHANGES = /made 4 changes/;

const USERS = {
  status: ActivityDirectoryStatus.Ready,
  find: (id: string) =>
    [EMILY, JAKE, RYAN].find((user: User) => user.id === id) ?? null,
};

const EMILY_ACTOR = resolveActivityActor(
  { kind: "human", id: EMILY.id },
  USERS
);

/**
 * Emily's continuous run (four changes within a day) folded into one row that
 * opens into the V1 rows it stands for.
 */
export const CollapsedCard: Story = {
  name: "Collapsed Card",
  render: () => (
    <CollapsedRun rows={newestFirst(SINGLE_ACTOR_ROWS).slice(0, 4)} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: MADE_CHANGES });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  },
};

function CollapsedRun({
  rows,
}: Readonly<{ rows: readonly ActivityTimelineRow[] }>) {
  const [open, setOpen] = useState(false);
  const newest = rows[0];
  const createdAt =
    newest?.kind === ActivityTimelineRowKind.Activity
      ? newest.item.createdAt
      : ACTIVITY_FIXTURE_NOW;
  const Chevron = open ? ChevronDown : ChevronRight;
  // Opened, the run's own rows follow the summary in the same who, what,
  // when columns, so nothing squeezes into the summary's action column.
  return (
    <div className="flex flex-col">
      <ol className="flex flex-col">
        <li className="group/entry">
          <ActivityEntry
            actor={<ActivityActorName actor={EMILY_ACTOR} />}
            avatar={<ActivityActorAvatar actor={EMILY_ACTOR} kindGlyph />}
            createdAt={createdAt}
            now={ACTIVITY_FIXTURE_NOW}
          >
            <Button
              aria-expanded={open}
              className="h-auto gap-1 p-0 align-baseline"
              onClick={() => setOpen((value) => !value)}
              type="button"
              variant="link"
            >
              made {rows.length} changes
              <Chevron aria-hidden className="size-3.5" />
            </Button>
          </ActivityEntry>
        </li>
      </ol>
      {open ? (
        <ActivityTimeline
          className="ml-9 border-border border-l-2 pl-4"
          links={ACTIVITY_FIXTURE_LINKS}
          now={ACTIVITY_FIXTURE_NOW}
          rows={rows}
        />
      ) : null}
    </div>
  );
}

/**
 * A long history folded in the middle: the newest and oldest rows stay, the
 * rest waits behind "46 hidden items · Load more".
 */
export const HiddenItemsBreak: Story = {
  name: "Hidden Items Break",
  render: () => {
    const rows = newestFirst(SESSION_EXAMPLE_ROWS);
    return (
      <div className="flex flex-col">
        <ActivityTimeline
          artifactKind={ActivityArtifactKind.Session}
          links={ACTIVITY_FIXTURE_LINKS}
          now={ACTIVITY_FIXTURE_NOW}
          rows={rows.slice(0, 3)}
        />
        <div className="flex items-center gap-3 py-2 text-muted-foreground text-sm">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span>46 hidden items</span>
          <span aria-hidden>·</span>
          <Button size="sm" type="button" variant="outline">
            Load more
          </Button>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
        <ActivityTimeline
          artifactKind={ActivityArtifactKind.Session}
          links={ACTIVITY_FIXTURE_LINKS}
          now={ACTIVITY_FIXTURE_NOW}
          rows={rows.slice(-3)}
        />
      </div>
    );
  },
};

/**
 * One row whose summary opens into its detail: Emily's rename, with the old
 * and new names laid out in full under the line.
 */
export const ExpandedDetailCard: Story = {
  name: "Expanded Detail Card",
  render: () => <ExpandedDetail />,
};

function ExpandedDetail() {
  const [open, setOpen] = useState(true);
  const row = SESSION_EXAMPLE_ROWS[3];
  if (row?.kind !== ActivityTimelineRowKind.Activity) {
    return null;
  }
  const { parts } = describeActivityParts(row.item.event, {
    users: USERS,
    artifactKind: ActivityArtifactKind.Session,
  });
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <ActivityEntry
      actor={<ActivityActorName actor={EMILY_ACTOR} />}
      avatar={<ActivityActorAvatar actor={EMILY_ACTOR} kindGlyph />}
      createdAt={row.item.createdAt}
      detail={
        open ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <dt className="text-muted-foreground">Before</dt>
            <dd className="text-foreground">Refactor auth middleware</dd>
            <dt className="text-muted-foreground">After</dt>
            <dd className="text-foreground">Auth middleware: token refresh</dd>
          </dl>
        ) : undefined
      }
      now={ACTIVITY_FIXTURE_NOW}
    >
      <ActivityParts parts={parts} />{" "}
      <Button
        aria-expanded={open}
        aria-label="Toggle detail"
        className="size-5 p-0 align-middle"
        onClick={() => setOpen((value) => !value)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Chevron aria-hidden className="size-3.5" />
      </Button>
    </ActivityEntry>
  );
}
