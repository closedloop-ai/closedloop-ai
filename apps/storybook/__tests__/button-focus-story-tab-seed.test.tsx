/**
 * The Focus story's play function, held against the document shape the Docs
 * page actually gives it.
 *
 * `meta` carries `autodocs`, so on the Docs page every Button story shares one
 * document and `userEvent.tab()` — which walks from `document.activeElement`,
 * a document-level property — starts outside this story's canvas. The story
 * sweep cannot see that: portable stories mount alone, so the first tab stop
 * in the document IS the story's own button and the assertion passes whether
 * or not the play seeds focus. This case puts a tabbable element earlier in
 * the document first, which is the only shape that tells the two apart.
 */
import { composeStory } from "@storybook/react";
import { describe, expect, it } from "vitest";
import buttonMeta, { Focus as focusStory } from "../stories/button.stories";

const Focus = composeStory(focusStory, buttonMeta);

/** Stands in for a sibling story mounted above this one on the Docs page. */
function mountEarlierTabbableSibling() {
  const sibling = document.createElement("button");
  sibling.textContent = "Default";
  document.body.insertBefore(sibling, document.body.firstChild);
  return sibling;
}

describe("Button Focus story", () => {
  it("lands focus on its own button with a sibling tab stop above it", async () => {
    const sibling = mountEarlierTabbableSibling();

    await Focus.run();

    expect(document.activeElement).not.toBe(sibling);
    expect(document.activeElement?.textContent).toBe("Focused Button");
  });
});
