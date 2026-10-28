import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import UserProfilePage from "@/app/(authenticated)/[orgSlug]/users/[userId]/page";
import { currentUserFixture } from "./fixtures/live-app-fixtures";
import { userProfileApiRoutes } from "./fixtures/user-profile-fixtures";
import { LivePage } from "./live-page";

// ISS-11361 Target sidebar: User Profile (Record detail).
// The live route's own page (`apps/app/.../users/[userId]/page.tsx`, a client
// page that unwraps its route params) for the signed-in user, in the app frame.
// Each story is one state the page reaches from its reads.

const ROUTE_PARAMS = { orgSlug: "org-test", userId: currentUserFixture.id };

/**
 * The route params the server hands the page, as an already-settled promise.
 * React's `use()` reads a thenable's `status`/`value` synchronously when they
 * are set, so the page renders on the first pass instead of suspending the
 * whole story root (which never resumes under the jsdom sweep).
 */
const PARAMS = Object.assign(Promise.resolve(ROUTE_PARAMS), {
  status: "fulfilled",
  value: ROUTE_PARAMS,
});

const USER_PATH = `/users/${currentUserFixture.id}`;

function withRoutes(overrides: FixtureRoute[]) {
  return { appCore: { apiRoutes: [...overrides, ...userProfileApiRoutes] } };
}

/** The four stats reads, all answering `status`. */
function failing(status: number): FixtureRoute[] {
  return ["stats/headline", "contributions", "standing", "milestones"].map(
    (part) => ({
      method: "GET",
      path: `${USER_PATH}/${part}`,
      respond: () => null,
      status,
    })
  );
}

const meta = {
  title: "Surfaces/Other Pages/Users/User Profile",
  tags: ["stable"],
  render: () => (
    <LivePage activePath={USER_PATH}>
      <UserProfilePage params={PARAMS} />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: userProfileApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = `${currentUserFixture.firstName} ${currentUserFixture.lastName}`;
    await expect(
      (await canvas.findAllByRole("heading", { name })).length
    ).toBeGreaterThan(0);
  },
};

/** The user read is still in flight. */
export const Loading: Story = {
  parameters: withRoutes([
    {
      method: "GET",
      path: USER_PATH,
      respond: () => new Promise(() => undefined),
    },
  ]),
};

/** No user answers to this id, so none of its reads do either. */
export const NotFound: Story = {
  parameters: withRoutes([
    { method: "GET", path: USER_PATH, respond: () => null, status: 404 },
    ...failing(404),
  ]),
};

/** The stats reads failed; the profile header still renders. */
export const StatsUnavailable: Story = {
  parameters: withRoutes(failing(500)),
};
