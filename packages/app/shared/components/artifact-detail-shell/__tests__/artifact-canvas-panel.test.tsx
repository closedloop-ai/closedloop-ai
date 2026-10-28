import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-12412. jsdom lays nothing out, so the canvas wrapper's classes are the
 * observable contract: a padded body scrolls inside the card, while a `fill`
 * body (the Session workspace, which owns its scroller and pinned timeline)
 * is sized by the card and brings its own inset.
 */
function canvasWrapper(label: string): HTMLElement {
  const wrapper = screen.getByRole("region", { name: label }).firstElementChild;
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error(`Expected the ${label} card's canvas wrapper`);
  }
  return wrapper;
}

describe("ArtifactCanvasPanel", () => {
  it("pads a body that scrolls inside the card", () => {
    render(<ArtifactCanvasPanel label="Details">body</ArtifactCanvasPanel>);
    expect(canvasWrapper("Details")).toHaveClass("px-5", "pt-4", "pb-6");
    expect(canvasWrapper("Details")).not.toHaveClass("flex-1");
  });

  it("sizes a fill body to the card, unpadded, so its own scroller bounds it", () => {
    render(
      <ArtifactCanvasPanel fill label="Session">
        body
      </ArtifactCanvasPanel>
    );
    expect(canvasWrapper("Session")).toHaveClass("flex-1", "min-h-0");
    expect(canvasWrapper("Session")).not.toHaveClass("px-5");
  });
});
