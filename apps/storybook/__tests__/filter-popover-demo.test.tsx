/**
 * Behavior tests for the Filter Popover demo's controller toggles.
 *
 * The `Default` story's own `play` already covers the two quick toggles
 * (hide-completed, favorites). What nothing exercises is the multi-select
 * categories, whose controller entries each branch on "already selected?" —
 * so every case below toggles a value ON and then back OFF and asserts the
 * trigger's category badge both times. Asserting only the ON step would leave
 * the removal half of each ternary unpinned.
 *
 * The trigger node is captured BEFORE the menu opens: Radix marks it
 * `aria-hidden` while open, which removes it from role-based queries.
 */
import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import {
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/table-filters";
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import filterPopoverMeta, {
  Empty as emptyStory,
} from "../stories/filter-popover.stories";
import { renderStoryWithoutPlay } from "./helpers/compose-story-without-play";

const Empty = composeStory(emptyStory, filterPopoverMeta);

const FILTER_TRIGGER_PATTERN = /^Filter/;
const NO_FILTERS_BADGE = "Filter";
const ONE_CATEGORY_BADGE = "Filter1";
const TWO_CATEGORY_BADGE = "Filter2";
const ASSIGN_TO_ME_ITEM = "Assigned to me";
const IN_REVIEW_LABEL =
  ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.InReview];
const CASE_TIMEOUT_MS = 20_000;

/** Submenu label → a value inside it, as rendered (label plus its count). */
const CATEGORY_VALUES = [
  ["Assignee", "Jordan Lee"],
  ["Status", "Draft"],
  ["Priority", "High"],
  ["Tags", "Quality"],
] as const;

function menuItemStartingWith(text: string) {
  const item = within(document.body)
    .queryAllByRole("menuitem")
    .find((candidate) => candidate.textContent?.trim().startsWith(text));
  if (!item) {
    throw new Error(`no menu item starting with "${text}"`);
  }
  return item;
}

/**
 * The "Assigned to me" row leads with the current user's avatar initials, so it
 * is matched on containment rather than prefix.
 */
function menuItemContaining(text: string) {
  const item = within(document.body)
    .queryAllByRole("menuitem")
    .find((candidate) => candidate.textContent?.includes(text));
  if (!item) {
    throw new Error(`no menu item containing "${text}"`);
  }
  return item;
}

/** Opens the popover on the empty-state story and returns its trigger node. */
async function openEmptyPopover() {
  await Empty.run();
  const trigger = within(document.body).getAllByRole("button", {
    name: FILTER_TRIGGER_PATTERN,
  })[0];
  await userEvent.click(trigger);
  return trigger;
}

describe("FilterPopoverDemo", () => {
  it(
    "starts with no categories applied",
    async () => {
      const trigger = await openEmptyPopover();
      expect(trigger.textContent).toBe(NO_FILTERS_BADGE);
    },
    CASE_TIMEOUT_MS
  );

  it.each(CATEGORY_VALUES)(
    "adds and then removes a %s value",
    async (category, value) => {
      const trigger = await openEmptyPopover();
      await userEvent.click(menuItemStartingWith(category));

      await userEvent.click(menuItemStartingWith(value));
      expect(trigger.textContent).toBe(ONE_CATEGORY_BADGE);

      await userEvent.click(menuItemStartingWith(value));
      expect(trigger.textContent).toBe(NO_FILTERS_BADGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "adds and then removes the current user via Assigned to me",
    async () => {
      const trigger = await openEmptyPopover();

      await userEvent.click(menuItemContaining(ASSIGN_TO_ME_ITEM));
      expect(trigger.textContent).toBe(ONE_CATEGORY_BADGE);

      await userEvent.click(menuItemContaining(ASSIGN_TO_ME_ITEM));
      expect(trigger.textContent).toBe(NO_FILTERS_BADGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "counts two independent categories separately",
    async () => {
      const trigger = await openEmptyPopover();

      await userEvent.click(menuItemStartingWith("Status"));
      await userEvent.click(menuItemStartingWith("Draft"));
      expect(trigger.textContent).toBe(ONE_CATEGORY_BADGE);

      await userEvent.click(menuItemStartingWith("Priority"));
      await userEvent.click(menuItemStartingWith("High"));
      expect(trigger.textContent).toBe(TWO_CATEGORY_BADGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "keeps a category applied while it still holds one value",
    async () => {
      const trigger = await openEmptyPopover();
      await userEvent.click(menuItemStartingWith("Status"));

      await userEvent.click(menuItemStartingWith("Draft"));
      await userEvent.click(menuItemStartingWith(IN_REVIEW_LABEL));
      expect(trigger.textContent).toBe(ONE_CATEGORY_BADGE);

      await userEvent.click(menuItemStartingWith("Draft"));
      expect(trigger.textContent).toBe(ONE_CATEGORY_BADGE);

      await userEvent.click(menuItemStartingWith(IN_REVIEW_LABEL));
      expect(trigger.textContent).toBe(NO_FILTERS_BADGE);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "counts a created-at date filter as one applied category",
    async () => {
      // The base story's own date filter is on `updatedAt`; this is the
      // other arm of the chip label's field switch.
      const base = emptyStory.args?.initialState;
      if (!base) {
        throw new Error("Empty story carries no initialState arg");
      }
      const canvas = await renderStoryWithoutPlay(
        {
          ...emptyStory,
          args: {
            ...emptyStory.args,
            initialState: {
              ...base,
              date: {
                field: TableDateFilterField.CreatedAt,
                preset: TableDatePreset.Last7d,
              },
            },
          },
        },
        filterPopoverMeta
      );
      const trigger = canvas.getAllByRole("button", {
        name: FILTER_TRIGGER_PATTERN,
      })[0];
      expect(trigger?.textContent).toBe(ONE_CATEGORY_BADGE);
    },
    CASE_TIMEOUT_MS
  );
});
