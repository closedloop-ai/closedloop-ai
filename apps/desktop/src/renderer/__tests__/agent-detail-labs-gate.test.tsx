/**
 * ISS-5310 — the Agents DETAIL tier obeys the same nested Labs gate as the list.
 *
 * `renderPage` in `App.tsx` gates the keep-alive nav map, but `#/agents/<slug>`
 * takes the detail override further down, which replaces the shell's content
 * wholesale. Gating the list alone therefore left a bookmarked or relaunched
 * detail hash mounting the full agent detail screen out of a section that had
 * been switched off, with a Back button aimed at the list the same gate had
 * just withdrawn (wongk cid 3726730878, stage cid 3726701517).
 *
 * These cases live in their own focused file rather than in
 * `app-shell-routing.test.tsx`, following the precedent of
 * `branch-detail-back-navigation.test.tsx`: the detail view is mocked to a
 * marker so the suite exercises App.tsx's gating and not the detail page
 * internals (those are covered by `agent-detail-view.test.tsx`).
 *
 * BOTH directions are asserted. Without the open-gate case, an implementation
 * that simply never rendered agent detail would pass every closed-gate case.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

const AGENT_DETAIL_TESTID = "agent-detail";
const AGENT_DETAIL_HASH = "#/agents/reviewer-bot";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

vi.mock("../components/agents/agent-detail-view", () => ({
  AgentDetailView: ({
    agentSlug,
    backHref,
  }: {
    agentSlug: string;
    backHref: string;
  }) => (
    <div data-back-href={backHref} data-testid="agent-detail">
      {agentSlug}
    </div>
  ),
}));

describe("ISS-5310 Agents detail route under the nested Labs gate", () => {
  setupAppShellSuite();

  it("renders the agent detail when both gates are open", async () => {
    installDesktopApi({ agentsNav: true, labsNav: true });

    renderDesktopApp(AGENT_DETAIL_HASH);

    const detail = await screen.findByTestId(AGENT_DETAIL_TESTID);
    expect(detail.textContent).toContain("reviewer-bot");
    expect(detail.getAttribute("data-back-href")).toBe("/agents");
    expect(screen.queryByText("Agents is turned off")).toBeNull();
  });

  it("withholds the agent detail when the per-item Agents gate is off", async () => {
    installDesktopApi({ agentsNav: false, labsNav: true });

    renderDesktopApp(AGENT_DETAIL_HASH);

    // The same in-shell panel `#/agents` answers with, so a saved detail URL and
    // a saved list URL tell the user the same story instead of one of them
    // quietly opening a screen from a section that no longer exists.
    expect(await screen.findByText("Agents is turned off")).toBeDefined();
    expect(screen.queryByTestId(AGENT_DETAIL_TESTID)).toBeNull();
    // The address bar keeps naming the destination that was asked for.
    expect(window.location.hash).toBe(AGENT_DETAIL_HASH);
    // Labs itself is ON here, so the way back is the in-app Settings row — not
    // the application-menu checkbox the container-off copy names.
    expect(
      screen.getByRole("link", { name: "Open settings" }).getAttribute("href")
    ).toBe("#/settings?tab=labs");
  });

  it("withholds the agent detail when the Labs container gate is off", async () => {
    installDesktopApi({ agentsNav: true, labsNav: false });

    renderDesktopApp(AGENT_DETAIL_HASH);

    // Container-off wins regardless of the per-item value — the nesting rule,
    // asserted on the detail tier the same way `agents-labs-gate.test.tsx`
    // asserts it on the list.
    expect(await screen.findByText("Agents is turned off")).toBeDefined();
    expect(screen.queryByTestId(AGENT_DETAIL_TESTID)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Go to Sessions" }).getAttribute("href")
    ).toBe("#/sessions");
  });

  it("holds the agent detail while the flag snapshot is still in flight", async () => {
    let releaseFlags: (() => void) | undefined;
    installDesktopApi({
      agentsNav: true,
      flagsGate: new Promise<void>((resolve) => {
        releaseFlags = resolve;
      }),
      labsNav: true,
    });

    renderDesktopApp(AGENT_DETAIL_HASH);

    // Unresolved reads exactly like user-disabled. Committing to the closed
    // panel here would tell an opted-in user their own bookmark is switched off,
    // one frame before it opens.
    expect(
      await screen.findByRole("status", { name: "Loading Agents" })
    ).toBeDefined();
    expect(screen.queryByText("Agents is turned off")).toBeNull();
    expect(screen.queryByTestId(AGENT_DETAIL_TESTID)).toBeNull();

    releaseFlags?.();

    expect(await screen.findByTestId(AGENT_DETAIL_TESTID)).toBeDefined();
  });
});
