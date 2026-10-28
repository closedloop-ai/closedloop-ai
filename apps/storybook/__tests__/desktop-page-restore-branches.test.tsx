/**
 * Branch tests for `stories/surfaces-v2/test/desktop-page.tsx` — the desktop
 * page harness installs a preload bridge, pins `navigator.onLine`, and opens
 * the Labs sidebar section for a Labs page, then undoes all three on unmount.
 * The story sweep only mounts it fresh, so the restore-what-was-there arms and
 * the non-Labs page arm were reachable only from here.
 */
import { composeStory } from "@storybook/react";
import { render as rtlRender } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "../../desktop/src/renderer/components/layout/sidebar-persistence";
import {
  NavSection,
  navSectionFor,
} from "../../desktop/src/renderer/navigation/nav-config";
import { NavId } from "../../desktop/src/renderer/navigation/route-table";
import { DesktopPage } from "../stories/surfaces-v2/test/desktop-page";

const PRESET_BRIDGE = { preset: true };
const NON_LABS_NAV = NavId.Sessions;
const LABS_NAV = NavId.Requests;

// The preview's global decorators supply the providers the desktop shell
// reads (navigation, query client); a one-off story picks them up.
const HarnessStory = composeStory(
  { render: (args) => <>{args.ui as ReactNode}</> },
  { title: "Test/DesktopPage" }
);

function render(ui: ReactNode) {
  const result = rtlRender(<HarnessStory ui={ui} />);
  return {
    ...result,
    rerender: (next: ReactNode) => result.rerender(<HarnessStory ui={next} />),
  };
}

type DesktopWindow = Window & { desktopApi?: unknown };

let windowBridge: PropertyDescriptor | undefined;
let navigatorOnLine: PropertyDescriptor | undefined;
let storedLabs: string | null;

beforeEach(() => {
  windowBridge = Object.getOwnPropertyDescriptor(window, "desktopApi");
  navigatorOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  storedLabs = localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY);
});

afterEach(() => {
  if (windowBridge) {
    Object.defineProperty(window, "desktopApi", windowBridge);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  if (navigatorOnLine) {
    Object.defineProperty(navigator, "onLine", navigatorOnLine);
  } else {
    Reflect.deleteProperty(navigator, "onLine");
  }
  if (storedLabs === null) {
    localStorage.removeItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY);
  } else {
    localStorage.setItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY, storedLabs);
  }
});

describe("DesktopPage harness restore", () => {
  it("uses the nav ids the cases below rely on", () => {
    expect(navSectionFor(NON_LABS_NAV)).not.toBe(NavSection.Labs);
    expect(navSectionFor(LABS_NAV)).toBe(NavSection.Labs);
  });

  it("puts back a bridge that was already installed, and installs once across re-renders", () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: PRESET_BRIDGE,
      writable: true,
    });
    const { rerender, unmount } = render(
      <DesktopPage navId={NON_LABS_NAV}>
        <p>page</p>
      </DesktopPage>
    );
    const installed = (window as DesktopWindow).desktopApi;
    expect(installed).not.toBe(PRESET_BRIDGE);
    expect(installed).toHaveProperty("getDesktopAuthState");

    rerender(
      <DesktopPage navId={NON_LABS_NAV}>
        <p>page again</p>
      </DesktopPage>
    );
    expect((window as DesktopWindow).desktopApi).toBe(installed);

    unmount();
    expect((window as DesktopWindow).desktopApi).toBe(PRESET_BRIDGE);
  });

  it("leaves the Labs section key alone for a non-Labs page", () => {
    localStorage.removeItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY);
    const { unmount } = render(
      <DesktopPage navId={NON_LABS_NAV}>
        <p>page</p>
      </DesktopPage>
    );
    expect(
      localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)
    ).toBeNull();
    unmount();
    expect(
      localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)
    ).toBeNull();
  });

  it("opens Labs for a Labs page and restores the earlier stored value", () => {
    localStorage.setItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY, "false");
    const { unmount } = render(
      <DesktopPage navId={LABS_NAV}>
        <p>page</p>
      </DesktopPage>
    );
    expect(localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)).toBe(
      "true"
    );
    unmount();
    expect(localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY)).toBe(
      "false"
    );
  });

  it("pins navigator.onLine while mounted and removes the pin when none existed", () => {
    Reflect.deleteProperty(navigator, "onLine");
    const { unmount } = render(
      <DesktopPage navId={NON_LABS_NAV}>
        <p>page</p>
      </DesktopPage>
    );
    expect(Object.getOwnPropertyDescriptor(navigator, "onLine")).toBeDefined();
    expect(navigator.onLine).toBe(true);
    unmount();
    expect(
      Object.getOwnPropertyDescriptor(navigator, "onLine")
    ).toBeUndefined();
  });
});
