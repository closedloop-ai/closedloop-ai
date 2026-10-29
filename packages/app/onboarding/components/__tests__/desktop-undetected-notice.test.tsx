import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopRecheckPhase,
  DesktopUndetectedNotice,
} from "../desktop-undetected-notice";

const CHECKING_BUTTON_NAME = /Checking…/;
const CHECK_AGAIN_BUTTON_NAME = /Check again/;

function renderNotice(
  overrides: Partial<{
    detectionExhausted: boolean;
    latestVersion: string | null;
    onRecheck: () => void;
    phase: DesktopRecheckPhase;
    runningVersion: string | null;
  }> = {}
) {
  const onRecheck = overrides.onRecheck ?? vi.fn();
  const view = render(
    <DesktopUndetectedNotice
      detectionExhausted={overrides.detectionExhausted ?? false}
      latestVersion={overrides.latestVersion ?? null}
      onRecheck={onRecheck}
      phase={overrides.phase ?? DesktopRecheckPhase.Idle}
      runningVersion={overrides.runningVersion ?? null}
    />
  );
  return { onRecheck, ...view };
}

describe("DesktopUndetectedNotice", () => {
  it("wraps the whole notice in one polite live region", () => {
    const { container } = renderNotice();

    expect(container.querySelector("[aria-live='polite']")).toBeInTheDocument();
  });

  it("shows a passive watching message while idle and not exhausted", () => {
    renderNotice({ phase: DesktopRecheckPhase.Idle });

    expect(
      screen.getByText("Looking for Closedloop Desktop…")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the still-absent watching message while still-absent and not exhausted", () => {
    renderNotice({ phase: DesktopRecheckPhase.StillAbsent });

    expect(
      screen.getByText("Still not detected. Watching for Closedloop Desktop…")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the checking alert with a disabled button while a check is in flight", () => {
    renderNotice({ phase: DesktopRecheckPhase.Checking });

    expect(
      screen.getByText("Checking for Closedloop Desktop…")
    ).toBeInTheDocument();
    const button = screen.getByRole("button", { name: CHECKING_BUTTON_NAME });
    expect(button).toBeDisabled();
  });

  it("shows the checking alert even when detectionExhausted is also true", () => {
    renderNotice({
      detectionExhausted: true,
      phase: DesktopRecheckPhase.Checking,
    });

    expect(
      screen.getByText("Checking for Closedloop Desktop…")
    ).toBeInTheDocument();
  });

  it("shows the terminal not-detected alert with no version sentence when exhausted", () => {
    renderNotice({ detectionExhausted: true, phase: DesktopRecheckPhase.Idle });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Closedloop Desktop was not detected. Install or open Closedloop Desktop, then check again."
    );
    expect(alert).not.toHaveTextContent("Version");
  });

  it("adds the version sentence when a latest version is known", () => {
    renderNotice({
      detectionExhausted: true,
      latestVersion: "1.4.0",
      phase: DesktopRecheckPhase.Idle,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Version 1.4.0 is available and automated setup will install it for you."
    );
  });

  it("leads with 'Still not detected.' once still-absent and exhausted", () => {
    renderNotice({
      detectionExhausted: true,
      phase: DesktopRecheckPhase.StillAbsent,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Still not detected. Install or open Closedloop Desktop, then check again."
    );
  });

  it("enables the recheck button once exhausted and fires onRecheck when clicked", () => {
    const { onRecheck } = renderNotice({
      detectionExhausted: true,
      phase: DesktopRecheckPhase.Idle,
    });

    const button = screen.getByRole("button", {
      name: CHECK_AGAIN_BUTTON_NAME,
    });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("renders the running version as a screen-reader-only string when present", () => {
    renderNotice({ runningVersion: "1.3.2" });

    const hidden = screen.getByText("1.3.2");
    expect(hidden).toHaveClass("sr-only");
  });

  it("renders no running-version span when absent", () => {
    renderNotice({ runningVersion: null });

    expect(screen.queryByText("1.3.2")).not.toBeInTheDocument();
  });
});
