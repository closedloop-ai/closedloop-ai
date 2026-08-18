import type { ListEmptyStateSignals } from "@repo/api/src/list-empty-state";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionsEmptyState } from "../sessions-empty-state";

const HYDRATED_EMPTY: ListEmptyStateSignals = {
  isUnavailable: false,
  hasActiveFilters: false,
};

describe("SessionsEmptyState (FEA-4181)", () => {
  it("filtered-empty (active filter, zero visible) names the situation and offers Clear filters", () => {
    const onClearFilters = vi.fn();
    render(
      <SessionsEmptyState
        onClearFilters={onClearFilters}
        signals={{
          isUnavailable: false,
          hasActiveFilters: true,
        }}
      />
    );

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No sessions match the current filters. Try clearing or widening a filter."
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("genuinely-empty (no rows, no filters) renders the onboarding zero-state, not a filters message", () => {
    render(<SessionsEmptyState signals={HYDRATED_EMPTY} />);

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sessions appear here once your connected compute targets sync their agent history."
      )
    ).toBeInTheDocument();
    // Not a filtered-empty — no "clear filters" affordance.
    expect(
      screen.queryByRole("button", { name: "Clear filters" })
    ).not.toBeInTheDocument();
  });

  it("genuinely-empty with no connected agent renders the connect-a-compute-target onboarding CTA", () => {
    render(
      <SessionsEmptyState
        hasConnectedAgent={false}
        onboardingAction={
          <button type="button">Connect a compute target</button>
        }
        signals={HYDRATED_EMPTY}
      />
    );

    expect(screen.getByText("No sessions synced yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect a compute target" })
    ).toBeInTheDocument();
  });

  it("unavailable+errored with only onRetry (no recovery Link) falls back to a lone Retry, never a false 'no sessions'", () => {
    const onRetry = vi.fn();
    render(
      <SessionsEmptyState
        onRetry={onRetry}
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    // Must NOT masquerade as a genuine or filtered empty.
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();

    // ISS-4534: with no recovery affordance wired, the card still has one action.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // review cid 3653690775 / ISS-4483: a local source that hasn't come up yet OR is
  // transiently reconnecting (db-host restarting mid-backfill) is syncing, not
  // broken — quiet holding message, no destructive error chrome, and NO Retry
  // (nothing to retry; it hydrates/recovers on its own). The desktop host sets
  // `isSyncing` when the source is unavailable-without-error OR the read failed
  // transiently.
  it("unavailable+syncing renders the quiet holding message with no error chrome and no Retry", () => {
    const onRetry = vi.fn();
    render(
      <SessionsEmptyState
        isSyncing
        onRetry={onRetry}
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );

    expect(screen.getByText("Getting your sessions ready")).toBeInTheDocument();
    // Not the errored surface, and no Retry the user would click into a no-op.
    expect(
      screen.queryByText("Couldn't load sessions")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  // ISS-4534: the errored card carries a SINGLE honest recovery action. When the
  // host supplies an `errorRecoveryAction` (the "Clear filters and reload" Link),
  // it is the sole action — it REPLACES the standalone Retry, because clearing-
  // and-reloading already re-issues the read and so is a superset of a bare retry.
  it("unavailable+errored renders the recovery affordance as the single action, replacing Retry", () => {
    const onRetry = vi.fn();
    render(
      <SessionsEmptyState
        errorRecoveryAction={<a href="/sessions">Clear filters and reload</a>}
        onRetry={onRetry}
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    // The recovery way-out is present as the primary (and only) action...
    const recovery = screen.getByRole("link", {
      name: "Clear filters and reload",
    });
    expect(recovery).toBeInTheDocument();
    expect(recovery).toHaveAttribute("href", "/sessions");
    // ...and the redundant standalone Retry is gone (superset, not a second button).
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  // ISS-4534: the recovery affordance stands alone (a host may wire it without an
  // onRetry, and the errored card is never left with zero actions).
  it("renders the recovery affordance even without an onRetry", () => {
    render(
      <SessionsEmptyState
        errorRecoveryAction={<a href="/sessions">Clear filters and reload</a>}
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );

    expect(
      screen.getByRole("link", { name: "Clear filters and reload" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  // ISS-4534: a SYNCING source is not an error — it hydrates on its own — so it
  // must NOT show the errored card's recovery affordance (or Retry).
  it("does not render the recovery affordance in the syncing (non-errored) state", () => {
    render(
      <SessionsEmptyState
        errorRecoveryAction={<a href="/sessions">Clear filters and reload</a>}
        isSyncing
        signals={{ isUnavailable: true, hasActiveFilters: false }}
      />
    );

    expect(screen.getByText("Getting your sessions ready")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Clear filters and reload" })
    ).not.toBeInTheDocument();
  });

  it("unavailable wins over active filters — an errored read is never reclassified as filtered", () => {
    render(
      <SessionsEmptyState
        signals={{
          isUnavailable: true,
          hasActiveFilters: true,
        }}
      />
    );

    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });
});
