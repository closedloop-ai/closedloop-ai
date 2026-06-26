import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { artifactFavoriteKeys } from "../hooks/use-artifact-favorites";
import { FavoriteButton } from "./favorite-button";

/**
 * Co-located story for the migrated app-core wrapper (FEA-1510 / AC-001.4):
 * renders the real `useIsFavoriteArtifact`/`useToggleFavoriteArtifact` hooks
 * under `AppCoreStoryProviders` — favorite state is seeded into the query
 * cache and the toggle mutation runs against the fixture transport, proving
 * the moved component works without Next.js, Clerk, or a live API.
 */
const SEEDED_FAVORITES = [{ id: "artifact-1", name: "Saved artifact" }];

const favoriteRoutes: FixtureRoute[] = [
  // Toggle invalidates the favorites list, which refetches this GET — keep it
  // returning an array so useIsFavoriteArtifact stays well-formed after a click.
  {
    method: "GET",
    path: "/artifacts/favorites",
    respond: () => SEEDED_FAVORITES,
  },
  {
    method: "POST",
    path: "/artifacts/*",
    respond: () => ({ favorited: true }),
  },
  {
    method: "DELETE",
    path: "/artifacts/*",
    respond: () => ({ favorited: false }),
  },
];

const meta: Meta<typeof FavoriteButton> = {
  title: "App Core/Documents/Favorite Button",
  component: FavoriteButton,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders
        apiRoutes={favoriteRoutes}
        queryData={[[artifactFavoriteKeys.list(), SEEDED_FAVORITES]]}
      >
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Favorited: Story = {
  args: { artifactId: "artifact-1" },
};

export const NotFavorited: Story = {
  args: { artifactId: "artifact-2" },
};
