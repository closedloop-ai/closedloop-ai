import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { userKeys } from "@repo/app/users/hooks/use-users";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, screen, userEvent, within } from "storybook/test";
import {
  createFullyPopulatedSessionsUsageFixture,
  createSessionTableRowFixture,
} from "./session-list-fixtures";
import { SessionsListSurfaceV2 } from "./sessions-list-surface-v2";
import { SessionsListSurfaceV2Preview } from "./sessions-list-surface-v2-demo";

/**
 * ISS-8718 — inline session rename ON the real `GridTableV2` lead column, not on
 * a stand-in.
 *
 * These stories mount `SessionsListSurfaceV2` through the same preview harness
 * the other Sessions grid stories use, and configure the GLOBAL app-core harness
 * through `parameters.appCore` so the affordance's actual gate runs: a data
 * source that offers `renameSession`, a query client to settle the write in, and
 * a viewer who owns the row. The fixture transport answers the PATCH, so a
 * commit here exercises the production path down to the request body.
 *
 * Declared as parameters rather than as a wrapper because a second
 * `AppCoreStoryProviders` replaces the preview's shared navigation port with a
 * private one — `app-core-harness-single-mount.test.ts` fails a story that
 * mounts its own.
 *
 * The three rows are deliberately not all the viewer's: row one is owned and
 * carries the edit control, rows two and three belong to someone else and must
 * render the plain link. Seeing both in one frame is the point — a gate that
 * offered the control to everybody would look identical on a single-row story.
 */

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const OWNED_NAME = "session/mine-to-rename";
const EDIT_CONTROL = { name: `Edit session name for ${OWNED_NAME}` };

const STORY_ROWS = [
  createSessionTableRowFixture({
    id: "11111111-1111-4111-8111-000000000001",
    name: OWNED_NAME,
    status: "Active",
    user: { id: VIEWER_ID, name: "You" },
  }),
  createSessionTableRowFixture({
    id: "11111111-1111-4111-8111-000000000002",
    name: "session/not-mine",
    status: "Completed",
    user: { id: OTHER_ID, name: "A Teammate" },
  }),
  createSessionTableRowFixture({
    id: "11111111-1111-4111-8111-000000000003",
    name: "session/also-not-mine",
    status: "Failed",
    user: { id: OTHER_ID, name: "A Teammate" },
  }),
];

const STORY_USAGE = {
  ...createFullyPopulatedSessionsUsageFixture(),
  totalSessions: STORY_ROWS.length,
};

/** Accepts the rename and echoes it, as the cloud route does. */
function acceptRename(context: FixtureRequestContext) {
  return { ok: true, received: context.body };
}

/** Refuses every rename, so the rejected draft and confirmed value can be seen. */
function refuseRename() {
  throw new Error("refused");
}

// No controls: these stories exercise fixed fixture rows and host-owned mutation states through the composed Sessions grid.
const meta = {
  title: "Composites/Artifacts/Sessions/Sessions List/Session Inline Rename",
  tags: ["stable"],
  component: SessionsListSurfaceV2,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionsListSurfaceV2>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The args every story below shares; the meta's component requires them. */
const STORY_ARGS = { rows: STORY_ROWS, usage: STORY_USAGE } as const;

function renderGrid() {
  return (
    <SessionsListSurfaceV2Preview
      rows={STORY_ROWS}
      totalRows={STORY_ROWS.length}
      usage={STORY_USAGE}
    />
  );
}

/** The app-core parameters every story needs, with its own PATCH responder. */
function appCore(respond: (context: FixtureRequestContext) => unknown) {
  return {
    appCore: {
      apiRoutes: [
        { method: "PATCH" as const, path: "/agent-sessions/*", respond },
      ],
      queryData: [[userKeys.currentUser(), { id: VIEWER_ID }]],
    },
  };
}

/**
 * The resting grid: the owner's row carries the edit control, the teammate's
 * rows do not. Hover row one to reveal the pencil, or Tab to it.
 */
export const OwnerSeesTheControl: Story = {
  args: STORY_ARGS,
  parameters: appCore(acceptRename),
  render: () => renderGrid(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", EDIT_CONTROL)).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", {
        name: "Edit session name for session/not-mine",
      })
    ).toBeNull();
  },
};

/**
 * The field open on the lead column, seeded with the committed name and fully
 * selected — what the owner sees the instant the pencil is activated.
 */
export const EditorOpenOnTheLeadCell: Story = {
  args: STORY_ARGS,
  parameters: appCore(acceptRename),
  render: () => renderGrid(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", EDIT_CONTROL));
    await expect(screen.getByRole("textbox", EDIT_CONTROL)).toHaveValue(
      OWNED_NAME
    );
  },
};

/**
 * A committed rename. The fixture transport accepts it, so the row shows the new
 * name and the request carried `name` plus the `expectedName` guard and nothing
 * else — the route refuses a body that pairs a rename with a priority or a
 * grouping field.
 */
export const CommittedRename: Story = {
  args: STORY_ARGS,
  parameters: appCore(acceptRename),
  render: () => renderGrid(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await userEvent.clear(field);
    await userEvent.type(field, "renamed in storybook{Enter}");
    await expect(canvas.getByText("renamed in storybook")).toBeInTheDocument();
  },
};

/**
 * A REFUSED rename. The editor keeps the rejected draft and associates the
 * failure with the field, leaving the unsaved text visible for correction or
 * retry without presenting it as persisted data.
 */
export const RefusedRenameRetainsDraft: Story = {
  name: "Refused Rename Retains Draft",
  args: STORY_ARGS,
  parameters: appCore(refuseRename),
  render: () => renderGrid(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await userEvent.clear(field);
    await userEvent.type(field, "never lands{Enter}");
    await expect(field).toHaveValue("never lands");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
    await expect(
      screen.getByRole("alert", { name: INLINE_EDIT_SAVE_ERROR_MESSAGE })
    ).toBeInTheDocument();
  },
};
