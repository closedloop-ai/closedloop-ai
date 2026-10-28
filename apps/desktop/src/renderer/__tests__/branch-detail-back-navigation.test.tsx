/**
 * FEA-4262: the branch-detail "Back" affordance on Desktop honors a
 * `?from=session` referrer. When the branch detail is opened via a session's
 * Branch cross-link it carries `?from=session`, and Back returns to the sessions
 * list the user came from instead of the static Branches list; an absent or
 * unrecognized referrer keeps the Branches-list fallback.
 *
 * These cases live in their own focused file rather than in the app-shell
 * suites, which the ISS-5147 split already pared down by responsibility.
 * `branch-detail-view` is mocked to a marker
 * that surfaces the resolved `backHref` so this suite exercises App.tsx's
 * referrer→Back wiring, not the detail page internals (those are covered by
 * `branch-detail-view.test.tsx`).
 */

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderDesktopApp, setupAppShellSuite } from "./app-shell-harness";

// Branch detail is mocked to a marker exposing the resolved back href, mirroring
// the marker mock in app-shell-routing.test.tsx.
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

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

describe("Desktop branch-detail Back navigation (FEA-4262)", () => {
  // ISS-8118: adopt the shared harness for timeout budgets and lifecycle —
  // asyncUtilTimeout (15 s) < testTimeout (30 s), matchMedia, ResizeObserver,
  // localStorage, desktopApi, and afterEach cleanup.
  setupAppShellSuite();

  it("points branch-detail Back at the sessions list when arriving via ?from=session", async () => {
    renderDesktopApp("#/branches/b-1?from=session");

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.getAttribute("data-back-href")).toBe("/sessions");
  });

  it("keeps branch-detail Back on the Branches list when the referrer is absent or unknown", async () => {
    renderDesktopApp("#/branches/b-1?from=bogus");

    const detail = await screen.findByTestId("branch-detail");
    expect(detail.getAttribute("data-back-href")).toBe("/branches");
  });
});
