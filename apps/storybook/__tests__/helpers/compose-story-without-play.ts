/**
 * Runs a story with its `play` stripped, so a test owns the state transitions
 * the story's own `play` would otherwise have driven.
 *
 * Third site for this three-line idiom (`grid-table-v2-card-list-collapse`,
 * `table-grid-header-v2-select-all`, `filter-popover-demo`), so it lives here
 * rather than being re-typed per file.
 */
import { composeStory } from "@storybook/react";
import { within } from "storybook/test";

type ComposeStoryParameters = Parameters<typeof composeStory>;

export async function renderStoryWithoutPlay(
  story: ComposeStoryParameters[0],
  meta: ComposeStoryParameters[1]
) {
  const Story = composeStory({ ...story, play: undefined }, meta);
  await Story.run();
  return within(document.body);
}
