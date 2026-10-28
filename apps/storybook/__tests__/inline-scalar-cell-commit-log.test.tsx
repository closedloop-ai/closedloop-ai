/**
 * Behavior test for the Inline Scalar Cell demo's commit log.
 *
 * The log has two shapes and the sweep only ever paints the empty one: nothing
 * has been committed at mount. Committing a value is what swaps it for the
 * ordered list, and the entries are asserted in order — an append that replaced
 * the log, or reversed it, would still leave one entry behind and pass a count.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import inlineScalarCellMeta, {
  CommitAndCancel as commitAndCancelStory,
} from "../stories/inline-scalar-cell.stories";

const CommitAndCancel = composeStory(
  commitAndCancelStory,
  inlineScalarCellMeta
);

const FIELD_LABEL = "Estimate";
const EMPTY_LOG_TEXT = "Nothing committed yet.";
const CASE_TIMEOUT_MS = 20_000;

/** The committed values the log lists, in painted order. */
function loggedCommits(): string[] {
  const list = document.body.querySelector("ol");
  if (!list) {
    return [];
  }
  return Array.from(list.querySelectorAll("li")).map(
    (item) => item.textContent ?? ""
  );
}

async function commit(next: string) {
  // A cell that already holds a value renders its input directly, so there is
  // no separate "start editing" affordance to press first.
  const input = within(document.body).getByLabelText(FIELD_LABEL);
  await userEvent.clear(input);
  await userEvent.type(input, `${next}{Enter}`);
}

describe("inline scalar cell commit log", () => {
  it(
    "swaps the empty-state sentence for the committed values, newest last",
    async () => {
      await CommitAndCancel.run();
      expect(within(document.body).getByText(EMPTY_LOG_TEXT)).toBeVisible();
      expect(loggedCommits()).toEqual([]);

      await commit("9");
      expect(loggedCommits()).toEqual(["9"]);
      expect(within(document.body).queryByText(EMPTY_LOG_TEXT)).toBeNull();

      await commit("11");
      expect(loggedCommits()).toEqual(["9", "11"]);
    },
    CASE_TIMEOUT_MS
  );
});
