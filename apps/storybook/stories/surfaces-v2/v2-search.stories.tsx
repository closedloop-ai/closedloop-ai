import { PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { SearchResults } from "@/app/(authenticated)/[orgSlug]/search/components/search-results";
import { Header } from "@/app/(authenticated)/components/header";
import {
  SEARCH_QUERY,
  searchApiRoutes,
  searchHitsFixture,
  searchResponse,
} from "./fixtures/search-fixtures";
import { LivePage } from "./live-page";
import { LiveRoute } from "./live-route";

// ISS-11361 Target sidebar: Search (Search results).
// `apps/app/.../search/page.tsx` is an async server component that redirects
// a bare `/search` to My Tasks and otherwise returns the Header and
// `SearchResults`; this renders that tree at `/search?q=transcript` in the app
// frame. `SearchResults` mounts `SearchSurfaceV2` behind
// `portable-search-surface`, whose production rollout is not recorded, so the
// default here is the flag-off results list and `PortableSurface` shows the
// flag-on one. Each story is one state the page reaches from `GET /search`.

function searchPage(query: string) {
  return (
    <LiveRoute path={`/search?q=${encodeURIComponent(query)}`}>
      <LivePage activePath="/search">
        <Header breadcrumbs={[{ label: "Search" }]} suppressPageHeading />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
          <SearchResults />
        </div>
      </LivePage>
    </LiveRoute>
  );
}

function withSearch(route: Omit<FixtureRoute, "method" | "path">) {
  return {
    appCore: {
      apiRoutes: [
        { method: "GET", path: "/search", ...route },
        ...searchApiRoutes,
      ],
    },
  };
}

const meta = {
  title: "Surfaces/Labs/Search",
  tags: ["preview"],
  render: () => searchPage(SEARCH_QUERY),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: searchApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("main")).toBeVisible();
    await expect(
      await canvas.findByText(searchHitsFixture[0]?.title ?? "")
    ).toBeVisible();
  },
};

/** The search read is still in flight. */
export const Loading: Story = {
  parameters: withSearch({ respond: () => new Promise(() => undefined) }),
};

/** The query matched nothing. */
export const NoMatches: Story = {
  parameters: withSearch({ respond: () => searchResponse([]) }),
};

/** The search read failed. */
export const Unavailable: Story = {
  parameters: withSearch({ respond: () => null, status: 500 }),
};

/** A query too short to run, straight from the URL. */
export const RejectedQuery: Story = {
  render: () => searchPage("t"),
};

/** `portable-search-surface` on: the page mounts `SearchSurfaceV2`. */
export const PortableSurface: Story = {
  parameters: {
    appCore: {
      apiRoutes: searchApiRoutes,
      enabledFlags: [PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY],
    },
  },
};
