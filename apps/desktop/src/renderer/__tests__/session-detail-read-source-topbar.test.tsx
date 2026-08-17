/**
 * ISS-5607 — the session-detail read-source badge, through the REAL shell.
 *
 * The component's own contracts (which source it names, and that it claims no
 * source over a session that was never read) are asserted against the real pane
 * in `components/sessions/__tests__/session-detail-branch-link-parity.test.tsx`.
 * What those cases cannot see is the WIRING: they mount
 * `SessionReadSourceTopbarAction` directly, so replacing App.tsx's
 * `sessionId={detailSessionId}` with `null` would switch the feature off in
 * production while every one of them still passed (wongk cid 3776137737).
 *
 * These cases mount the shipped shell — real hash route, real Topbar, real
 * registry-backed `DesktopFeatureFlagProvider` reading `getAllFlags` — so the
 * badge only appears if App.tsx actually hands the route's session id to the
 * action and the Labs flag actually reaches it.
 *
 * Own file rather than a block in `app-shell-sessions.test.tsx`, following the
 * `agent-detail-labs-gate.test.tsx` precedent for a Labs gate on a detail route.
 */
import { ReadSource } from "@repo/api/src/types/read-source";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  findSharedRouteHeading,
  findTopbarCurrentPage,
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

const READ_SOURCE_BADGE_TESTID = "read-source-badge";
const SESSION_DETAIL_HASH = "#/sessions/s-active";
const SESSION_NAME = "Shell Active Session";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

describe("ISS-5607 session-detail read source through the desktop shell", () => {
  setupAppShellSuite();

  it("mounts the badge in the Topbar of the session-detail route", async () => {
    installDesktopApi({ sessionDetailReadSource: true });

    renderDesktopApp(SESSION_DETAIL_HASH);

    const badge = await screen.findByTestId(READ_SOURCE_BADGE_TESTID);
    // Signed out, so the shell reads this machine's SQLite. Naming the mode's
    // other value here would tell a user their rows came from a workspace this
    // render never touched.
    expect(badge.getAttribute("data-read-source")).toBe(ReadSource.Local);
    expect(badge.textContent).toBe("Local");
    // In the Topbar header beside the breadcrumb it qualifies — not somewhere
    // inside the pane. This is the assertion App.tsx's `actions` slot owns.
    // Anchored on the breadcrumb nav rather than the `banner` role, which the
    // sidebar also claims.
    const topbar = screen
      .getByRole("navigation", { name: "breadcrumb" })
      .closest("header");
    if (!topbar) {
      throw new Error("Topbar header not found");
    }
    expect(within(topbar).getByTestId(READ_SOURCE_BADGE_TESTID)).toBe(badge);
    expect(await findSharedRouteHeading(SESSION_NAME)).toBeDefined();
  });

  it("shows no badge on the detail route with the Labs flag off", async () => {
    installDesktopApi({ sessionDetailReadSource: false });

    renderDesktopApp(SESSION_DETAIL_HASH);

    // Closed-by-default (ISS-4779). Waiting on the pane's own heading first
    // means this cannot pass for the vacuous reason that nothing mounted yet.
    expect(await findSharedRouteHeading(SESSION_NAME)).toBeDefined();
    expect(screen.queryByTestId(READ_SOURCE_BADGE_TESTID)).toBeNull();
  });

  it("shows no badge off the detail route, flag on", async () => {
    installDesktopApi({ sessionDetailReadSource: true });

    renderDesktopApp("#/sessions");

    // The Sessions LIST deliberately does NOT carry this pill (ISS-6005 scope 4
    // removed it from the toolbar), and the action is route-scoped to hold that.
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(screen.queryByTestId(READ_SOURCE_BADGE_TESTID)).toBeNull();
  });

  it("shows no badge over a detail route that resolved no session", async () => {
    installDesktopApi({ sessionDetailReadSource: true });

    renderDesktopApp("#/sessions/missing");

    // The pane settles on not-found, proving the read completed — so the absence
    // below is the honesty guard, not a race against a still-pending badge.
    expect(await screen.findByText("Session not found")).toBeDefined();
    expect(screen.queryByTestId(READ_SOURCE_BADGE_TESTID)).toBeNull();
  });
});
