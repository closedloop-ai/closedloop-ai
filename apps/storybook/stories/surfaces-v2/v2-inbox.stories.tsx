import { INBOX_SURFACE_V2_TEST_ID } from "@repo/app/inbox/components/inbox-surface-v2";
import {
  INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY,
  INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import InboxPage from "@/app/(authenticated)/[orgSlug]/inbox/page";
import {
  type InboxLiveblocksState,
  inboxApiRoutes,
  inboxNotificationsFixture,
  LiveblocksInbox,
} from "./fixtures/inbox-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar, entry 7 of 62: Inbox (Artifact list).
// The live route's own page (`apps/app/.../inbox/page.tsx`: the Header and
// `InboxHost`) in the app frame, under the Liveblocks provider the
// authenticated layout mounts. `InboxHost` renders `InboxSurfaceV2` behind
// `inbox-complete-surface`, so every story turns that gate on. Each story is
// one state the live page reaches from its Liveblocks reads.

const READY: InboxLiveblocksState = {
  kind: "ready",
  notifications: inboxNotificationsFixture(),
};

const meta = {
  title: "Surfaces/Labs/Inbox",
  tags: ["preview"],
  render: (_args, { parameters }) => (
    <LiveblocksInbox
      state={
        (parameters.liveblocks as InboxLiveblocksState | undefined) ?? READY
      }
    >
      <LivePage activePath="/inbox">
        <InboxPage />
      </LivePage>
    </LiveblocksInbox>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: {
      apiRoutes: inboxApiRoutes,
      enabledFlags: [INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY],
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The Header's page heading carries the route's breadcrumb label.
    await expect(
      await canvas.findByRole("heading", { level: 1 })
    ).toBeInTheDocument();
    await expect(
      (await canvas.findAllByTestId(INBOX_SURFACE_V2_TEST_ID)).length
    ).toBeGreaterThan(0);
    await expect(
      await canvas.findByRole("link", { name: "Inbox" })
    ).toHaveAttribute("data-active", "true");
  },
};

/** The Liveblocks reads are still in flight. */
export const Loading: Story = {
  parameters: { liveblocks: { kind: "pending" } },
};

/** A successful read of nothing. */
export const Empty: Story = {
  parameters: { liveblocks: { kind: "ready", notifications: [] } },
};

/** Liveblocks refused the read, so the Inbox cannot be served. */
export const Unavailable: Story = {
  parameters: { liveblocks: { kind: "forbidden" } },
};

/** Every row already read: the mark-all-read control goes inert. */
export const NothingUnread: Story = {
  parameters: {
    liveblocks: {
      kind: "ready",
      notifications: inboxNotificationsFixture(true),
    },
  },
};

/** `inbox-notification-actor` on: assignment and mention rows lead with the person. */
export const ActorTreatment: Story = {
  parameters: {
    appCore: {
      apiRoutes: inboxApiRoutes,
      enabledFlags: [
        INBOX_COMPLETE_SURFACE_FEATURE_FLAG_KEY,
        INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY,
      ],
    },
  },
};
