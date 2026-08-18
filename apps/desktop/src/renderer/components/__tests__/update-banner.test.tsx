import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackagedUpdateInstallBlockedReason } from "../../../shared/packaged-update-install-blocked-reason";
import { UPDATE_BANNER_READY_TEST_ID, UpdateBanner } from "../UpdateBanner";

// Behavioral replacement for the old renderer-logs-static source-text guard:
// mount the real UpdateBanner, drive it through the IPC-bridged window events it
// subscribes to (desktop:update-status / desktop:update-available), and assert
// the apply action calls window.desktopApi.applyUpdate. The pure visibility/apply
// reducers are separately unit-tested in test/update-banner-state.test.ts.

// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const MOVE_AND_UPDATE_LABEL = /Move & Update/i;
const MOVE_FAILED_MESSAGE = /Couldn't move automatically/i;
// ISS-5367 review: the relaunch action is a Button inside the strip, not the
// strip itself, so its accessible name is the verb alone. Anchored, so the
// absence assertions below cannot be satisfied by an unrelated longer label.
const RELAUNCH_LABEL = /^Relaunch$/i;
const NEW_VERSION_MESSAGE = /A new version is available\./i;
const UPDATE_ERROR_PREFIX = /Update error:/i;
const UPDATES_PAUSED_MESSAGE = /Updates are paused/i;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type DesktopUpdateApiMocks = {
  applyUpdate: ReturnType<typeof vi.fn>;
  moveToApplications: ReturnType<typeof vi.fn>;
};

function installUpdateApi({
  applyUpdate = vi.fn(async () => undefined),
  moveToApplications = vi.fn(async () => true),
}: Partial<DesktopUpdateApiMocks> = {}): DesktopUpdateApiMocks {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { applyUpdate, moveToApplications },
  });
  return { applyUpdate, moveToApplications };
}

function dispatchDesktopEvent(name: string, detail: unknown): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("UpdateBanner update IPC wiring", () => {
  it("stays hidden until an actionable update event arrives", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a downloading strip on a desktop:update-status downloading event", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "downloading",
      updateAvailable: true,
      percent: 40,
      version: "1.2.3",
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Downloading update"
    );
  });

  it("escalates to a Relaunch action on a downloaded status and calls applyUpdate on click", async () => {
    const { applyUpdate } = installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "1.2.3",
    });

    fireEvent.click(screen.getByRole("button", { name: RELAUNCH_LABEL }));

    await waitFor(() => expect(applyUpdate).toHaveBeenCalled());
  });

  it("renders a read-only install block as a warning Move & Update action", async () => {
    const { applyUpdate, moveToApplications } = installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      error: "should not be shown",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(UPDATES_PAUSED_MESSAGE);
    expect(status.textContent).not.toMatch(UPDATE_ERROR_PREFIX);
    expect(status.className).toContain("warning");
    expect(status.className).not.toContain("destructive");
    expect(screen.queryByRole("button", { name: RELAUNCH_LABEL })).toBeNull();

    const moveButton = screen.getByRole("button", {
      name: MOVE_AND_UPDATE_LABEL,
    });
    fireEvent.click(moveButton);

    await waitFor(() => expect(moveToApplications).toHaveBeenCalled());
    await waitFor(() =>
      expect((moveButton as HTMLButtonElement).disabled).toBe(false)
    );
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("keeps the blocked warning when an update-available nudge follows", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      error: "move the app",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
    dispatchDesktopEvent("desktop:update-available", {
      updateAvailable: true,
      version: "2.0.0",
    });

    expect(screen.getByRole("status").textContent).toMatch(
      UPDATES_PAUSED_MESSAGE
    );
    expect(screen.queryByRole("button", { name: RELAUNCH_LABEL })).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: MOVE_AND_UPDATE_LABEL,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("shows manual guidance when the Move & Update action returns false", async () => {
    const { moveToApplications } = installUpdateApi({
      moveToApplications: vi.fn(async () => false),
    });
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    fireEvent.click(
      screen.getByRole("button", { name: MOVE_AND_UPDATE_LABEL })
    );

    await waitFor(() => expect(moveToApplications).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(MOVE_FAILED_MESSAGE);
  });

  it("shows manual guidance when the Move & Update action rejects", async () => {
    const { moveToApplications } = installUpdateApi({
      moveToApplications: vi.fn(() =>
        Promise.reject(new Error("native move failed"))
      ),
    });
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    fireEvent.click(
      screen.getByRole("button", { name: MOVE_AND_UPDATE_LABEL })
    );

    await waitFor(() => expect(moveToApplications).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(MOVE_FAILED_MESSAGE);
  });

  it("keeps generic update errors destructive without the move CTA", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: "download failed",
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Update error: download failed");
    expect(status.className).toContain("destructive");
    expect(
      screen.queryByRole("button", { name: MOVE_AND_UPDATE_LABEL })
    ).toBeNull();
  });

  it("surfaces the available state from a desktop:update-available nudge", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-available", {
      updateAvailable: true,
      version: "2.0.0",
    });

    expect(screen.getByRole("status").textContent).toContain("available");
  });
});

describe("UpdateBanner banner weight (ISS-5367)", () => {
  it("paints the relaunch strip in the same tint idiom as its sibling states", () => {
    installUpdateApi();
    const relaunch = render(<UpdateBanner />);
    dispatchDesktopEvent("desktop:update-status", {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "1.2.3",
    });
    // Scoped to each render's own container: the two banners below are mounted
    // side by side in one body and BOTH strips now carry `role="status"`, which
    // is the point of the assertion.
    const relaunchPaint = paintOf(
      within(relaunch.container).getByTestId(UPDATE_BANNER_READY_TEST_ID)
    );

    const informational = render(<UpdateBanner />);
    dispatchDesktopEvent("desktop:update-available", {
      updateAvailable: true,
      version: "2.0.0",
    });
    const informationalPaint = paintOf(
      within(informational.container).getByRole("status")
    );

    // Neither side is spelled out here. The defect was that ONE state of this
    // component was painted at full saturation while every other state in the
    // same file used a tint over a hairline rule, so the assertion that has to
    // hold is that they agree — re-solidify the relaunch bar and the two paints
    // diverge, whatever utilities either one happens to use. The extraction
    // includes the line's justification for the same reason: the relaunch state
    // was the one strip in the stack laying its line out from the left edge.
    expect(relaunchPaint).toEqual(informationalPaint);

    // …and the comparison cannot pass by both sides extracting nothing.
    expect(relaunchPaint.background).not.toBeNull();
    expect(relaunchPaint.textColor).not.toBeNull();
    expect(relaunchPaint.justification).not.toBeNull();
    expect(relaunchPaint.hasBottomRule).toBe(true);

    // The specific thing "full saturation" meant: an untinted surface colour.
    // A tint carries an opacity modifier; `bg-[var(--primary)]` does not.
    expect(relaunchPaint.background).toContain("/");

    // Contrast moves with the surface. `--primary-foreground` is chosen to sit
    // on SOLID primary; left behind on a 10% wash it is near-invisible against
    // the app background, so the relaunch state must not still be asking for it.
    expect(relaunchPaint.textColor).not.toContain("primary-foreground");
  });

  it("carries the relaunch action as a button inside the strip, not as the strip", () => {
    installUpdateApi();
    const { getByRole, getByTestId } = render(<UpdateBanner />);
    dispatchDesktopEvent("desktop:update-status", {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "1.2.3",
    });

    const strip = getByTestId(UPDATE_BANNER_READY_TEST_ID);
    const relaunch = getByRole("button", { name: RELAUNCH_LABEL });

    // The review that produced this shape: once the strip dropped to a 10% wash
    // over a hairline, a whole-bar button was rendered identically to the
    // passive informational strip in the same component, and the ONLY thing
    // left saying "this quits and reinstalls the app" was a 14px icon. So the
    // strip is a status line and the action is a discrete control within it.
    // Re-absorb the action into the bar and the strip is a <button> again.
    expect(strip.tagName).toBe("DIV");
    expect(strip.getAttribute("role")).toBe("status");
    expect(relaunch).not.toBe(strip);
    expect(strip.contains(relaunch)).toBe(true);

    // The copy splits with the target: the sentence states the condition and
    // the control names the verb, rather than one label doing both jobs.
    expect(strip.textContent).toMatch(NEW_VERSION_MESSAGE);
  });

  it("holds the sentence while the relaunch is in flight and blocks a second apply", async () => {
    const { applyUpdate } = installUpdateApi();
    const { getByRole, getByTestId } = render(<UpdateBanner />);
    dispatchDesktopEvent("desktop:update-status", {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "1.2.3",
    });

    fireEvent.click(getByRole("button", { name: RELAUNCH_LABEL }));

    // Splitting the copy moved the transient onto the control. The strip must
    // still state the condition it is describing — the update has not stopped
    // being available because the relaunch started — and the control must stop
    // accepting clicks, which the whole-bar `disabled` used to cover.
    await waitFor(() =>
      expect(
        (getByRole("button", { name: RESTARTING_LABEL }) as HTMLButtonElement)
          .disabled
      ).toBe(true)
    );
    expect(getByTestId(UPDATE_BANNER_READY_TEST_ID).textContent).toMatch(
      NEW_VERSION_MESSAGE
    );

    fireEvent.click(getByRole("button", { name: RESTARTING_LABEL }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });
});

const RESTARTING_LABEL = /^Restarting\.\.\.$/i;
// Matches a background utility only at a class boundary, so the `hover:` variant
// on the same element is not mistaken for the resting surface.
const BACKGROUND_UTILITY = /(?:^|\s)(bg-\S+)/;
const THEME_TEXT_COLOUR_UTILITY = /(?:^|\s)(text-\[var\(--[^\])]+\)\])/;
const BOTTOM_RULE_UTILITY = /(?:^|\s)border-b(?:\s|$)/;
const JUSTIFICATION_UTILITY = /(?:^|\s)(justify-\S+)/;

type BannerPaint = {
  background: string | null;
  textColor: string | null;
  justification: string | null;
  hasBottomRule: boolean;
};

/**
 * The rendered surface treatment of a banner state, read off the element rather
 * than asserted as a literal. Used to compare two states against each other:
 * this component's states are supposed to share one idiom, and that is a claim
 * about their relationship, not about any particular utility name.
 */
function paintOf(element: Element): BannerPaint {
  const className = element.className;
  return {
    background: BACKGROUND_UTILITY.exec(className)?.[1] ?? null,
    textColor: THEME_TEXT_COLOUR_UTILITY.exec(className)?.[1] ?? null,
    justification: JUSTIFICATION_UTILITY.exec(className)?.[1] ?? null,
    hasBottomRule: BOTTOM_RULE_UTILITY.test(className),
  };
}
