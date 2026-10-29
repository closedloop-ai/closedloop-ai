import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { ThemeSubmenu } from "@closedloop-ai/design-system/components/ui/theme-submenu";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9889. `ThemeSubmenu` is mounted by three menus that do NOT agree on
 * whether a row carries a glyph: the legacy web account menu and the desktop
 * sidebar give every row an icon, the v2 workspace menu gives none. So the
 * trigger has to render both ways, and the prop deciding it distinguishes
 * "caller said nothing" (`undefined` — take the dynamic sun/moon/monitor
 * default) from "caller asked for no glyph" (`null`).
 *
 * That distinction is one character of implementation (`??` versus an explicit
 * `undefined` check) and is invisible to a consumer test that only asserts the
 * word "Theme" appears, which is why it is pinned in the component's own lane
 * rather than left to the three surfaces that mount it.
 */

const MENU_TRIGGER_LABEL = "Open";
const THEME_ROW_LABEL = "Theme";
const DARK_OPTION_LABEL = "Dark";
const SUB_TRIGGER_SLOT = '[data-slot="dropdown-menu-sub-trigger"]';
const SUB_CONTENT_SLOT = '[data-slot="dropdown-menu-sub-content"]';
/** The class the sub-trigger primitive puts on its own trailing chevron. */
const SUB_TRIGGER_CHEVRON_CLASS = "ml-auto";
/** Light, Dark, System — pinned independently of the component under test. */
const THEME_OPTION_COUNT = 3;

/**
 * Opens the host menu and returns the theme sub-trigger. Radix dropdowns open
 * on pointerdown, not click. Returning the element keeps a caller from
 * asserting against a menu that never opened — every "renders no icon"
 * assertion below is equally satisfied by a menu that rendered nothing.
 */
function openHostMenu(node: ReactNode): HTMLElement {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>{MENU_TRIGGER_LABEL}</DropdownMenuTrigger>
      <DropdownMenuContent>{node}</DropdownMenuContent>
    </DropdownMenu>
  );
  fireEvent.pointerDown(screen.getByText(MENU_TRIGGER_LABEL), {
    button: 0,
    ctrlKey: false,
  });
  const trigger = screen
    .getByText(THEME_ROW_LABEL)
    .closest(SUB_TRIGGER_SLOT) as HTMLElement | null;
  if (!trigger) {
    throw new Error("theme sub-trigger did not render");
  }
  return trigger;
}

/**
 * The trigger's LEADING glyph, or null when it renders none. Not simply "does
 * the trigger contain an svg": `DropdownMenuSubTrigger` always appends its own
 * `ml-auto` chevron, so that question answers yes on every branch and an
 * icon-suppression assertion built on it could never fail.
 */
function leadingGlyph(trigger: HTMLElement): Element | null {
  const first = trigger.firstElementChild;
  if (!first || first.classList.contains(SUB_TRIGGER_CHEVRON_CLASS)) {
    return null;
  }
  return first;
}

/** Opens the theme flyout from its trigger and returns the panel element. */
function openThemeFlyout(trigger: HTMLElement): HTMLElement {
  fireEvent.click(trigger);
  const panel = screen
    .getByText(DARK_OPTION_LABEL)
    .closest(SUB_CONTENT_SLOT) as HTMLElement | null;
  if (!panel) {
    throw new Error("theme flyout did not open");
  }
  return panel;
}

describe("ThemeSubmenu trigger icon", () => {
  it("renders the dynamic theme icon when the caller passes no icon", () => {
    const trigger = openHostMenu(<ThemeSubmenu />);

    expect(leadingGlyph(trigger)?.tagName).toBe("svg");
  });

  it("renders a text-only trigger when the caller passes null", () => {
    // The positive case above is what makes this mean something: on its own it
    // is equally satisfied by a submenu that failed to render at all.
    const trigger = openHostMenu(<ThemeSubmenu icon={null} />);

    expect(trigger).toHaveTextContent(THEME_ROW_LABEL);
    expect(leadingGlyph(trigger)).toBeNull();
  });

  it("renders a caller-supplied icon instead of the dynamic one", () => {
    const trigger = openHostMenu(
      <ThemeSubmenu icon={<span data-icon="fixed" />} />
    );

    expect(leadingGlyph(trigger)).toHaveAttribute("data-icon", "fixed");
  });
});

describe("ThemeSubmenu host class hooks", () => {
  it("dresses the trigger and the flyout separately", () => {
    const trigger = openHostMenu(
      <ThemeSubmenu
        contentClassName="test-panel"
        icon={null}
        itemClassName="test-row"
      />
    );

    expect(trigger).toHaveClass("test-row");
    expect(trigger).not.toHaveClass("test-panel");

    // The flyout is the part a host most easily forgets to dress, so asserting
    // the trigger alone would stay green with the panel on the primitive
    // default — which is exactly the state this component shipped in.
    const panel = openThemeFlyout(trigger);
    expect(panel).toHaveClass("test-panel");
    expect(panel).not.toHaveClass("test-row");
  });

  it("gives the flyout options the same row rhythm as the trigger", () => {
    // The options are rows of this control too. Dressing only the trigger left
    // a flyout denser than the one the sibling submenu opens in the same menu,
    // and no prop existed to fix it from the call site.
    const trigger = openHostMenu(
      <ThemeSubmenu icon={null} itemClassName="test-row" />
    );
    const panel = openThemeFlyout(trigger);

    const options = within(panel).getAllByRole("menuitemradio");
    expect(options).toHaveLength(THEME_OPTION_COUNT);
    for (const option of options) {
      expect(option).toHaveClass("test-row");
    }
  });
});
