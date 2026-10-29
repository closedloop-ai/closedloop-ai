import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useAgentComponentsViewState } from "../../../hooks/use-agent-components-view-state";
import { AgentsViewMenu } from "../agents-view-menu";

/**
 * ISS-5541 part 2 — the keyboard pass the 2026-08-08 Agents sweep could not do.
 *
 * That sweep's synthetic CDP `Tab` events never left `BODY`, so nothing was
 * established about the View popover either way. This drives the real control
 * with `@testing-library/user-event`, which dispatches the key sequence a
 * browser does (keydown → keypress → click for Enter on a button) rather than a
 * bare `keydown` a component can ignore.
 *
 * WCAG 2.2 SC 2.1.1 Keyboard (Level A) — every function operable from a
 * keyboard — and SC 2.1.2 No Keyboard Trap (Level A), which is what the Escape
 * case below is about: a popover that opens on Enter and then strands focus
 * inside itself is worse for a keyboard user than one that never opened.
 *
 * SCOPE, HONESTLY. This is a jsdom pass over ONE control. It cannot speak to
 * focus VISIBILITY (SC 2.4.7), which needs a rendered stylesheet, and it is not
 * the browser-level pass the ticket asks for — that needs the app booted, which
 * this worktree cannot do. The row kebab is also absent on purpose: its suite
 * mocks Radix's `DropdownMenu` away because the real open interaction is flaky
 * under jsdom, so a keyboard assertion there would be measuring the mock.
 */

const VIEW_MENU_TRIGGER_NAME = "View";

describe("Agents View popover keyboard traversal", () => {
  it("is reachable by Tab and opens from the keyboard", async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole("button", {
      name: VIEW_MENU_TRIGGER_NAME,
    });
    // Reachability is the claim the sweep could not make. Tab from the document
    // body must land on the control — not merely find it in the DOM.
    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "true")
    );
  });

  it("moves focus into the popover and walks its controls with Tab", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.tab();
    await user.keyboard("{Enter}");
    const popover = await screen.findByRole("dialog");

    // Radix moves focus into the popover on open; without that a keyboard user
    // opens it and is left behind it, still on the trigger.
    await waitFor(() => expect(popover).toContainElement(activeElement()));
    const entry = activeElement();

    await user.tab();
    // The paired positive: focus actually MOVED, and stayed inside. Asserting
    // only "focus is inside the popover" passes on one whose Tab does nothing.
    expect(activeElement()).not.toBe(entry);
    expect(popover).toContainElement(activeElement());
  });

  it("reaches the popover's own single-select group and traverses it with arrows", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.tab();
    await user.keyboard("{Enter}");
    const popover = await screen.findByRole("dialog");

    // ISS-5540 gave this group its `radiogroup` role; this is the other half of
    // that promise — the group is operable from the keyboard once reached.
    const radios = within(popover).getAllByRole("radio");
    act(() => radios[0].focus());
    await user.keyboard("{ArrowRight}");

    expect(radios[1]).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole("button", {
      name: VIEW_MENU_TRIGGER_NAME,
    });
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Not a keyboard trap, and not a lost place either: a dismissal that drops
    // focus to `body` costs the user their position in the toolbar.
    expect(trigger).toHaveFocus();
  });
});

function activeElement(): HTMLElement {
  return document.activeElement as HTMLElement;
}

function WiredMenu() {
  const { groupBy, setGroupBy, resetColumns, toggleColumn, visibleColumns } =
    useAgentComponentsViewState();

  return (
    <AgentsViewMenu
      groupBy={groupBy}
      onGroupByChange={setGroupBy}
      onReset={resetColumns}
      onToggleColumn={toggleColumn}
      visibleColumns={visibleColumns}
    />
  );
}

function renderMenu() {
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <WiredMenu />
    </AppCoreStoryProviders>
  );
}
