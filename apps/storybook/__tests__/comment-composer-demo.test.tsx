/**
 * Behavior tests for the Comment Composer story wrapper's cancel path.
 *
 * The wrapper — not the component — decides what Cancel restores: it resets its
 * own value to the story's `defaultValue`, falling back to empty when the story
 * declares none. Only `InlineEdit` renders a Cancel button at all, and the
 * sweep never presses it, so both arms of that fallback are driven here.
 */
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import commentComposerMeta, {
  InlineEdit as inlineEditStory,
} from "../stories/comment-composer.stories";

const InlineEdit = composeStory(inlineEditStory, commentComposerMeta);

/** The same story with the control a viewer can clear actually cleared. */
const InlineEditWithoutDefault = composeStory(
  {
    ...inlineEditStory,
    args: { ...inlineEditStory.args, defaultValue: undefined },
  },
  commentComposerMeta
);

const EDIT_LABEL = "Edit comment";
const CANCEL_LABEL = "Cancel";
const SEEDED_TEXT =
  "The error handling still needs a user-facing fallback for timeout cases.";
const TYPED_TEXT = " And a retry.";
const CASE_TIMEOUT_MS = 20_000;

function editor(): HTMLTextAreaElement {
  return within(document.body).getByLabelText(
    EDIT_LABEL
  ) as HTMLTextAreaElement;
}

async function cancel() {
  await userEvent.click(
    within(document.body).getByRole("button", { name: CANCEL_LABEL })
  );
}

describe("comment composer InlineEdit story", () => {
  it(
    "drops the typed draft for the story's default text when cancelling",
    async () => {
      await InlineEdit.run();
      // Pins current behavior, and it looks odd: the wrapper seeds its state
      // from `args.value`, which this story does not set, so the editor opens
      // EMPTY even though the story declares a `defaultValue`. That default is
      // only reachable through Cancel, which therefore inserts text rather than
      // restoring it.
      expect(editor().value).toBe("");

      await userEvent.type(editor(), TYPED_TEXT);
      expect(editor().value).toBe(TYPED_TEXT);

      await cancel();
      expect(editor().value).toBe(SEEDED_TEXT);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "clears the draft when the story declares no default text",
    async () => {
      await InlineEditWithoutDefault.run();
      expect(editor().value).toBe("");

      await userEvent.type(editor(), TYPED_TEXT);
      expect(editor().value).toBe(TYPED_TEXT);

      await cancel();
      // Falls back to empty rather than to `undefined`, which would hand the
      // textarea an uncontrolled value and strand the typed draft on screen.
      expect(editor().value).toBe("");
    },
    CASE_TIMEOUT_MS
  );
});
