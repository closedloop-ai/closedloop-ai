import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import TeamArchivedProjectsPage from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/archived/page";
import {
  archivedProjectsFixture,
  PROJECTS_PATH,
  PROJECTS_TEAM_ID,
  projectsApiRoutes,
  projectsFixture,
  projectsRoutes,
  projectsTeamFixture,
} from "./fixtures/projects-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 20 of 62: Archived Projects (Artifact list).
// The live route's own page
// (`apps/app/.../teams/[teamId]/projects/archived/page.tsx`) in the app
// frame, for the Global Nav's Platform Engineering team. Each story is one
// state the live page reaches from its team and archived-projects reads.

const meta = {
  title: "Surfaces/Your Teams/Archived Projects",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath={PROJECTS_PATH}>
      <TeamArchivedProjectsPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: {
      path: `/${LIVE_ORG_SLUG}${PROJECTS_PATH}/archived`,
      params: { teamId: PROJECTS_TEAM_ID },
    },
    appCore: { apiRoutes: projectsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function projectsRead(respond: FixtureRoute["respond"], status?: number) {
  return {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: "/projects",
          respond,
          status,
          // The API's own message, which this page prints.
          error: "Internal server error",
        },
        ...projectsApiRoutes,
      ] satisfies FixtureRoute[],
    },
  };
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [first] = archivedProjectsFixture;
    await expect(
      await canvas.findByText(first?.name ?? "", {}, { timeout: 10_000 })
    ).toBeVisible();
    await expectActiveNavItem(canvasElement, projectsTeamFixture.name);
  },
};

/** The archived-projects read is still in flight. */
export const Loading: Story = {
  parameters: projectsRead(() => new Promise(() => undefined)),
};

/** The team has archived nothing. */
export const Empty: Story = {
  parameters: { appCore: { apiRoutes: projectsRoutes(projectsFixture, []) } },
};

/** The archived-projects read failed. */
export const ErrorState: Story = {
  name: "Error",
  parameters: projectsRead(() => null, 500),
};
