// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Experience } from "./components/experience";

// Behavior coverage for the flow the pure flow-reducer test can't reach: the
// blocking takeover's rendered controls, the per-level Save confirmation, and
// the 3-second auto-dismiss timer that advances to the Sessions page. Drives the
// real components with fake timers rather than asserting the reducer in
// isolation.
//
// Note the takeover renders the Sessions page dimmed behind it in `preview`
// mode, so Sessions *content* (e.g. "Recent sessions") is on screen throughout.
// The load-bearing distinguishers are the takeover heading ("Choose your sync
// level"), which is gone once dismissed, and the prototype-control strip, which
// preview mode suppresses and only the LIVE Sessions page renders.

const TAKEOVER_HEADING = "Sync Permissions";
const LIVE_SESSIONS_MARKER = /Prototype control/i;
const FULL_TRANSCRIPTS_RE = /Full transcripts/i;
const FULL_SYNCING_RE = /Full transcripts syncing/i;
const SYNCING_ACK_RE = /Syncing your sessions/i;
const OFF_DESCRIPTION_RE = /Nothing leaves this device/i;
const SHARE_HEADING_RE = /Share with your team/i;
const TOGGLE_SIDEBAR_RE = /toggle sidebar/i;
const MOBILE_WIDTH = 400;
const OFF_CONFIRMATION_RE = /You can change this setting any time in Settings/i;

describe("post-auth onboarding flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("opens on the blocking sync takeover with Full transcripts pre-selected", () => {
    render(<Experience />);

    expect(screen.getByText(TAKEOVER_HEADING)).toBeTruthy();
    // The pre-selected default is Full transcripts (ISS-5249), so its radio is
    // checked on mount without any interaction.
    const fullRadio = screen.getByRole("radio", { name: FULL_TRANSCRIPTS_RE });
    expect(fullRadio.getAttribute("aria-checked")).toBe("true");
    // And the flow has not advanced past the takeover yet.
    expect(screen.queryByText(LIVE_SESSIONS_MARKER)).toBeNull();
  });

  it("confirms the saved level, then auto-dismisses to Sessions after 3s", () => {
    render(<Experience />);

    // Save the pre-selected Full level.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The per-level confirmation appears and the Save control is replaced by the
    // redirect hint — the takeover is still up, Sessions is not yet live.
    expect(screen.getByText(FULL_SYNCING_RE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(TAKEOVER_HEADING)).toBeTruthy();
    expect(screen.queryByText(LIVE_SESSIONS_MARKER)).toBeNull();

    // The auto-dismiss timer has not fired before its 3s window.
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByText(TAKEOVER_HEADING)).toBeTruthy();

    // At 3s it dismisses to the live Sessions page.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(TAKEOVER_HEADING)).toBeNull();
    expect(screen.getByText(LIVE_SESSIONS_MARKER)).toBeTruthy();
    // The destination acknowledges the sync it just authorized with the same
    // Progress bar prod uses, rather than silently showing cloud data.
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText(SYNCING_ACK_RE)).toBeTruthy();
  });

  it("names the chosen level in the save confirmation (Off)", () => {
    render(<Experience />);

    // Pick Off (unique by its description), then Save.
    fireEvent.click(screen.getByRole("radio", { name: OFF_DESCRIPTION_RE }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(OFF_CONFIRMATION_RE)).toBeTruthy();
  });

  it("anchors the arrival pop-up to the topbar menu trigger on mobile", () => {
    // At <768px the sidebar (and its invite item) is offcanvas, so the pop-up
    // must anchor to the always-visible topbar trigger or it never appears.
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: MOBILE_WIDTH,
      writable: true,
    });
    try {
      render(<Experience />);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // The CTA still fires on the narrow viewport...
      expect(screen.getByText(SHARE_HEADING_RE)).toBeTruthy();
      // ...anchored to (and highlighting) the topbar menu trigger, since the
      // sidebar's own invite item is off screen here.
      const toggle = screen.getByRole("button", { name: TOGGLE_SIDEBAR_RE });
      expect(toggle.className).toContain("ring-2");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
        writable: true,
      });
    }
  });
});
