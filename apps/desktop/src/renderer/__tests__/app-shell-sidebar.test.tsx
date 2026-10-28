/**
 * Desktop app-shell: sidebar persistence and resilience (ISS-5147 split).
 *
 * Split out of the former monolithic `app-shell.test.tsx`. Owns one
 * responsibility: whether the shell's sidebar and Labs-section open/closed state
 * survives a remount, hydrates from storage, and degrades safely when
 * `localStorage` is unreadable or unwritable. Routing, the Sessions surface, and
 * the Labs container gate live in the sibling `app-shell-*.test.tsx` files.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dashboardOnboardedStorageKey } from "../components/dashboard/dashboard-storage-keys";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "../components/layout/sidebar-persistence";
import { pageTitleForNav } from "../navigation/nav-config";
import { NavId } from "../navigation/route-table";
import {
  DASHBOARD_NAV_LINK_RE,
  DESKTOP_SIDEBAR_OPEN_STORAGE_KEY,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

describe("App shell sidebar persistence", () => {
  setupAppShellSuite();

  it("persists desktop sidebar state across app shell remounts", async () => {
    const collapsedRender = renderDesktopApp("");

    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    fireEvent.click(screen.getByTitle("Collapse sidebar"));
    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
    expect(window.localStorage.getItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY)).toBe(
      "false"
    );
    collapsedRender.unmount();

    const expandedRender = renderDesktopApp("");
    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
    fireEvent.click(screen.getByTitle("Expand sidebar"));
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    expect(window.localStorage.getItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY)).toBe(
      "true"
    );
    expandedRender.unmount();

    renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
  });

  it("persists the desktop Labs nav section after app shell remounts", async () => {
    const firstRender = renderDesktopApp("");
    const labsToggle = await screen.findByRole("button", { name: "Labs" });

    expect(labsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Insights) })
    ).toBeNull();

    fireEvent.click(labsToggle);

    expect(labsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
    expect(
      window.localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)
    ).toBe("true");
    firstRender.unmount();

    renderDesktopApp("");

    const restoredLabsToggle = await screen.findByRole("button", {
      name: "Labs",
    });
    expect(restoredLabsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
  });

  it("hydrates the desktop Labs nav section from storage on initial app shell load", async () => {
    window.localStorage.setItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY, "true");

    renderDesktopApp("");

    const labsToggle = await screen.findByRole("button", { name: "Labs" });
    expect(labsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
  });

  it("defaults desktop sidebar expanded for missing or corrupt persisted values", async () => {
    window.localStorage.setItem(
      `${DESKTOP_SIDEBAR_OPEN_STORAGE_KEY}.similar`,
      "false"
    );
    const wrongKeyRender = renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    wrongKeyRender.unmount();

    window.localStorage.clear();
    // Re-seed what `clear()` just wiped. This case is about the SIDEBAR key, and
    // an install with no first-run key stored is a first run, so an unqualified
    // clear here opens the guided onboarding modal over the shell being asserted
    // on.
    window.localStorage.setItem(dashboardOnboardedStorageKey, "1");
    window.localStorage.setItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, "collapsed");
    renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
  });

  it("defaults desktop sidebar expanded when localStorage read is unavailable", async () => {
    // Scoped to the sidebar key rather than throwing for every read. A blanket
    // throw also blocks the first-run keys, and the first-launch dashboard reads
    // an unreadable first-run key as "first launch" — so its reveal and tour
    // would play over the shell and this case would be measuring the wrong
    // screen. The narrower
    // fixture is also the more honest one: it is the sidebar read that is
    // unavailable.
    //
    // A wrapper object rather than `vi.spyOn`, because the installed store's
    // `getItem` is itself a `vi.fn`: spying on it and delegating back to the
    // captured reference re-enters the same mock, and the overflow surfaces as
    // every read failing rather than just the one this case blocks.
    const realStorage = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        ...realStorage,
        getItem: (key: string) => {
          if (key === DESKTOP_SIDEBAR_OPEN_STORAGE_KEY) {
            throw new Error("localStorage read blocked");
          }
          return realStorage.getItem(key);
        },
        setItem: (key: string, value: string) =>
          realStorage.setItem(key, value),
      },
    });
    const fallbackRender = renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();
    fallbackRender.unmount();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: realStorage,
    });

    window.localStorage.setItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, "false");
    renderDesktopApp("");
    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
  });

  it("renders the dashboard nav link with no loading throbber", async () => {
    renderDesktopApp("");

    const dashboardLink = await screen.findByRole("link", {
      name: DASHBOARD_NAV_LINK_RE,
    });
    // Desktop port Links render their href hash-prefixed (FEA-4018) so a
    // browser-deferred modifier/middle-click resolves in-app.
    expect(dashboardLink.getAttribute("href")).toBe("#/dashboard");
    // The antiquated "preparing" throbber has been removed — the Dashboard nav
    // item renders and navigates with no trailing spinner.
    expect(screen.queryByLabelText("Preparing dashboard")).toBeNull();
  });

  // ISS-4478: Diagnostics + Settings moved out of the top-level sidebar nav into
  // the bottom-left account menu (mirroring web's AccountMenu). That menu's own
  // coverage — trigger label, item order, active-check — lives in the dedicated
  // `components/layout/__tests__/sidebar-account-menu.test.tsx` render test,
  // keeping this app-shell suite from accumulating it.

  it("keeps desktop sidebar responsive when localStorage write fails", async () => {
    window.localStorage.setItem(DESKTOP_SIDEBAR_OPEN_STORAGE_KEY, "true");
    renderDesktopApp("");
    expect(await screen.findByTitle("Collapse sidebar")).toBeDefined();

    const setItemSpy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("localStorage write blocked");
      });

    fireEvent.click(screen.getByTitle("Collapse sidebar"));

    expect(await screen.findByTitle("Expand sidebar")).toBeDefined();
    expect(setItemSpy).toHaveBeenCalledWith(
      DESKTOP_SIDEBAR_OPEN_STORAGE_KEY,
      "false"
    );
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});
