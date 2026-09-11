import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { artifactFavoriteKeys } from "../hooks/use-artifact-favorites";
import { FavoriteButton } from "./favorite-button";

/**
 * Co-located story for the migrated app-core wrapper (FEA-1510 / AC-001.4):
 * renders the real `useIsFavoriteArtifact`/`useToggleFavoriteArtifact` hooks
 * against the globally-mounted app-core harness — favorite state is seeded into
 * the query cache and the toggle mutation runs through the fixture transport,
 * proving the moved component works without Next.js, Clerk, or a live API.
 *
 * The harness is declared with `parameters.appCore` rather than wrapped around
 * the story (ISS-5665): the preview mounts it for every story, so this file
 * states what it needs and owns no provider boilerplate.
 */

const ADD_LABEL = "Add to favorites";
const REMOVE_LABEL = "Remove from favorites";

const SEEDED_FAVORITES = [{ id: "artifact-1", name: "Saved artifact" }];

/**
 * Server-side favorite state for the fixture transport.
 *
 * The GET route reads THIS set and POST/DELETE mutate it, which is what makes
 * the `play` functions below falsifiable: mounting alone cannot distinguish a
 * working toggle from a broken one, so each story clicks through the whole
 * round-trip — click → POST/DELETE → the mutation's `invalidateQueries` →
 * refetched GET → re-rendered label. A GET that returned a constant (or a
 * POST/DELETE that no-oped) would leave the label exactly where it started and
 * the assertion on the ending label fails.
 */
let favoriteIds = new Set<string>();

function resetFavorites(): void {
  // Each `play` starts from the seeded state, so story order in the all-stories
  // sweep cannot change what an interaction observes.
  favoriteIds = new Set(SEEDED_FAVORITES.map((favorite) => favorite.id));
}

resetFavorites();

/** `/artifacts/<artifactId>/favorite` → `<artifactId>`. */
function artifactIdFromPath(pathname: string): string {
  return pathname.split("/")[2] ?? "";
}

const favoriteRoutes: FixtureRoute[] = [
  // Toggle invalidates the favorites list, which refetches this GET — it
  // projects the mutated set so the refetch actually reflects the mutation,
  // and stays an array so useIsFavoriteArtifact stays well-formed after a click.
  {
    method: "GET",
    path: "/artifacts/favorites",
    respond: () =>
      [...favoriteIds].map((id) => ({
        id,
        name: id === "artifact-1" ? "Saved artifact" : `Artifact ${id}`,
      })),
  },
  {
    method: "POST",
    path: "/artifacts/*",
    respond: ({ pathname }) => {
      favoriteIds.add(artifactIdFromPath(pathname));
      return { favorited: true };
    },
  },
  {
    method: "DELETE",
    path: "/artifacts/*",
    respond: ({ pathname }) => {
      favoriteIds.delete(artifactIdFromPath(pathname));
      return { favorited: false };
    },
  },
];

/**
 * A small star-shaped button that toggles whether something is one of your
 * favorites: outlined when it isn't, filled yellow when it is. Use it
 * anywhere you list or open an item and want a quick way to mark it for easy
 * access later, without opening a full settings panel. Clicking it doesn't
 * trigger whatever link or card it's sitting on top of, so it's safe to
 * place inside a clickable row.
 */
const meta: Meta<typeof FavoriteButton> = {
  title: "Composites/Documents/Artifact Favorite Button",
  component: FavoriteButton,
  tags: ["autodocs"],
  argTypes: {
    size: { control: { type: "radio" }, options: ["sm", "default"] },
  },
  args: { size: "sm" },
  parameters: {
    appCore: {
      apiRoutes: favoriteRoutes,
      queryData: [[artifactFavoriteKeys.list(), SEEDED_FAVORITES]],
    },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Seeded as a favorite: un-favoriting drives the DELETE half of the mutation.
 */
export const Favorited: Story = {
  args: { artifactId: "artifact-1" },
  play: async ({ canvasElement }) => {
    resetFavorites();
    const canvas = within(canvasElement);

    // Starts from the seeded label — artifact-1 is in the seeded cache.
    await userEvent.click(
      await canvas.findByRole("button", { name: REMOVE_LABEL })
    );

    // Ends after a fixture-backed state change: only a DELETE that reached the
    // fixture, plus the invalidated refetch, can flip the label.
    await expect(
      await canvas.findByRole("button", { name: ADD_LABEL })
    ).toBeVisible();
    expect(favoriteIds.has("artifact-1")).toBe(false);
  },
};

/**
 * Not seeded as a favorite: favoriting drives the POST half of the mutation.
 */
export const NotFavorited: Story = {
  args: { artifactId: "artifact-2" },
  play: async ({ canvasElement }) => {
    resetFavorites();
    const canvas = within(canvasElement);

    // Starts from the seeded label — artifact-2 is absent from the seeded cache.
    await userEvent.click(
      await canvas.findByRole("button", { name: ADD_LABEL })
    );

    // Ends after a fixture-backed state change: only a POST that reached the
    // fixture, plus the invalidated refetch, can flip the label.
    await expect(
      await canvas.findByRole("button", { name: REMOVE_LABEL })
    ).toBeVisible();
    expect(favoriteIds.has("artifact-2")).toBe(true);
  },
};
