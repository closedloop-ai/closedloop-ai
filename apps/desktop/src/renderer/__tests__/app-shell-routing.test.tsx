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
import { DETAIL_FALLBACK_LABELS } from "../components/route-fallbacks";
import {
  findTopbarCurrentPage,
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

function NativePageMarker({ id }: { id: string }) {
  return <div data-testid={`native-route:${id}`}>{id}</div>;
}

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));
// The marker surfaces `deepLinkTab` so the ISS-5310 `?tab=` wiring can be
// asserted from the shell (where the NavigationProvider lives) rather than only
// inside the panel's own unit suite.
vi.mock("../components/settings/SettingsPanel", () => ({
  SettingsPanel: ({ deepLinkTab }: { deepLinkTab?: string | null }) => (
    <div
      data-deep-link-tab={deepLinkTab ?? ""}
      data-testid="native-route:settings"
    >
      settings
    </div>
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
// Audit Bot (FEA-3848) is Labs-gated; mock it to a marker so this suite
// exercises App.tsx flag gating, not the view internals (covered by
// audit-view.test.tsx). The static flag adapter defaults `auditBot` OFF here.
vi.mock("../components/audit/audit-view", () => ({
  AuditView: () => <NativePageMarker id="audit" />,
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

  it("keeps desktop-only native routes reachable from the shell", async () => {
    await renderDesktopApp("");

    const nativeRoutes = [
      ["Plans", "plans"],
      ["Approvals", "approvals"],
      ["Requests", "requests"],
      ["Diagnostics", "diagnostics"],
      ["Settings", "settings"],
    ] as const;

    for (const [, id] of nativeRoutes) {
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
    expect(window.desktopApi.db.getCatalog).toHaveBeenCalled();
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
    expect(
      screen.getByRole("link", { name: "Go to Sessions" }).getAttribute("href")
    ).toBe("#/sessions");
    // And no Labs section header or item is drawn in the sidebar.
    expect(screen.queryByRole("button", { name: "Labs" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Insights" })).toBeNull();
  });

  // ISS-5037 (wongk review on PR #4341): the startup race the Hold outcome
  // exists for. Every other shell case resolves `getAllFlags` immediately, so
  // the hold branch was never exercised — this one keeps the snapshot in flight
  // and only then releases it.
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
    // And Sessions never mounts on the way (wongk review on PR #4341): the
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
    const labsToggle = screen.getByRole("button", { name: "Labs" });
    expect(labsToggle).toBeDefined();
    fireEvent.click(labsToggle);
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
  });

  // ISS-5310 (stage cid 3726701529): the shell reads `?tab=` and hands it to the
  // panel. Without this the Labs "turned off" panel's "Open settings" button
  // would land on Account while its copy named Labs — the link would resolve,
  // and nothing would prove the tab it asked for ever reached the panel.
  it("hands the ?tab= deep link from the Settings hash down to the panel", async () => {
    await renderDesktopApp("#/settings?tab=labs");

    const settings = await screen.findByTestId("native-route:settings");
    expect(settings.getAttribute("data-deep-link-tab")).toBe("labs");
  });

  it("passes no tab when the Settings hash carries no ?tab=", async () => {
    await renderDesktopApp("#/settings");

    const settings = await screen.findByTestId("native-route:settings");
    expect(settings.getAttribute("data-deep-link-tab")).toBe("");
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
    expect(within(breadcrumb).queryByText("Branch")).toBeNull();
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
  // branch-detail-back-navigation.test.tsx — because this suite is grandfathered
  // over the 1,000-line ceiling and therefore shrink-only.

  it("hides the Audit nav entry and view when the auditBot flag is off", async () => {
    // The static flag adapter defaults every flag OFF in this harness, so the
    // Labs-gated Audit surface must not appear and a direct #/audit nav must
    // fall through to Sessions rather than render the (mocked) Audit view.
    renderDesktopApp("");

    const labsToggle = await screen.findByRole("button", { name: "Labs" });
    fireEvent.click(labsToggle);
    // Insights is a Labs entry that is always present; Audit Bot is gated off.
    expect(await screen.findByRole("link", { name: "Insights" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Audit Bot" })).toBeNull();

    window.location.hash = "#/audit";
    // Falls through to Sessions (no audit marker renders).
    expect(await findTopbarCurrentPage("Sessions")).toBeDefined();
    expect(screen.queryByTestId("native-route:audit")).toBeNull();
  });

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
