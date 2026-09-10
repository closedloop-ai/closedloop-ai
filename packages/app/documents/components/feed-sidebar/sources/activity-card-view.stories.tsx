import { ActivityFeedActorKind } from "@repo/api/src/types/artifact-activity-feed";
import type { User } from "@repo/api/src/types/user";
import type { Meta, StoryObj } from "@storybook/react";
import { ActivityActor } from "./activity-actor";
import { ActivityCardView } from "./activity-card-view";
import { ActivityDirectoryStatus } from "./activity-directory";

/**
 * The activity row's presentational contract, which the string-asserting unit
 * tests cannot see: that the chips truncate rather than wrap, that the pending
 * skeleton reserves the row's real height, that the struck-through "before"
 * side and the arrow read as one pair, and that a renamed-title chip stays
 * inside the rail at dark and light (PR #4329 review, wongk).
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
  email: "dana@example.com",
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

const LONG_TITLE =
  "Add session-quality signals to the branch rollup so a reviewer can see PR metrics without opening GitHub";

const meta = {
  component: ActivityCardView,
  argTypes: {
    actor: {
      control: false,
      description: "The rendered actor cell, taken as an opaque slot.",
    },
    createdAt: { control: false },
    headline: { control: "text" },
    change: {
      control: "object",
      description:
        "The before/after pair. Both sides null renders no chips at all, and one side null drops the arrow.",
    },
    pending: { control: "boolean" },
  },
  args: {
    actor: ACTOR,
    createdAt: new Date("2026-02-01T09:30:00.000Z"),
    headline: "updated the priority",
    change: { before: "Medium", after: "Low" },
    pending: false,
  },
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  title: "Composites/Documents/Activity Card View",
} satisfies Meta<typeof ActivityCardView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A creation row: headline only, no before→after pair to show. */
export const Creation: Story = {
  args: {
    headline: "created this artifact",
    change: { before: null, after: null },
  },
};

/** Both sides present, so the arrow joins them. */
export const BeforeAndAfter: Story = {};

/** One-sided change (nothing was set before), so there is no arrow. */
export const OneSided: Story = {
  args: {
    headline: "updated the assignee",
    change: { before: null, after: "Dana Reed" },
  },
};

/**
 * The org-user lookup is still in flight. The skeletons hold the chips' real
 * geometry so the row does not reflow when the names land — and, critically,
 * the row names nobody meanwhile.
 */
export const AwaitingNames: Story = {
  args: {
    headline: "updated the assignee",
    change: { before: "user_a", after: "user_b" },
    pending: true,
  },
};

/**
 * The directory settled and this id genuinely is not in it — a member who has
 * since left. This wording is reserved for exactly that case; a failed or empty
 * directory read drops the chips instead of claiming the person is unknown.
 */
export const UnknownUser: Story = {
  args: {
    headline: "updated the assignee",
    change: { before: "Dana Reed", after: "Unknown user" },
  },
};

/** A rename long enough that both pills must truncate inside the rail. */
export const LongRenamedTitle: Story = {
  args: {
    headline: "updated the title",
    change: { before: LONG_TITLE, after: `${LONG_TITLE} (v2)` },
  },
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
    headline: "updated the status",
    change: { before: "In review", after: "Done" },
  },
};
