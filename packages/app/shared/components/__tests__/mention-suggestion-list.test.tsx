// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionUser } from "../../lib/mentions";
import { MentionSuggestionList } from "../mention-suggestion-list";

/** PLN-2189 T-2.8: the shared @-mention menu, as the body picker drives it. */
const MEMBERS: MentionUser[] = ["a", "b", "c", "d", "e", "f"].map((id) => ({
  id,
  firstName: `Member ${id}`,
  lastName: null,
  email: `${id}@example.com`,
  active: true,
}));

const CARET = new DOMRect(40, 40, 0, 18);

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView"
);
const scrollIntoView = vi.fn();

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  scrollIntoView.mockReset();
  if (originalScrollIntoView) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

describe("MentionSuggestionList", () => {
  it("scrolls the keyboard-highlighted row into the capped list, wrapping included", () => {
    const view = renderList({ activeIndex: 0 });
    expect(lastScrolled()).toBe(option("Member a"));

    view.rerender(listElement({ activeIndex: 5 }));
    expect(lastScrolled()).toBe(option("Member f"));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });

    view.rerender(listElement({ activeIndex: 0 }));
    expect(lastScrolled()).toBe(option("Member a"));
  });

  it("does not scroll the composer's plain button rows", () => {
    renderList({});

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a caret menu's right edge on screen", () => {
    const nearRightEdge = globalThis.innerWidth - 20;
    renderList({ anchorRect: new DOMRect(nearRightEdge, 40, 0, 18) });

    const menu = screen.getByTestId("mention-suggestions");
    expect(menu.style.width).toBe("288px");
    expect(menu.style.left).toBe(`${globalThis.innerWidth - 288 - 4}px`);
  });

  it("opens at a caret with room to its right", () => {
    renderList({});

    expect(screen.getByTestId("mention-suggestions").style.left).toBe("40px");
  });

  it("mounts into the given container", () => {
    const container = globalThis.document.createElement("div");
    globalThis.document.body.append(container);

    renderList({ activeIndex: 0, container });

    expect(container.contains(screen.getByRole("listbox"))).toBe(true);
    container.remove();
  });
});

type ListOverrides = Partial<Parameters<typeof MentionSuggestionList>[0]>;

function listElement(overrides: ListOverrides) {
  return (
    <MentionSuggestionList
      anchorRect={CARET}
      matchAnchorWidth={false}
      onSelect={() => undefined}
      suggestions={MEMBERS}
      {...overrides}
    />
  );
}

function renderList(overrides: ListOverrides) {
  return render(listElement(overrides));
}

function option(name: string) {
  return screen.getByRole("option", { name: new RegExp(name) });
}

function lastScrolled() {
  return scrollIntoView.mock.contexts.at(-1);
}
