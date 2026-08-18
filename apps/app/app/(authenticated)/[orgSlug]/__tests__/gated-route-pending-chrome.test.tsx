/**
 * ISS-5001: every gated route whose loaded page renders a `Header` must hand
 * `FeatureFlagRouteGate` a `pending` that reserves that Header.
 *
 * The gate's default pending is header-less, so a route that passes nothing
 * opens as a headerless grey region and then pops the whole shell — breadcrumb
 * and all — in when the flag lands. These tests stub the gate down to "render
 * only the pending chrome" and assert each route's pending carries its own
 * breadcrumb, so a future call site that drops the prop fails here.
 *
 * `/insights` is deliberately absent: its loaded page renders no `Header` at
 * all, so reserving one would pop chrome OUT when the flag lands. It keeps the
 * gate's header-less default.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import IssuesPage from "../issues/page";
import LoopUsagePage from "../loops/usage/page";
import RoutinesPage from "../routines/page";

// Render ONLY the pending chrome: the branch under test is what the route
// reserves while the flag is unresolved, not its loaded body.
vi.mock("@/components/feature-flag-route-gate", () => ({
  FeatureFlagRouteGate: ({ pending }: { pending?: ReactNode }) => (
    <div>{pending}</div>
  ),
}));

// The real Header pulls in the sidebar context and the mobile search overlay;
// neither is the contract here. Reduce it to its breadcrumb labels.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <header>{breadcrumbs.map((crumb) => crumb.label).join(" / ")}</header>
  ),
}));

vi.mock("../../components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <header>{breadcrumbs.map((crumb) => crumb.label).join(" / ")}</header>
  ),
}));

vi.mock("../loops/usage/page-client", () => ({
  default: () => <div />,
}));

vi.mock("../routines/components/routines-index-view", () => ({
  RoutinesIndexView: () => <div />,
}));

vi.mock("@/components/coming-soon-page", () => ({
  ComingSoonPage: () => <div />,
}));

describe("gated routes reserve their own Header while the flag resolves", () => {
  it("renders the Issues breadcrumb in the pending chrome", () => {
    render(<IssuesPage />);

    expect(screen.getByRole("banner")).toHaveTextContent("Issues");
  });

  it("renders the Routines breadcrumb in the pending chrome", () => {
    render(<RoutinesPage />);

    expect(screen.getByRole("banner")).toHaveTextContent("Routines");
  });

  it("renders the Usage breadcrumb in the pending chrome", () => {
    render(<LoopUsagePage />);

    expect(screen.getByRole("banner")).toHaveTextContent("Usage");
  });
});
