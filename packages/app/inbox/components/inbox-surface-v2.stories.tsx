import { LiveblocksProvider } from "@liveblocks/react";
import type { Meta, StoryObj } from "@storybook/react";
import { INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY } from "../../shared/lib/feature-flags";
import type { InboxSurfaceNotification } from "../lib/inbox-notification-source";
import {
  INBOX_SOURCE_LOADING,
  INBOX_SOURCE_UNAVAILABLE,
  InboxTransportStatus,
} from "../lib/inbox-notification-source";
import { InboxSurfaceV2 } from "./inbox-surface-v2";

/**
 * ISS-9406 — every state the Inbox surface can be in, side by side.
 *
 * The three with nothing to list are the reason this file exists: "we could not
 * read your notifications", "we read them and you have none" and "we are still
 * reading" are different claims about the world, and what makes them
 * distinguishable is copy and weight on the page rather than a DOM assertion.
 */

/** The rows read the client's user resolver. Nothing here connects. */
function resolveUsers({ userIds }: { userIds: readonly string[] }) {
  return userIds.map((userId) =>
    userId === "user_emma" ? { color: "#8b5cf6", name: "Emma Chen" } : undefined
  );
}

const meta: Meta<typeof InboxSurfaceV2> = {
  component: InboxSurfaceV2,
  tags: ["deprecated", "autodocs"],
  decorators: [
    (Story) => (
      <LiveblocksProvider
        authEndpoint={() => new Promise(() => undefined)}
        resolveUsers={resolveUsers}
      >
        <div className="flex h-[32rem] flex-col">
          <Story />
        </div>
      </LiveblocksProvider>
    ),
  ],
  title: "Composites v1.0/Inbox/Inbox Surface V2",
};

export default meta;
type Story = StoryObj<typeof InboxSurfaceV2>;

function record(
  id: string,
  kind: string,
  minutesAgo: number,
  readAt: Date | null,
  data: Record<string, string>
): InboxSurfaceNotification {
  const notifiedAt = new Date(Date.now() - minutesAgo * 60_000);
  return {
    activities: [{ createdAt: notifiedAt, data, id: `ac_${id}` }],
    id,
    kind,
    notifiedAt,
    readAt,
    subjectId: `sub_${id}`,
  } as unknown as InboxSurfaceNotification;
}

/** One of every kind, and one of them already read. */
const NOTIFICATIONS: readonly InboxSurfaceNotification[] = [
  record("in_assignment", "$assignment", 6, null, {
    actorId: "user_emma",
    entityTitle: "Fix session transcripts",
    entityType: "artifact",
    entityUrl: "/closedloop-ai/documents/iss-1",
  }),
  record("in_mention", "$mention", 55, null, {
    actorId: "user_emma",
    commentPreview: "can you take a look?",
    entityTitle: "Nightly review",
    entityType: "session",
    entityUrl: "/closedloop-ai/sessions/ses-1",
  }),
  record("in_awaiting", "$awaitingInput", 180, new Date(), {
    sessionTitle: "Overnight backfill",
    sessionUrl: "/closedloop-ai/sessions/ses-2",
  }),
];

function readySource(unreadCount: number) {
  return {
    markAllAsRead: () => undefined,
    notifications: NOTIFICATIONS,
    status: InboxTransportStatus.Ready,
    unreadCount,
  } as const;
}

export const Populated: Story = {
  args: { source: readySource(2) },
};

/** Nothing left unread: the control stays on screen and goes inert. */
export const NothingUnread: Story = {
  args: { source: readySource(0) },
};

/**
 * ISS-5010's actor treatment, which the surface resolves for itself. Two kinds
 * lead with the person and two are unchanged — hence all four together.
 */
export const ActorTreatment: Story = {
  args: { source: readySource(2) },
  parameters: {
    appCore: { enabledFlags: [INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY] },
  },
};

/** A successful read of nothing. The remedy is to wait, not to retry. */
export const Empty: Story = {
  args: {
    source: {
      markAllAsRead: () => undefined,
      notifications: [],
      status: InboxTransportStatus.Ready,
      unreadCount: 0,
    },
  },
};

/** The transport could not answer. It must never look like {@link Empty}. */
export const Unavailable: Story = {
  args: { source: INBOX_SOURCE_UNAVAILABLE },
};

/** A read in flight. Never a zero and never either of the two above. */
export const Loading: Story = {
  args: { source: INBOX_SOURCE_LOADING },
};
