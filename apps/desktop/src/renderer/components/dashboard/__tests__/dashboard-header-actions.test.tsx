/**
 * What the dashboard title row holds.
 *
 * ISS-10929 / ISS-10942 retired the `Local`/`Cloud` read-source pill, the `Tour`
 * control and the guest `Create account` offer from this row. The operator
 * restored the `SCOPE` toggle (2026-09-30), ruling that one a regression, so the
 * row is the range filter plus the scope toggle and nothing else.
 *
 * The three still-retired controls are asserted STRUCTURALLY rather than by
 * querying for each label. Those labels no longer exist as constants anywhere,
 * so an absence assertion holding its own copy of the words would match nothing
 * the moment one came back under a different wording — the exact regression this
 * file exists to catch. Naming the row's groups and its radios is satisfied by
 * one arrangement only, and every reinstated control fails it.
 */

import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import {
  DASHBOARD_SCOPE_LABEL,
  SCOPE_TOGGLE_OPTIONS,
} from "@repo/app/insights/components/overview/dashboard-scope-copy";
import { DASHBOARD_DATE_RANGES } from "@repo/app/insights/lib/dashboard-range";
import { DATE_RANGE_FILTER_ARIA_LABEL } from "@repo/app/shared/components/date-range-filter-labels";
import {
  DATE_RANGE_LABELS,
  DATE_RANGE_SHORT_LABELS,
} from "@repo/app/shared/lib/format-utils";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardHeaderActions } from "../dashboard-header-actions";

function renderRow({
  refreshing = false,
  scope = InsightsScope.Me,
  scopeAvailable = true,
  onScopeChange = vi.fn(),
}: {
  refreshing?: boolean;
  scope?: InsightsScope;
  scopeAvailable?: boolean;
  onScopeChange?: (value: string) => void;
} = {}) {
  return render(
    <DashboardHeaderActions
      dateRange={DASHBOARD_DATE_RANGES[0]}
      onDateRangeChange={vi.fn()}
      onScopeChange={onScopeChange}
      refreshing={refreshing}
      scope={scope}
      scopeAvailable={scopeAvailable}
    />
  );
}

function rangeRadioLabels() {
  return screen
    .getByRole("radiogroup", { name: DATE_RANGE_FILTER_ARIA_LABEL })
    .querySelectorAll('[role="radio"]');
}

describe("DashboardHeaderActions", () => {
  it("renders the range filter", () => {
    renderRow();

    expect(
      Array.from(rangeRadioLabels()).map((button) =>
        button.getAttribute("aria-label")
      )
    ).toEqual(DASHBOARD_DATE_RANGES.map((range) => DATE_RANGE_LABELS[range]));
  });

  it("renders the Me / Organization scope toggle when org scope is served", () => {
    renderRow({ scopeAvailable: true });

    const group = screen.getByRole("radiogroup", {
      name: DASHBOARD_SCOPE_LABEL,
    });
    expect(
      Array.from(group.querySelectorAll('[role="radio"]')).map(
        (radio) => radio.textContent
      )
    ).toEqual(SCOPE_TOGGLE_OPTIONS.map((option) => option.label));
  });

  it("reflects the selected scope rather than always Me", () => {
    renderRow({ scope: InsightsScope.Org, scopeAvailable: true });

    const selected = screen
      .getByRole("radiogroup", { name: DASHBOARD_SCOPE_LABEL })
      .querySelector('[data-state="on"]');
    expect(selected?.textContent).toBe(
      SCOPE_TOGGLE_OPTIONS.find((option) => option.value === InsightsScope.Org)
        ?.label
    );
  });

  it("renders no scope toggle when only personal scope is served", () => {
    renderRow({ scopeAvailable: false });

    expect(
      screen.queryByRole("radiogroup", { name: DASHBOARD_SCOPE_LABEL })
    ).toBeNull();
  });

  it("renders no other control beside those two", () => {
    const { container } = renderRow({ scopeAvailable: true });

    // The retired Tour and Create account controls were BUTTONS on this row,
    // which the two radiogroups above admit none of. The row's whole text then
    // covers what is not a radio: the read-source pill rendered text this
    // leaves no room for.
    expect(
      container.querySelectorAll("button:not([role='radio'])")
    ).toHaveLength(0);
    expect(container.textContent).toBe(
      DASHBOARD_DATE_RANGES.map((range) => DATE_RANGE_SHORT_LABELS[range]).join(
        ""
      ) +
        DASHBOARD_SCOPE_LABEL +
        SCOPE_TOGGLE_OPTIONS.map((option) => option.label).join("")
    );
  });

  it("still shows the one dashboard-wide refreshing indicator", () => {
    renderRow({ refreshing: true });

    expect(screen.getByRole("status")).not.toBeNull();
  });
});
