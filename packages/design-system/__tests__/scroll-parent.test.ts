/**
 * ISS-12288 — the scroll-container walk a component uses to find the scroller it
 * was mounted inside.
 *
 * `null` is the answer that matters: it means nothing here scrolls, and a caller
 * that read it as "the document scrolls" would measure a page where it meant to
 * measure a pane.
 */

import { resolveScrollParent } from "@closedloop-ai/design-system/lib/scroll-parent";
import { afterEach, describe, expect, it } from "vitest";

function mount(...overflowValues: readonly string[]): HTMLElement {
  let parent: HTMLElement = document.body;
  for (const overflow of overflowValues) {
    const element = document.createElement("div");
    element.style.overflowY = overflow;
    parent.append(element);
    parent = element;
  }
  const leaf = document.createElement("div");
  parent.append(leaf);
  return leaf;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("resolveScrollParent", () => {
  it.each(["auto", "scroll", "overlay"])(
    "returns the nearest ancestor whose overflow-y is %s",
    (overflow) => {
      const leaf = mount(overflow);

      expect(resolveScrollParent(leaf)).toBe(leaf.parentElement);
    }
  );

  it("walks past ancestors that do not scroll", () => {
    const leaf = mount("auto", "hidden", "visible");

    expect(resolveScrollParent(leaf)).toBe(
      leaf.parentElement?.parentElement?.parentElement
    );
  });

  it.each(["visible", "hidden", "clip"])(
    "returns null when every ancestor is %s",
    (overflow) => {
      expect(resolveScrollParent(mount(overflow, overflow))).toBeNull();
    }
  );

  it("returns the NEAREST scroller when several ancestors scroll", () => {
    const leaf = mount("auto", "scroll");

    expect(resolveScrollParent(leaf)).toBe(leaf.parentElement);
  });

  it("returns null for a node with no parent at all", () => {
    expect(resolveScrollParent(null)).toBeNull();
    expect(resolveScrollParent(document.createElement("div"))).toBeNull();
  });
});
