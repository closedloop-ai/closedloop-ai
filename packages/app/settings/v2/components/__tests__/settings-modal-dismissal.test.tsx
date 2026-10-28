import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSettingsPanelRegistry } from "../../lib/settings-panel-registry";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "../settings-dismissal";
import { SettingsShell } from "../settings-shell";

/**
 * ISS-8978 — the modal is operable by keyboard and screen reader, and dismissing
 * it returns the user where they were.
 *
 * Focus trapping, restoration, `Escape`, and the inert underlay are Radix
 * behaviours the shell deliberately does not reimplement, so each case here
 * asserts that the shell is WIRED to get them — a Dialog that had been flattened
 * back into a `div` fails every one of them independently. WCAG 2.1.2 (No
 * Keyboard Trap), 2.4.3 (Focus Order), 2.4.6 (Headings and Labels), 4.1.2
 * (Name, Role, Value).
 */

const registry = createSettingsPanelRegistry([
  fixturePanel("profile"),
  fixturePanel("members"),
]);

const COLD: SettingsDismissal = { mode: SettingsDismissMode.Cold };

const OUTSIDE_BUTTON_LABEL = "Open a branch";
const SURFACE_TEST_ID = "underlying-surface";
const FILTER_LABEL = "Filter branches";
const SCROLLER_TEST_ID = "surface-scroller";
const TRIGGER_LABEL = "Open settings";

const CLOSE_SETTINGS_NAME = /^Close settings$/;
const OUTSIDE_BUTTON_NAME = new RegExp(`^${OUTSIDE_BUTTON_LABEL}$`);
const TRIGGER_NAME = new RegExp(`^${TRIGGER_LABEL}$`);

function shell(
  dismissal: SettingsDismissal,
  routeSearch: Record<string, string> = { panel: "members" }
) {
  return (
    <SettingsShell
      capabilities={grantRead("profile", "members")}
      dismissal={dismissal}
      host={SettingsPanelHost.Web}
      registry={registry}
      routeParams={parseSettingsRouteParams(routeSearch)}
    />
  );
}

/**
 * The underlying surface, with the two kinds of state ISS-8978 names: view state
 * the user typed (a filter) and scroll position. It counts its own mounts so a
 * "restore" that silently remounted the surface — losing everything and
 * rebuilding it from props — cannot pass as a restore.
 */
let surfaceMounts = 0;

function UnderlyingSurface() {
  const [filter, setFilter] = useState("");
  useEffect(() => {
    surfaceMounts += 1;
  }, []);
  return (
    <main data-testid={SURFACE_TEST_ID}>
      <h1>Branches</h1>
      <label htmlFor="branch-filter">{FILTER_LABEL}</label>
      <input
        id="branch-filter"
        onChange={(event) => setFilter(event.target.value)}
        value={filter}
      />
      <div data-testid={SCROLLER_TEST_ID}>scrollable region</div>
      <button type="button">{OUTSIDE_BUTTON_LABEL}</button>
    </main>
  );
}

/**
 * The intercepting-route mount shape (operator decision D2), modelled honestly:
 * the surface is a SIBLING of the modal and is never unmounted, and "settings is
 * open" is the host's own state. An overlay dismiss that navigated instead of
 * calling back would leave `open` true and the dialog on screen — which is what
 * makes the state-preservation case below able to fail.
 */
function InterceptingHost({
  nav,
  initiallyOpen = true,
}: Readonly<{ nav: MemoryNavigation; initiallyOpen?: boolean }>) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <NavigationProvider adapter={nav.adapter}>
      <UnderlyingSurface />
      <button onClick={() => setOpen(true)} type="button">
        {TRIGGER_LABEL}
      </button>
      {open
        ? shell({
            mode: SettingsDismissMode.Overlay,
            onDismiss: () => setOpen(false),
          })
        : null}
    </NavigationProvider>
  );
}

function newNav(): MemoryNavigation {
  return createMemoryNavigation({ initialPath: "/branches", orgSlug: "acme" });
}

describe("settings modal dismissal and accessibility (ISS-8978)", () => {
  it("traps focus inside the dialog while it is open", async () => {
    const nav = newNav();
    render(<InterceptingHost nav={nav} />);

    // Queried by text, not by role: while the modal is open the surface is out
    // of the accessibility tree entirely, which the inert case below asserts.
    const outside = screen.getByText(OUTSIDE_BUTTON_LABEL);
    outside.focus();

    // Radix pulls focus back the moment it lands outside the content. Without
    // the Dialog around the shell, focus simply stays on the outside control.
    await waitFor(() => {
      expect(
        screen.getByTestId("settings-shell").contains(document.activeElement)
      ).toBe(true);
    });
    expect(document.activeElement).not.toBe(outside);
  });

  it("restores focus to the control that opened it", async () => {
    const nav = newNav();
    const user = userEvent.setup();
    render(<InterceptingHost initiallyOpen={false} nav={nav} />);

    const trigger = screen.getByRole("button", {
      name: TRIGGER_NAME,
    });
    // Focused first, then activated: that is the state a keyboard user is in
    // when they open Settings, and it is the element Radix has to hand back.
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByTestId("settings-shell")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(trigger);

    await user.click(screen.getByRole("button", { name: CLOSE_SETTINGS_NAME }));

    // Radix restores on a macrotask after the scope tears down, so this is a
    // real wait rather than a synchronous read.
    await waitFor(
      () => {
        expect(document.activeElement).toBe(trigger);
      },
      { timeout: 3000 }
    );
  });

  it("dismisses on Escape", async () => {
    const onDismiss = vi.fn();
    const nav = newNav();
    const user = userEvent.setup();
    render(
      <NavigationProvider adapter={nav.adapter}>
        {shell({ mode: SettingsDismissMode.Overlay, onDismiss })}
      </NavigationProvider>
    );

    expect(onDismiss).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("makes the underlying surface inert while open, and reachable again after", async () => {
    const nav = newNav();
    const user = userEvent.setup();
    render(<InterceptingHost nav={nav} />);

    // The surface is out of the accessibility tree, not merely covered: a
    // screen-reader user cannot reach the control behind the scrim at all.
    expect(
      screen.queryByRole("button", { name: OUTSIDE_BUTTON_NAME })
    ).not.toBeInTheDocument();
    // It is still rendered, so this is inertness rather than an unmount.
    expect(screen.getByText(OUTSIDE_BUTTON_LABEL)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: CLOSE_SETTINGS_NAME }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: OUTSIDE_BUTTON_NAME })
      ).toBeInTheDocument();
    });
  });

  it("keeps the underlying surface's state across a full open/dismiss cycle", async () => {
    surfaceMounts = 0;
    const nav = newNav();
    const user = userEvent.setup();
    render(<InterceptingHost initiallyOpen={false} nav={nav} />);

    const filter = screen.getByLabelText(FILTER_LABEL);
    await user.type(filter, "release");
    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    scroller.scrollTop = 480;

    await user.click(screen.getByRole("button", { name: TRIGGER_NAME }));
    expect(screen.getByTestId("settings-shell")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: CLOSE_SETTINGS_NAME }));
    await waitFor(() => {
      expect(screen.queryByTestId("settings-shell")).not.toBeInTheDocument();
    });

    // The same DOM node, holding the same values — not a rebuilt surface that
    // happens to look similar.
    expect(screen.getByTestId(SCROLLER_TEST_ID)).toBe(scroller);
    expect(scroller.scrollTop).toBe(480);
    expect(screen.getByLabelText(FILTER_LABEL)).toHaveValue("release");
    expect(surfaceMounts).toBe(1);
  });

  it("navigates nowhere on an overlay dismiss, so it cannot claim a restore it did not perform", async () => {
    const nav = newNav();
    const user = userEvent.setup();
    render(<InterceptingHost nav={nav} />);

    const historyBefore = [...nav.getHistory()];
    await user.click(screen.getByRole("button", { name: CLOSE_SETTINGS_NAME }));

    await waitFor(() => {
      expect(screen.queryByTestId("settings-shell")).not.toBeInTheDocument();
    });
    expect(nav.getHistory()).toEqual(historyBefore);
    expect(nav.getCurrentHref()).toBe("/branches");
  });

  it("navigates to the close route on a cold dismiss, where there is nothing to restore", async () => {
    const nav = newNav();
    const user = userEvent.setup();
    render(
      <NavigationProvider adapter={nav.adapter}>
        {shell(COLD, { panel: "members", returnTo: "/acme/branches" })}
      </NavigationProvider>
    );

    // Escape and the scrim cannot be anchors, so the cold path still has to
    // navigate — and it must land on the same target the rail's link advertises.
    expect(
      screen.getByRole("link", { name: CLOSE_SETTINGS_NAME })
    ).toHaveAttribute("href", "/acme/branches");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(nav.getCurrentHref()).toBe("/acme/branches");
    });
  });
});
