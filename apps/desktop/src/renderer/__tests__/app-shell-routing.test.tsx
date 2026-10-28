/**
 * Desktop app-shell: routing and the Labs container gate (ISS-5147 split).
 *
 * Split out of the former monolithic `app-shell.test.tsx`. Owns one
 * responsibility: which destination a hash resolves to — the desktop-only native
 * routes, the retired Packs-Lab aliases, branch detail and its back href, the
 * ISS-5037 Labs container gate in all three of its outcomes, and the Topbar
 * breadcrumb. Sidebar persistence and the Sessions surface live in the sibling
 * `app-shell-*.test.tsx` files.
 *
 * Every gated view is mocked to a marker so these cases exercise `App.tsx`'s
 * routing and gating, not view internals (each view has its own suite).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RendererReadyPhase } from "../../shared/renderer-ready-phase";
import { DETAIL_FALLBACK_LABELS } from "../components/route-fallbacks";
import { BRANCH_DETAIL_PLACEHOLDER_LABEL } from "../navigation/breadcrumb-model";
import { pageTitleForNav } from "../navigation/nav-config";
import { NavId } from "../navigation/route-table";
import {
  findTopbarCurrentPage,
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

/** The legacy sidebar's Labs section header (inline in `Sidebar.tsx`). */
const LABS_SECTION_LABEL = "Labs";

function NativePageMarker({ id }: { id: string }) {
  return <div data-testid={`native-route:${id}`}>{id}</div>;
}

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));
// ISS-10195: Settings is no longer a nav PAGE. Retiring the
// workspace-experience gate made the v2 modal unconditional, so `App.tsx` mounts
// `DesktopSettingsModal` through `DesktopSettingsModalHost`; the legacy panel it
// replaced was left with no route and deleted by ISS-10246. The marker moves
// with the route so these cases still exercise App.tsx's routing rather than the
// modal internals.
vi.mock("../settings-v2/desktop-settings-modal", () => ({
  DesktopSettingsModal: () => (
    <div data-testid="native-route:settings">settings</div>
  ),
}));
vi.mock("../components/features/CoreFeaturesView", () => ({
  PlansView: () => <NativePageMarker id="plans" />,
}));
vi.mock("../components/approvals/ApprovalsPanel", () => ({
  ApprovalsPanel: () => <NativePageMarker id="approvals" />,
}));
vi.mock("../components/activity/ActivityPanel", () => ({
  ActivityPanel: () => <NativePageMarker id="requests" />,
}));
vi.mock("../components/diagnostics/diagnostics-view", () => ({
  DiagnosticsView: () => <NativePageMarker id="diagnostics" />,
}));
// Branch detail (Epic C) is mocked to a marker so this suite exercises App.tsx
// routing, not the detail page internals (covered by
// branch-detail-view.test.tsx). Mirrors the native-page marker mocks above.
vi.mock("../components/branches/branch-detail-view", () => ({
  BranchDetailView: ({
    branchId,
    backHref,
  }: {
    branchId: string;
    backHref: string;
  }) => (
    <div data-back-href={backHref} data-testid="branch-detail">
      {branchId}
    </div>
  ),
}));

describe("App shell routing and the Labs gate", () => {
  setupAppShellSuite();

  it("announces navigation readiness after installing the route listener", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const { notifyRendererReady } = installDesktopApi();

    await renderDesktopApp("");

    const listenerCall = addEventListener.mock.calls.findIndex(
      ([event]) => event === "desktop:navigate-tab"
    );
    const listenerOrder =
      addEventListener.mock.invocationCallOrder[listenerCall];
    const notificationOrder = notifyRendererReady.mock.invocationCallOrder[0];
    addEventListener.mockRestore();
    expect(listenerCall).toBeGreaterThanOrEqual(0);
    expect(notifyRendererReady).toHaveBeenCalledWith(
      RendererReadyPhase.NavigationReady
    );
    expect(listenerOrder).toBeLessThan(notificationOrder);
  });

  it("keeps ungated desktop-only native routes reachable from the shell", async () => {
    await renderDesktopApp("");

    // ISS-8759 (desktop mirror): Approvals and Requests LEFT this list, and that
    // is a behavior change rather than a dropped case. They used to sit in their
    // own `gateway` section, exempt from the Labs fold and so from the `labsNav`
    // container gate; the operator's 2026-09-03 direction moved them under Labs,
    // which on desktop means gated. Their reachability is asserted below, on
    // both sides of that gate, instead of being quietly deleted from here.
    const nativeRoutes = ["plans", "diagnostics", "settings"] as const;

    for (const id of nativeRoutes) {
      window.location.hash = `#/${id}`;
      expect(await screen.findByTestId(`native-route:${id}`)).toBeDefined();
    }
  });

  it("gates the moved Approvals and Requests routes behind the Labs container", async () => {
    // Gate CLOSED: the queues are no longer reachable by hash, exactly like
    // every other Labs destination.
    installDesktopApi({ labsNav: false });

    await renderDesktopApp("");

    for (const [id, title] of [
      ["approvals", "Approvals"],
      ["requests", "Requests"],
    ] as const) {
      window.location.hash = `#/${id}`;
      expect(await screen.findByText(`${title} is turned off`)).toBeDefined();
      expect(screen.queryByTestId(`native-route:${id}`)).toBeNull();
    }
  });

  it("reaches the moved Approvals and Requests routes once Labs is on", async () => {
    installDesktopApi({ labsNav: true });

    await renderDesktopApp("");

    for (const id of ["approvals", "requests"] as const) {
      window.location.hash = `#/${id}`;
      expect(await screen.findByTestId(`native-route:${id}`)).toBeDefined();
    }
  });

  it("redirects legacy packs-lab routes (/tools, /subagents, /skills) to the Agents workspace", async () => {
    await renderDesktopApp("");

    // Legacy routes must redirect to NavId.Agents (the unified workspace).
    // The AgentsView renders null when the feature flag is off (which is the
    // case in the test environment because the static adapter defaults all flags
    // to off). So we just assert the hash routes are accepted (no 404/unmapped).
    // NOTE: /packs is no longer in this set — FEA-4087 reclaims it for the real
    // top-level Packs page (NavId.Packs), covered separately below.
    for (const legacyPath of ["/tools", "/subagents", "/skills"]) {
      window.location.hash = `#${legacyPath}`;
      // The hash is accepted (route resolves to NavId.Agents) — no crash.
      await waitFor(() => expect(window.location.hash).toBe(`#${legacyPath}`));
    }

    // The deprecated db APIs must not be called (the views that used them are gone).
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
  });

  it("routes #/packs to the top-level Packs view (FEA-4087, no longer redirected to Agents)", async () => {
    await renderDesktopApp("#/packs");

    // ISS-5147: the "Packs" <h1> comes from the DESTINATION'S OWN PageShell,
    // which `LabsPageHold` renders too — deliberately, so the flag resolving
    // open is a no-op on screen. That makes the heading true of the hold as
    // well as the loaded page, so waiting on it proved only that the route
    // resolved to *something* named Packs. Assert what only the real view
    // produces, per the precedent set for Insights in
    // `app-shell-sessions.test.tsx`: the shared by-source MemberView's own
    // "Your packs" region, and the catalog read the hold provably never issues
    // (the gated-off and in-flight cases below both assert it stays uncalled).
    //
    // NOT asserted here: the absence of a `status` named "Loading Packs". That
    // name is ambiguous in the same way the heading is — `LabsPageHold`'s
    // skeleton and the destination's own `PacksWorkspaceSkeleton` both carry it
    // — so it can neither confirm nor deny which surface is on screen.
    expect(
      await screen.findByRole("region", { name: "Your packs" })
    ).toBeDefined();
    // ISS-5821: the region is NOT a barrier for the catalog read, so this wait
    // is the fix for a race, not a loosened expectation. The read is issued by
    // `PluginsPanel`'s `reload()` (`plugins-panel.tsx`) from a PASSIVE effect,
    // while the "Your packs" region is `MemberView` shell markup that paints
    // before the catalog resolves — `app-shell-harness.tsx` says so outright,
    // that an empty catalog is a valid ready state. `findByRole` resolves on
    // the DOM mutation, so a synchronous assert here can beat the effect: the
    // observed failures took ~560ms, a fast fail rather than an exhausted wait.
    // The expectation still holds, because `LabsPageHold` never issues the
    // read — a wrongly-resolved route exhausts this `waitFor` instead.
    await waitFor(() =>
      expect(window.desktopApi.db.getCatalog).toHaveBeenCalled()
    );
  });

  // ISS-5037 (ISS-4779 closed-by-default): the Labs container gate. Driven at a
  // Labs URL, so a pass cannot come from the nav simply not being clicked — the
  // DESTINATION has to be unreachable too.
  it("answers a gated-off Labs deep link with an in-shell turned-off panel that names it", async () => {
    installDesktopApi({ labsNav: false });

    await renderDesktopApp("#/packs");

    // The destination itself never mounts — its catalog reads do not fire.
    expect(await screen.findByText("Packs is turned off")).toBeDefined();
    expect(window.desktopApi.db.getCatalog).not.toHaveBeenCalled();
    // The hash, the breadcrumb, and the body all still name Packs. Silently
    // swapping in Sessions under a rewritten crumb left the address bar and the
    // screen disagreeing, with nothing explaining where the bookmark went.
    expect(window.location.hash).toBe("#/packs");
    expect(await findTopbarCurrentPage("Packs")).toBeDefined();
    // One explicit way out, rather than an unexplained landing.
    //
    // Dashboard, not Sessions, because the destination itself moved:
    // `DEFAULT_NAV_ID` is now the canonical Dashboard landing, and
    // `labsPageRecovery` derives BOTH halves of this control from it, so the
    // label and the href follow it together. Asserting them as a pair is the
    // point — a derivation that produced one and hardcoded the other would put
    // a lying label on this link, which is the defect the helper exists to stop.
    expect(
      screen.getByRole("link", { name: "Go to Dashboard" }).getAttribute("href")
    ).toBe("#/dashboard");
    // And no Labs section header or item is drawn in the sidebar.
    expect(
      screen.queryByRole("button", { name: LABS_SECTION_LABEL })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Insights) })
    ).toBeNull();
  });

  // ISS-5037 (whitlockk review on PR #4341): the startup race the Hold outcome
  // exists for. Every other shell case settles the flag seed immediately, so
  // the hold branch was never exercised — this one keeps the assignment in
  // flight and only then releases it.
  it("holds a Labs deep link while the flag snapshot is in flight instead of declaring it off", async () => {
    let releaseFlags: (() => void) | undefined;
    installDesktopApi({
      flagsGate: new Promise<void>((resolve) => {
        releaseFlags = resolve;
      }),
      labsNav: true,
    });

    await renderDesktopApp("#/packs");

    // Unresolved reads exactly like user-disabled, so the shell holds the
    // destination's own shell + skeleton. It must NOT commit to the turned-off
    // panel: this user's Labs setting is on, and the snapshot proving it simply
    // has not landed yet.
    expect(
      await screen.findByRole("status", { name: "Loading Packs" })
    ).toBeDefined();
    expect(screen.queryByText("Packs is turned off")).toBeNull();
    expect(window.desktopApi.db.getCatalog).not.toHaveBeenCalled();
    // And Sessions never mounts on the way (whitlockk review on PR #4341): the
    // hold must not fall through to the default surface even for one frame,
    // or an opted-in user's deep link flashes somebody else's page and fires
    // its queries. `pageData` is the Sessions view's own read — the sidebar
    // link is always present, so the data call, not the nav label, is the
    // unambiguous proof the view did not mount. The address bar still agrees.
    expect(window.desktopApi.agentSessionsApi.pageData).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/packs");

    releaseFlags?.();

    // Once it lands, the real destination opens — no turned-off flash on the way.
    //
    // Synchronize on the branch that OWNS the skeleton. `Loading Packs` belongs
    // to `PluginsPanel`, which `DesktopMemberPacksView` nests as MemberView's
    // `availableSlot`, and it swaps its skeleton for `plugins-panel` in mutually
    // exclusive early returns — so that testid appearing IS the skeleton being
    // gone. Waiting on `getCatalog` having been CALLED does not prove it: the
    // call is the start of the read, not its commit. That raced, and flaked ~40%
    // of the post-merge desktop lanes on 2026-08-06, taking the v0.16.1107
    // release with it. The panel's own "Your packs" wrapper is no good as the
    // signal either — MemberView draws it from a SEPARATE `useAdminPackViews`
    // read that resolves independently, so it can be on screen while the nested
    // panel is still loading (that near-miss fix flaked at the same rate).
    expect(await screen.findByTestId("plugins-panel")).toBeDefined();
    expect(window.desktopApi.db.getCatalog).toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: "Loading Packs" })).toBeNull();
    expect(screen.queryByText("Packs is turned off")).toBeNull();
  });

  // The exact mirror of the gated-off case above, and it must assert both
  // halves of its own name. ISS-5147: it used to check only the "Packs" <h1>,
  // which `LabsPageHold` renders as well — so it could not distinguish "the
  // gate opened" from "the gate never resolved", and it asserted nothing at all
  // about the SECTION it claims to restore.
  it("restores the Labs section and its destinations when the gate is on", async () => {
    installDesktopApi({ labsNav: true });

    await renderDesktopApp("#/packs");

    // The destination really mounted: its own region, not the shared PageShell
    // heading, and the catalog read the hold never fires.
    expect(
      await screen.findByRole("region", { name: "Your packs" })
    ).toBeDefined();
    expect(window.desktopApi.db.getCatalog).toHaveBeenCalled();

    // …and the sidebar section is back, item and all — the two `toBeNull`
    // assertions in the gated-off case, inverted. The section ships COLLAPSED
    // (ISS-4478), so its destinations are only in the DOM once it is opened;
    // expanding it here is what makes "and its destinations" a real claim
    // rather than a restatement of the header assertion above it.
    const labsToggle = screen.getByRole("button", { name: LABS_SECTION_LABEL });
    expect(labsToggle).toBeDefined();
    fireEvent.click(labsToggle);
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
  });

  // ISS-10195 NARROWED THESE, and the narrowing is the behavior change rather
  // than a weakened test. The v2 modal reads `?panel=`; `?tab=` reaches no panel
  // because no v2 panel owns these four legacy tabs. ISS-10286 carries that
  // ownership decision. What still holds — and is all these cases now claim —
  // is that the route RESOLVES to Settings and the alias normalizes, which is
  // what `App.tsx` owns. The tab-to-panel half has no coverage here on purpose:
  // there is nothing yet to cover.
  it("opens Settings for a hash carrying a legacy ?tab=", async () => {
    await renderDesktopApp("#/settings?tab=labs");

    expect(await screen.findByTestId("native-route:settings")).toBeDefined();
  });

  it("opens Settings for a plain hash carrying no ?tab=", async () => {
    await renderDesktopApp("#/settings");

    expect(await screen.findByTestId("native-route:settings")).toBeDefined();
  });

  it.each([
    // ISS-10286: three of the four aliases now carry the v2 `panel` vocabulary,
    // because the Labs → Desktop App panel owns their controls. Account did not
    // move, so it keeps the legacy `tab` spelling nothing reads.
    ["#/settings/account", "tab=account"],
    ["#/settings/security", "panel=desktop-app"],
    ["#/settings/relay-gateway", "panel=desktop-app"],
    ["#/settings/cli-tools", "panel=desktop-app"],
  ])("normalizes %s onto the canonical Settings route", async (hash, query) => {
    await renderDesktopApp(hash);

    expect(await screen.findByTestId("native-route:settings")).toBeDefined();
    expect(window.location.hash).toBe(`#/settings?${query}`);
  });

  it("routes #/branches/:id to the branch detail view", async () => {
    await renderDesktopApp("#/branches/b-1");

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.textContent).toContain("b-1");
    // Back targets the Branches list explicitly, not the contextual nav — a
    // direct #/branches/:id load must not send "Back to Branches" to Sessions.
    // (Path-style href; the hash router prepends "#" on navigation.)
    expect(detail.getAttribute("data-back-href")).toBe("/branches");

    // The Topbar breadcrumb gains a linked "Branches" parent segment that
    // returns to the list (mirrors the web app).
    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    const branchesCrumb = within(breadcrumb).getByRole("link", {
      name: "Branches",
    });
    expect(branchesCrumb.getAttribute("href")).toBe("#/branches");
    // ISS-4839: the mocked detail body never publishes a name and never
    // settles, so the trailing slot is HELD as a pending segment named for what
    // is loading — not filled with the generic "Branch" noun, which would be a
    // name the UI does not have. `detail-route-loading-state.test.tsx` owns the
    // full state matrix; this pins that the routed shell participates in it.
    const currentPage = within(breadcrumb).getByLabelText(
      DETAIL_FALLBACK_LABELS.branch
    );
    expect(currentPage.getAttribute("aria-current")).toBe("page");
    expect(
      within(breadcrumb).queryByText(BRANCH_DETAIL_PLACEHOLDER_LABEL)
    ).toBeNull();
  });

  // FEA-3560: the Branches list mirrors its facet filters into the hash query;
  // the detail's back target and breadcrumb must return to that PRESERVED list
  // href (last visited Branches href), not the canonical /branches — otherwise
  // detail→back remounts an unfiltered list. Direct detail loads (no Branches
  // visit in history) still fall back to canonical, per the test above.
  it("returns from branch detail to the last visited (filtered) Branches list href", async () => {
    await renderDesktopApp("#/branches?owner=Grace");

    window.location.hash = "#/branches/b-1";

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.getAttribute("data-back-href")).toBe("/branches?owner=Grace");

    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    const branchesCrumb = within(breadcrumb).getByRole("link", {
      name: "Branches",
    });
    expect(branchesCrumb.getAttribute("href")).toBe("#/branches?owner=Grace");
  });

  // FEA-4262 branch-detail Back referrer resolution (`?from=session` → sessions
  // list, else Branches) lives in its own focused file —
  // branch-detail-back-navigation.test.tsx — so this suite keeps the one
  // responsibility the ISS-5147 split gave it.

  it("renders a linked Sessions breadcrumb with the session name on the session detail page", async () => {
    await renderDesktopApp("#/sessions/s-active");

    // The current segment resolves to the loaded session's name.
    expect(await findTopbarCurrentPage("Shell Active Session")).toBeDefined();

    // The parent "Sessions" segment links back to the Sessions list and
    // navigates there on click.
    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    const sessionsCrumb = within(breadcrumb).getByRole("link", {
      name: "Sessions",
    });
    expect(sessionsCrumb.getAttribute("href")).toBe("#/sessions");

    fireEvent.click(sessionsCrumb);
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
  });
});
