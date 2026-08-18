/**
 * @file admin-view.test.tsx
 * @description Behavioral tests for the FEA-4088 admin manage-first treatment:
 * one row per distribution, adoption rendered as a progress bar + percent with
 * an honest accessible name, usage null → "Not reported", adoption unloaded →
 * "Not available" (never a fake 0), column sort re-orders rows, and the empty
 * state keeps the secondary Add-packs marketplace on screen.
 */

import {
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { toDistributedPackRows } from "../../lib/distributed-pack-row";
import type { PackDistribution, PackView } from "../../lib/pack-view";
import { AdminView } from "../admin-view";

const marketplace = <div data-testid="marketplace-slot" />;

/** Build the row prop AdminView now takes from PackView fixtures. */
const rowsFrom = (packs: PackView[]) => toDistributedPackRows(packs);

const ADOPTION_LABEL = /128 of 132 installed \(97%\)/;
const ROW_NAMES = /Alpha|Zeta/;
const VERSION_HEADER = /Version/;
const EMPTY_COPY = /not distributing any packs yet/i;
const ERROR_COPY = /couldn't load the packs you distribute/i;

function distribution(
  overrides: Partial<PackDistribution> = {}
): PackDistribution {
  return {
    id: "dist-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetCount: 132,
    installedCount: 128,
    pendingCount: 0,
    failedCount: 4,
    targetingEntries: [],
    // A detail read loaded the per-target statuses, so adoption is real.
    adoptionLoaded: true,
    ...overrides,
  };
}

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "cat-1",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    distribution: distribution(),
    performance: null,
    ...overrides,
  };
}

describe("AdminView", () => {
  it("renders one row per distributed pack under the manage-first section", () => {
    render(
      <AdminView
        marketplaceSlot={marketplace}
        rows={rowsFrom([
          pack({ id: "a", name: "Security Baseline" }),
          pack({
            id: "b",
            name: "Review Copilot",
            distribution: distribution({ id: "dist-2" }),
          }),
        ])}
      />
    );

    expect(
      screen.getByRole("region", { name: "Packs you distribute" })
    ).toBeInTheDocument();
    expect(screen.getByText("Security Baseline")).toBeInTheDocument();
    expect(screen.getByText("Review Copilot")).toBeInTheDocument();
  });

  it("shows adoption as a progress bar carrying the honest installed/target count", () => {
    render(
      <AdminView marketplaceSlot={marketplace} rows={rowsFrom([pack()])} />
    );

    // 128 of 132 = 97%. The bar's accessible name states the real fraction so
    // the number never lies and is legible to a screen reader.
    const bar = screen.getByRole("progressbar", {
      name: ADOPTION_LABEL,
    });
    expect(bar).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
  });

  it("shows a zero-adoption distribution honestly (0%), not hidden", () => {
    render(
      <AdminView
        marketplaceSlot={marketplace}
        rows={rowsFrom([
          pack({
            distribution: distribution({
              installedCount: 0,
              failedCount: 0,
            }),
          }),
        ])}
      />
    );

    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it('renders usage as "Not reported" rather than a fabricated number when telemetry is null', () => {
    render(
      <AdminView
        marketplaceSlot={marketplace}
        rows={rowsFrom([pack({ performance: null })])}
      />
    );

    expect(screen.getByText("Not reported")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it('renders adoption as "Not available" (never 0%) when per-target status was not loaded', () => {
    render(
      <AdminView
        marketplaceSlot={marketplace}
        rows={rowsFrom([
          pack({ distribution: distribution({ adoptionLoaded: false }) }),
        ])}
      />
    );

    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("re-orders rows when a sortable column header is clicked", async () => {
    render(
      <AdminView
        marketplaceSlot={marketplace}
        rows={rowsFrom([
          pack({ id: "a", name: "Zeta", version: "1.0.0" }),
          pack({
            id: "b",
            name: "Alpha",
            version: "2.0.0",
            distribution: distribution({ id: "dist-2" }),
          }),
        ])}
      />
    );

    // Default sort is by name ascending: Alpha (v2.0.0) before Zeta (v1.0.0).
    const before = screen.getAllByText(ROW_NAMES).map((el) => el.textContent);
    expect(before).toEqual(["Alpha", "Zeta"]);

    // Clicking an inactive column header sorts it descending (GridTable's
    // getNextSortDirection). By version descending, Alpha (2.0.0) leads Zeta
    // (1.0.0) — the reverse of what version-ascending would give, proving the
    // click drove a real re-sort by version, not name.
    await userEvent.click(screen.getByRole("button", { name: VERSION_HEADER }));
    const after = screen.getAllByText(ROW_NAMES).map((el) => el.textContent);
    expect(after).toEqual(["Alpha", "Zeta"]);

    // A second click flips to version ascending: Zeta (1.0.0) now leads.
    await userEvent.click(screen.getByRole("button", { name: VERSION_HEADER }));
    const asc = screen.getAllByText(ROW_NAMES).map((el) => el.textContent);
    expect(asc).toEqual(["Zeta", "Alpha"]);
  });

  it("keeps the secondary Add-packs marketplace visible when nothing is distributed", () => {
    render(
      <AdminView
        marketplaceSlot={marketplace}
        rows={rowsFrom([pack({ distribution: null })])}
      />
    );

    // Empty primary region, but the path forward (marketplace) stays on screen.
    const emptyRegion = screen.getByRole("region", {
      name: "Packs you distribute",
    });
    expect(within(emptyRegion).getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-slot")).toBeInTheDocument();
  });

  it("shows the table skeleton while loading, not the empty state", () => {
    render(
      <AdminView isLoading marketplaceSlot={marketplace} rows={rowsFrom([])} />
    );

    expect(screen.getByTestId("distribute-table-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    // The marketplace region stays mounted through the load.
    expect(screen.getByTestId("marketplace-slot")).toBeInTheDocument();
  });

  it("surfaces a failed read as an error, never the misleading empty state", () => {
    render(
      <AdminView
        error={new Error("distributions request failed")}
        marketplaceSlot={marketplace}
        rows={rowsFrom([])}
      />
    );

    // A failed load must not tell an admin they distribute nothing — that would
    // be the UI lying about data the org depends on.
    expect(screen.getByRole("alert")).toHaveTextContent(ERROR_COPY);
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    // The path forward (marketplace) stays reachable.
    expect(screen.getByTestId("marketplace-slot")).toBeInTheDocument();
  });

  it("prefers the error state over the empty state when both would apply", () => {
    render(
      <AdminView
        error={new Error("boom")}
        marketplaceSlot={marketplace}
        rows={rowsFrom([pack({ distribution: null })])}
      />
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });
});
