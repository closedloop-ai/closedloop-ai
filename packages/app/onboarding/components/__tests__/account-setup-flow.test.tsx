import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSyncLevelValue } from "../../../shared/lib/data-sync-copy";
import { AccountSetupFlow } from "../account-setup-flow";

const CONNECT_BUTTON = /continue with github/i;
const CONNECT_HEADING = /connect github to finish setup/i;
const SYNC_HEADING = /choose what syncs to the cloud/i;
const CONTINUE = /^continue$/i;
const HEADING_ID = "account-setup-heading";

describe("AccountSetupFlow", () => {
  it("shows the Connect-GitHub step when not connected", () => {
    render(
      <AccountSetupFlow
        githubConnected={false}
        onComplete={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    expect(
      screen.getByRole("heading", { name: CONNECT_HEADING })
    ).toBeInTheDocument();
  });

  it("fires onConnect from the connect step", () => {
    const onConnect = vi.fn();
    render(
      <AccountSetupFlow
        githubConnected={false}
        onComplete={vi.fn()}
        onConnect={onConnect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: CONNECT_BUTTON }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("skips to the Sync-consent step once connected (connect-once)", () => {
    render(
      <AccountSetupFlow
        githubConnected
        onComplete={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    expect(
      screen.getByRole("heading", { name: SYNC_HEADING })
    ).toBeInTheDocument();
  });

  it("fires onComplete with the safe default level on an untouched Continue", () => {
    const onComplete = vi.fn();
    render(
      <AccountSetupFlow
        githubConnected
        onComplete={onComplete}
        onConnect={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    // FEA-4055: SyncConsent pre-selects the SAFEST insight-bearing level
    // (metadata), never the broadest — an untouched Continue must not
    // pre-consent to full transcript upload.
    expect(onComplete).toHaveBeenCalledWith(DataSyncLevelValue.Metadata);
  });

  /**
   * ISS-5112 threaded an optional `headingId` through to both steps so a host
   * that owns the surrounding surface — the desktop account dialog — can point
   * `aria-labelledby` at the heading actually on screen instead of a copy that
   * goes stale when the flow advances. It has to follow the step, not sit on one.
   */
  it("names whichever step's heading is on screen when a headingId is passed", () => {
    const { rerender } = render(
      <AccountSetupFlow
        githubConnected={false}
        headingId={HEADING_ID}
        onComplete={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    expect(
      screen.getByRole("heading", { name: CONNECT_HEADING })
    ).toHaveAttribute("id", HEADING_ID);

    rerender(
      <AccountSetupFlow
        githubConnected
        headingId={HEADING_ID}
        onComplete={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    expect(screen.getByRole("heading", { name: SYNC_HEADING })).toHaveAttribute(
      "id",
      HEADING_ID
    );
  });

  /**
   * Every host but that dialog omits the prop, so the default has to render what
   * shipped before it existed: no `id` at all, not an empty or generated one
   * that could collide with, or silently retarget, a host's own labelling.
   */
  it("leaves both step headings unnamed when no headingId is passed", () => {
    const { rerender } = render(
      <AccountSetupFlow
        githubConnected={false}
        onComplete={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    expect(
      screen.getByRole("heading", { name: CONNECT_HEADING })
    ).not.toHaveAttribute("id");

    rerender(
      <AccountSetupFlow
        githubConnected
        onComplete={vi.fn()}
        onConnect={vi.fn()}
      />
    );
    expect(
      screen.getByRole("heading", { name: SYNC_HEADING })
    ).not.toHaveAttribute("id");
  });
});
