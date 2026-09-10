import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
} from "@repo/api/src/types/artifact-activity-feed";
import type { User } from "@repo/api/src/types/user";
import type { Meta, StoryObj } from "@storybook/react";
import { ActivityActor } from "./activity-actor";
import {
  type ActivityDirectory,
  ActivityDirectoryStatus,
} from "./activity-directory";

/**
 * The actor cell's six visually distinct states.
 *
 * The "Member" / "Unknown user" split is a deliberate truth-claim rule — we say
 * a person is unknown only when the directory settled and really does not have
 * them, and say nothing at all when the read failed — and a string-level test
 * keeps passing straight through a layout or avatar-fallback regression that
 * breaks how those states read (PR #4329 review, wongk). Three of them are
 * effectively unreachable on demand in the running app: a lookup mid-flight, a
 * member who has left, and a directory outage.
 *
 * The directory is a plain prop now, so none of this needs a live query.
 *
 * ISS-5767 added the seventh, `KindMatrix`, and ISS-5972 made it the ONLY form:
 * the de-clutter shipped ungated, so there is no second branch left to sit
 * beside. A story that still showed the pre-declutter pill would now be fiction
 * — and a stale story is exactly how this drift stayed invisible through the
 * last design pass.
 */

const DANA: User = {
  id: "user_b",
  firstName: "Dana",
  lastName: "Reed",
  email: "dana@example.com",
} as User;

function directoryOf(
  status: ActivityDirectoryStatus,
  records: User[] = []
): ActivityDirectory<User> {
  return {
    status,
    find: (id) => records.find((record) => record.id === id) ?? null,
  };
}

const HUMAN: ActivityFeedActor = {
  kind: ActivityFeedActorKind.Human,
  id: DANA.id,
};

const meta = {
  component: ActivityActor,
  argTypes: {
    actor: {
      control: "object",
      description: "The actor's kind and the id the directory is asked for.",
    },
    directory: {
      control: false,
      description:
        "The row's org-user lookup and how far it has settled. It carries a find function, so each story passes one in rather than editing it here.",
    },
  },
  args: {
    actor: HUMAN,
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  title: "Composites/Documents/Activity Actor",
} satisfies Meta<typeof ActivityActor>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The directory settled and has this person: avatar, name, profile link. */
export const Resolved: Story = {};

/**
 * The lookup is still in flight. Avatar and name are both skeletons, matching
 * the chips on the same row — the cell must not name anyone yet.
 */
export const AwaitingName: Story = {
  args: { directory: directoryOf(ActivityDirectoryStatus.Pending) },
};

/**
 * The directory settled WITH records and this id is not among them — a member
 * who has since left. This is the only state allowed to say "Unknown user".
 */
export const UnknownUser: Story = {
  args: {
    actor: { kind: ActivityFeedActorKind.Human, id: "user_gone" },
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
};

/**
 * The read failed, or the viewer can see no org users at all. We never looked
 * this person up, so the cell claims only what it knows: a member did this.
 */
export const DirectoryUnavailable: Story = {
  args: { directory: directoryOf(ActivityDirectoryStatus.Unavailable) },
};

/**
 * A non-human row, de-cluttered (ISS-5767 / ISS-5972). It used to state its kind
 * four times inside about thirty characters — gear/robot avatar glyph, the word
 * "Agent" as the name, and a pill repeating both. Now: the glyph, and the name.
 */
export const Agent: Story = {
  args: {
    actor: { kind: ActivityFeedActorKind.Agent, id: "agent-1" },
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
};

export const System: Story = {
  args: {
    actor: { kind: ActivityFeedActorKind.System, id: null },
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
};

/**
 * Every kind side by side, which is the only way to see that de-cluttering did
 * not also collapse the distinctions. The kind is stated once — the glyph
 * carries it visually, the name carries it in words where there is no profile to
 * anchor on. At this size the glyph reads as texture, so the NAME is what
 * actually tells Agent from System, with the robot/cog silhouettes as a
 * secondary cue — nothing here is encoded in hue (WCAG 1.4.1).
 *
 * Includes the human-with-photo row, the most common real row in production.
 * Note what it still does: `AvatarImage alt={displayName}` repeats the name the
 * span two nodes along already carries. That is the NAME axis, not the kind axis
 * this ticket closed, and it is tracked as ISS-6174.
 */
export const KindMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {KIND_MATRIX.map(({ label, actor, directory }) => (
        <div className="flex flex-col gap-1" key={label}>
          <span className="text-muted-foreground text-xs">{label}</span>
          <ActivityActor actor={actor} directory={directory} />
        </div>
      ))}
    </div>
  ),
};

/**
 * Same person, with a profile photo. An inline data URI rather than a remote
 * URL so the story renders identically offline and in CI.
 */
const DANA_WITH_PHOTO: User = {
  ...DANA,
  avatarUrl:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' fill='%236366f1'/%3E%3C/svg%3E",
} as User;

const KIND_MATRIX: ReadonlyArray<{
  label: string;
  actor: ActivityFeedActor;
  directory: ActivityDirectory<User>;
}> = [
  {
    label: "Human, resolved profile",
    actor: HUMAN,
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
  {
    label: "Human, resolved profile with a photo",
    actor: HUMAN,
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA_WITH_PHOTO]),
  },
  {
    label: "Human, settled directory, member has left",
    actor: { kind: ActivityFeedActorKind.Human, id: "user_gone" },
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
  {
    label: "Human, directory unavailable",
    actor: HUMAN,
    directory: directoryOf(ActivityDirectoryStatus.Unavailable),
  },
  {
    label: "Agent",
    actor: { kind: ActivityFeedActorKind.Agent, id: "agent-1" },
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
  {
    label: "System",
    actor: { kind: ActivityFeedActorKind.System, id: null },
    directory: directoryOf(ActivityDirectoryStatus.Ready, [DANA]),
  },
];
