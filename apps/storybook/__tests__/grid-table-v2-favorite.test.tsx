/**
 * Behavior test for the Grid Table V2 harness's favorite set.
 *
 * The `FavoriteContract` story's own `play` adds a favorite and stops there, so
 * the removal arm of the harness's set update is never taken. Un-favoriting is
 * driven here, and the whole favorited set is read each time: an update that
 * cleared every row still clears the one under test and would pass a
 * single-row assertion.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import gridTableV2Meta, {
  FavoriteContract as favoriteStory,
} from "../stories/grid-table-v2.stories";

const FavoriteContract = composeStory(favoriteStory, gridTableV2Meta);

const ADD_PREFIX_PATTERN = /^Add /;
const REMOVE_PREFIX_PATTERN = /^Remove /;
const TO_FAVORITES_SUFFIX_PATTERN = / to favorites$/;
const FROM_FAVORITES_SUFFIX_PATTERN = / from favorites$/;
const FIRST_ROW = "Unified artifact experience";
const SECOND_ROW = "Canonical table controls";
const CASE_TIMEOUT_MS = 20_000;

/** Every favorite control as `row title → pressed`. */
function favoriteStates(): Record<string, string | null> {
  return Object.fromEntries(
    within(document.body)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((label) => label.endsWith("favorites"))
      .map((label) => {
        const title = label
          .replace(ADD_PREFIX_PATTERN, "")
          .replace(REMOVE_PREFIX_PATTERN, "")
          .replace(TO_FAVORITES_SUFFIX_PATTERN, "")
          .replace(FROM_FAVORITES_SUFFIX_PATTERN, "");
        const control = within(document.body).getByRole("button", {
          name: label,
        });
        return [title, control.getAttribute("aria-pressed")];
      })
  );
}

async function pressFavorite(title: string, favorited: boolean) {
  const label = favorited
    ? `Remove ${title} from favorites`
    : `Add ${title} to favorites`;
  await userEvent.click(
    within(document.body).getByRole("button", { name: label })
  );
}

describe("grid table v2 favorite set", () => {
  it(
    "removes a row from the favorites without disturbing the others",
    async () => {
      // The story's play has already favorited the first row by the time `run`
      // resolves, so the removal below starts from a real selection.
      await FavoriteContract.run();
      const afterPlay = favoriteStates();
      expect(afterPlay[FIRST_ROW]).toBe("true");

      await pressFavorite(SECOND_ROW, false);
      expect(favoriteStates()).toEqual({
        ...afterPlay,
        [SECOND_ROW]: "true",
      });

      await pressFavorite(FIRST_ROW, true);
      expect(favoriteStates()).toEqual({
        ...afterPlay,
        [FIRST_ROW]: "false",
        [SECOND_ROW]: "true",
      });
    },
    CASE_TIMEOUT_MS
  );
});
