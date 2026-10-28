import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { listSurfacePageNounsNamedIn } from "../../../shared-branches/__tests__/connect-status-page-noun-fixture";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectMessage,
} from "../../../shared-branches/desktop-github-connect-copy";
import { DesktopGitHubConnectState } from "../../branches/use-desktop-github-connect";
import { SessionsSummaryCardsWithGitHubConnect } from "../sessions-summary-cards-with-github-connect";

/**
 * ISS-7866 — the desktop Sessions strip's connect wiring, tested at the seam
 * that owns it rather than through the whole `SessionsView`.
 *
 * Two contracts live here, and both are regressions this change could
 * reintroduce:
 *
 * 1. **The gate reads the `authenticated` PROP.** This component used to derive
 *    its own strict `state.status === "authenticated"` from `useDesktopAuth`,
 *    while `SessionsView` fed the cards a transient-aware value. Mid-OAuth the
 *    two disagreed and the strip rendered some cards asking and others not from
 *    ONE auth state.
 * 2. **A failed handoff is visible.** The ask this strip renders used to be a
 *    sign-in control that surfaced its own failure inline. Swapping it for the
 *    connect ask without carrying the outcome banner over would make a failed
 *    connect silent — the FEA-3280 dead click in a new place.
 */

const connect = vi.hoisted(() => ({
  connectState: "idle" as string,
  connectTarget: { action: "connect" as const, onConnect: vi.fn() },
}));
const githubStatus = vi.hoisted(() => ({
  current: null as { connected?: boolean } | null,
}));
const auth = vi.hoisted(() => ({ status: "authenticated" as string }));

vi.mock("../../branches/use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../branches/use-desktop-github-connect")
    >();
  return { ...actual, useDesktopGitHubConnect: () => connect };
});

vi.mock("../../../shared-branches/desktop-github-integration-status", () => ({
  useDesktopGitHubIntegrationStatus: () => githubStatus.current,
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({ state: { status: auth.status } }),
}));

// Stubbed so an assertion here is about what the WRAPPER resolved, not about
// how the strip renders it — the card rendering has its own suite in
// `packages/app`.
vi.mock("@repo/app/agents/components/sessions/sessions-summary-cards", () => ({
  SessionsSummaryCards: (props: { githubConnected?: boolean }) => (
    <div
      data-github-connected={String(props.githubConnected)}
      data-testid="summary-cards"
    />
  ),
}));

const FAILED_BANNER = desktopGitHubConnectMessage(
  DesktopGitHubConnectState.Failed,
  DesktopGitHubConnectSurface.List
)?.message;
/**
 * ISS-11326: what the STALLED list surface says on the same state. Sessions has
 * its cards and table on screen beneath the banner, so it takes the populated
 * wording; asserting the stalled one is absent is what pins which variant this
 * strip passes, rather than restating the copy map.
 */
const STALLED_LIST_FAILED_BANNER = desktopGitHubConnectMessage(
  DesktopGitHubConnectState.Failed,
  DesktopGitHubConnectSurface.StalledList
)?.message;

// The strip's two required props. Constant because no case here varies them:
// every assertion is about what the WRAPPER resolves and hands down, and the
// card rendering has its own suite in `packages/app`.
const STRIP_PROPS = { isLoading: false, usage: undefined } as const;

describe("SessionsSummaryCardsWithGitHubConnect", () => {
  beforeEach(() => {
    connect.connectState = DesktopGitHubConnectState.Idle;
    githubStatus.current = null;
    auth.status = DesktopAuthStatus.Authenticated;
  });

  it("withholds the ask while a sign-in handoff is still in flight", () => {
    // ISS-7866 review (whitlockk). Mid-OAuth the transient-aware predicate reads
    // "not signed out", so `authenticated` is true and a STALE disconnected
    // status would otherwise render a live Connect CTA on top of a connect
    // already running — a second control for one flow, whose only outcome is
    // `already_in_progress`. UNKNOWN is the honest answer until auth settles.
    auth.status = DesktopAuthStatus.Exchanging;
    githubStatus.current = { connected: false };

    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={true}
      />
    );

    expect(screen.getByTestId("summary-cards").dataset.githubConnected).toBe(
      "undefined"
    );
  });

  it("asks once auth settles on a definite disconnection", () => {
    // The counterweight: without it the case above would pass just as well
    // against a gate that never asks at all.
    auth.status = DesktopAuthStatus.Authenticated;
    githubStatus.current = { connected: false };

    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={true}
      />
    );

    expect(screen.getByTestId("summary-cards").dataset.githubConnected).toBe(
      "false"
    );
  });

  it("treats a signed-out surface as definitively disconnected", () => {
    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={false}
      />
    );

    // `false`, not `undefined`: with no session there is no grant and no
    // installation to read, so the ask is warranted. Reading `undefined` here
    // would leave the signed-out cards bare.
    expect(screen.getByTestId("summary-cards").dataset.githubConnected).toBe(
      "false"
    );
  });

  it("leaves an unread status UNKNOWN while signed in, so it cannot prompt", () => {
    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={true}
      />
    );

    // ISS-5958's rule: only a connection we KNOW is absent may ask. A status
    // that has not landed says nothing about a user whose org may already have
    // the App installed.
    expect(screen.getByTestId("summary-cards").dataset.githubConnected).toBe(
      "undefined"
    );
  });

  it("stays quiet until the user acts on the ask", () => {
    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={false}
      />
    );

    expect(screen.queryByText(FAILED_BANNER ?? "")).toBeNull();
  });

  it("surfaces a failed connect handoff on the surface that offered it", () => {
    connect.connectState = DesktopGitHubConnectState.Failed;

    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={false}
      />
    );

    expect(FAILED_BANNER).toBeTruthy();
    expect(screen.getByText(FAILED_BANNER ?? "")).toBeTruthy();
  });

  /**
   * ISS-11326: the banner is shared with Insights and the Dashboard, and until
   * this it told a Sessions reader that BRANCHES would refresh. What this pins is
   * the VARIANT this strip passes — the populated-list wording is on screen and
   * the stalled-list wording is not — plus a restatement, at the mount, that the
   * sentence names no page. The wording itself is the copy map's own suite;
   * `DesktopStatusBanner` renders the message as its div's only child, so the
   * node's text cannot differ from the constant that located it.
   */
  it("reports it with the populated-list wording, naming no page", () => {
    connect.connectState = DesktopGitHubConnectState.Failed;

    render(
      <SessionsSummaryCardsWithGitHubConnect
        {...STRIP_PROPS}
        authenticated={false}
      />
    );

    const rendered = screen.getByText(FAILED_BANNER ?? "").textContent ?? "";

    expect(rendered.trim().length).toBeGreaterThan(0);
    expect(listSurfacePageNounsNamedIn(rendered)).toEqual([]);
    // The two wordings differ, so the exclusion below is a real assertion about
    // which variant this strip passes rather than a tautology.
    expect(STALLED_LIST_FAILED_BANNER).not.toBe(FAILED_BANNER);
    expect(screen.queryByText(STALLED_LIST_FAILED_BANNER ?? "")).toBeNull();
  });
});
