import { ActivityFeedActorKind } from "@repo/api/src/types/artifact-activity-feed";
import { DocumentType } from "@repo/api/src/types/document";
import type { User } from "@repo/api/src/types/user";
import {
  ACTIVITY_CATALOG,
  ATLAS,
  C02_ACTOR_VARIANTS,
  EMILY,
  FRONTEND_TAG,
  JAKE,
  LONG_VALUE_ROW,
  MISSING_USER_ROW,
  ORION,
  RYAN,
} from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { ActivityParts } from "@repo/app/documents/components/artifact-activity/activity-parts";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "@repo/app/documents/components/artifact-activity/activity-timeline";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ActivityActor } from "./activity-actor";
import { ActivityCardView } from "./activity-card-view";
import {
  type ActivityLookups,
  describeActivityParts,
} from "./activity-formatting";
import { ActivityDirectoryStatus } from "./activity-types";

/**
 * The comments rail's look of an activity row, and its presentational contract
 * the string-asserting unit tests cannot see: that long values truncate rather
 * than wrap, that a pending name holds its place, that the pills sit in the
 * phrase, and that a renamed title stays inside the rail at dark and light
 * (PR #4329 review, whitlockk). ISS-12117: the headline is the adapter's phrase,
 * the same wording the Activity tab shows (one adapter, two looks).
 *
 * Three of these states are all but unreachable on demand in the running app —
 * a lookup mid-flight, a member who has left, and a title long enough to
 * truncate — which is most of the argument for pinning them here. The view
 * takes an already-resolved row and an actor slot, so nothing in this file
 * needs a query provider.
 */

/**
 * The default actor slot: a REAL resolved-human `ActivityActor`, not a bare
 * name span.
 *
 * It used to be the span, and that quietly broke the one comparison this file
 * exists to support — `SystemActor` below claims a non-human row now spends the
 * same visual budget as a human row, which is uncheckable if no story in the
 * file renders a human row as production draws it (ISS-5972 design pass).
 */
const HUMAN_USER = {
  id: "user_b",
  firstName: "Dana",
  lastName: "Reed",
  email: "demily@example.com",
} as User;

const ACTOR = (
  <ActivityActor
    actor={{ kind: ActivityFeedActorKind.Human, id: HUMAN_USER.id }}
    directory={{
      status: ActivityDirectoryStatus.Ready,
      find: (id) => (id === HUMAN_USER.id ? HUMAN_USER : null),
    }}
  />
);

/**
 * The de-cluttered non-human actor slot (ISS-5767 / ISS-5972), rendered by the
 * REAL `ActivityActor` rather than a copy of its markup. Copying it would pin a
 * snapshot that cannot follow the component — the precise failure the sibling
 * story file names, and the reason this drift survived the last design pass.
 */
const SYSTEM_ACTOR = (
  <ActivityActor
    actor={{ kind: ActivityFeedActorKind.System, id: null }}
    directory={{ status: ActivityDirectoryStatus.Ready, find: () => null }}
  />
);

/**
 * The rail's headline is the adapter's phrase (ISS-12117: one adapter, two
 * looks), drawn by the same `ActivityParts` the Activity tab uses, so these
 * stories show the rail exactly as production words each row.
 */
const USERS = {
  status: ActivityDirectoryStatus.Ready,
  find: (id: string) =>
    [EMILY, JAKE, RYAN].find((user) => user.id === id) ?? null,
};
const READY = {
  users: USERS,
  projects: {
    status: ActivityDirectoryStatus.Ready,
    find: (id: string) => [ATLAS, ORION].find((p) => p.id === id) ?? null,
  },
  tags: {
    status: ActivityDirectoryStatus.Ready,
    find: (id: string) => (id === FRONTEND_TAG.id ? FRONTEND_TAG : null),
  },
  documentType: DocumentType.Feature,
} satisfies ActivityLookups;

function phrase(row: ActivityTimelineRow, lookups: ActivityLookups = READY) {
  if (row.kind !== ActivityTimelineRowKind.Activity) {
    return null;
  }
  const { parts, suffix } = describeActivityParts(row.item.event, lookups);
  return (
    <>
      <ActivityParts parts={parts} />
      {suffix ? (
        <span className="text-muted-foreground"> · {suffix}</span>
      ) : null}
    </>
  );
}

const meta = {
  component: ActivityCardView,
  args: {
    actor: ACTOR,
    createdAt: new Date("2026-02-01T09:30:00.000Z"),
    headline: phrase(ACTIVITY_CATALOG.C14.row),
  },
  argTypes: {
    actor: { control: false },
    headline: { control: false },
    change: { control: false },
  },
  parameters: { layout: "padded" },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Documents/Activity Card View",
} satisfies Meta<typeof ActivityCardView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** C01: a creation row names the kind it created and its first status. */
export const Creation: Story = {
  args: { headline: phrase(ACTIVITY_CATALOG.C01.row) },
};

/** C02: both statuses as pills, in the catalog wording. */
export const BeforeAndAfter: Story = {
  args: { headline: phrase(ACTIVITY_CATALOG.C02.row) },
};

/** C08: one-sided (nobody was assigned before), so the phrase names one person. */
export const OneSided: Story = {
  args: { headline: phrase(ACTIVITY_CATALOG.C08.row) },
};

/**
 * The org-user lookup is still in flight. A placeholder holds the name's
 * place so the row does not reflow when it lands, and the row names nobody
 * meanwhile.
 */
export const AwaitingNames: Story = {
  args: {
    headline: phrase(ACTIVITY_CATALOG.C08.row, {
      users: { status: ActivityDirectoryStatus.Pending, find: () => null },
    }),
  },
};

/**
 * The directory settled and this id genuinely is not in it — a member who has
 * since left. This wording is reserved for exactly that case; a failed or empty
 * directory read says only what changed ("updated the assignee").
 */
export const UnknownUser: Story = {
  args: { headline: phrase(MISSING_USER_ROW) },
};

/** A rename long enough that both values truncate inside the rail. */
export const LongRenamedTitle: Story = {
  args: { headline: phrase(LONG_VALUE_ROW) },
};

/**
 * A non-human row in its de-cluttered form (ISS-5767 / ISS-5972). The view takes the actor
 * as an opaque slot, so this pins what the row's leading edge should now WEIGH:
 * one avatar and one word, the same visual budget a human row spends, instead of
 * the name plus a pill that restated it. The kind is a real distinction, but it
 * is not four distinctions.
 */
export const SystemActor: Story = {
  args: {
    actor: SYSTEM_ACTOR,
    headline: phrase(ACTIVITY_CATALOG.C04.row),
  },
};

/**
 * An API-key write (Nerys, 2026-10-07): the key owner's avatar and name with
 * an "API" badge, so it never reads as the owner's own edit.
 */
export const AgentActor: Story = {
  args: {
    actor: (
      <ActivityActor
        actor={{ kind: ActivityFeedActorKind.Agent, id: EMILY.id }}
        directory={USERS}
      />
    ),
    headline: phrase(C02_ACTOR_VARIANTS.agent),
  },
};

/**
 * A comment row for the Activity tab (ISS-10843): who commented and when, with
 * a read-only link to the comment. No body, reply or reaction; the comment
 * itself lives in the comments rail.
 */
export const CommentLink: Story = {
  args: {
    headline: "commented",
    link: { href: "#comment-th-1", label: "View comment" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: "View comment" })
    ).toHaveAttribute("href", "#comment-th-1");
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};
