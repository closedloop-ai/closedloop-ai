import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import TeamProjectsPage from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/page";
import {
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
  narrowStoryViewport,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 18 of 62: Projects List (Artifact list).
// The live route's own page (`apps/app/.../teams/[teamId]/projects/page.tsx`)
// in the app frame, for the Global Nav's Platform Engineering team. Each story
// is one state the live page reaches from its team and projects reads. The
// The default stories keep the portable-surface and filter-sort-model flags
// off. `Narrow` selects the existing portable surface so its gridview-adoption
// state exercises the shared responsive owner instead of the legacy table.

const meta = {
  title: "Surfaces/Your Teams/Projects List",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath={PROJECTS_PATH}>
      <TeamProjectsPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: {
      path: `/${LIVE_ORG_SLUG}${PROJECTS_PATH}`,
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
    const [first] = projectsFixture;
    await expect(
      await canvas.findByText(first?.name ?? "", {}, { timeout: 10_000 })
    ).toBeVisible();
    await expectActiveNavItem(canvasElement, projectsTeamFixture.name);
  },
};

/** The projects read is still in flight. */
export const Loading: Story = {
  parameters: projectsRead(() => new Promise(() => undefined)),
};

/** The team has no active projects. */
export const Empty: Story = {
  parameters: { appCore: { apiRoutes: projectsRoutes([]) } },
};

/** The projects read failed. */
export const ErrorState: Story = {
  name: "Error",
  parameters: projectsRead(() => null, 500),
};

export const Narrow: Story = {
  beforeEach: narrowStoryViewport,
  globals: { viewport: { value: "390-844" } },
  parameters: {
    appCore: {
      enabledFlags: [
        GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
        PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        "columnheader",
        { name: "Name" },
        { timeout: 10_000 }
      )
    ).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    const grid = canvas.getByRole("grid");
    await expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
    await expect(canvasElement.querySelector('[data-slot="card"]')).toBeNull();
    const firstRow = grid.querySelector(
      `[data-grid-row-id="${projectsFixture[0]?.id}"]`
    );
    if (!firstRow) {
      throw new Error("The narrow Projects row must own its project name");
    }
    await expect(
      within(firstRow).getByRole("button", { name: "Open menu" })
    ).toBeVisible();
  },
};
