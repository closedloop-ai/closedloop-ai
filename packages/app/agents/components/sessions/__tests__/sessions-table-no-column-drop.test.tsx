import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { trackWidthsPx as widthsForTemplate } from "@repo/app/test/grid-track-geometry";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-6245 — the Sessions grid renders EVERY declared track and lets the host
 * scroll sideways, at the widths ISS-5813 filed.
 *
 * This is the counterfactual guard for the width-budget removal. ISS-5813's
 * budget dropped whole data columns to make the row fit; the trade was never
 * wanted, so the column set is now unconditional and overflow is the answer.
 *
 * The assertions here are the deliberate INVERSE of the deleted
 * `sessions-width-budget.test.tsx`, on the same fixtures at the same widths:
 * that file asserted `not.toContain("Repository")` at 1440 and
 * `total <= container`, this one asserts the opposite. Re-introducing any
 * collapse-to-fit path therefore cannot leave these green.
 *
 * `renderedTableWidthPx() > containerWidthPx` IS the horizontal-scroll
 * assertion. `GridTable` renders no overflow wrapper — the host owns the scroll
 * container and each row plus the header is `min-w-fit` — so tracks costing
 * more than the container is exactly the state in which a right-edge cell is
 * reachable by scrolling rather than absent.
 */

const ROWS: SessionTableRow[] = [
  createSessionTableRowFixture({
    autonomy: 88,
    branch: "fix/iss-5704-desktop-branch-detail",
    id: "session-1",
    repo: "closedloop-ai/symphony-alpha",
    status: "Active",
    user: { avatarUrl: null, name: "Parker Byrd" },
  }),
  createSessionTableRowFixture({
    autonomy: 74,
    branch: "test/iss-5593-sessions-detail",
    id: "session-2",
    repo: "closedloop-ai/symphony-alpha",
    status: "Active",
    user: { avatarUrl: null, name: "Mike Angstadt" },
  }),
];

/** The 256px primary sidebar plus the inset gutter the grid does NOT get. */
const APP_CHROME_WIDTH_PX = 272;

/** The widths ISS-5813 names, as CONTENT widths the grid is measured at. */
const VIEWPORT_WIDTHS_PX = [1280, 1440, 1920] as const;

/**
 * The retired ISS-5813 Labs/PostHog key, spelled literally because the constant
 * is deleted. Seeded ON below to prove nothing reads it any more — an install
 * carrying a stale `true` must still get the full column set.
 */
const RETIRED_WIDTH_BUDGET_FLAG_KEY = "grid-table-width-budget";

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderAt(
  containerWidthPx: number,
  element: ReactElement,
  { seedRetiredFlag } = { seedRetiredFlag: false }
) {
  restoreContainerWidth?.();
  restoreContainerWidth = stubContainerWidthPx(containerWidthPx);
  if (!seedRetiredFlag) {
    return render(element);
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [RETIRED_WIDTH_BUDGET_FLAG_KEY],
      })}
    >
      {element}
    </FeatureFlagAdapterProvider>
  );
}

function headerRowElement(): HTMLElement {
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  return headerRow;
}

/** Total px the rendered tracks occupy. */
function renderedTableWidthPx(): number {
  return widthsForTemplate(headerRowElement().style.gridTemplateColumns).reduce(
    (total, width) => total + width,
    0
  );
}

function renderedHeaderLabels(): string[] {
  return [...headerRowElement().children]
    .map((cell) => cell.textContent?.trim() ?? "")
    .filter((label) => label.length > 0);
}

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

function sessionsTable() {
  return <SessionsTable items={ROWS} mode="expanded" renderName={renderName} />;
}

describe("Sessions grid renders every column (ISS-6245)", () => {
  // `Repository` is the track ISS-5813's budget yielded first, precisely because
  // it read `closedloop-ai/…` identically on every row. Naming it is the point:
  // a generic "some columns render" assertion would survive the regression.
  it.each(
    VIEWPORT_WIDTHS_PX
  )("keeps the column the budget dropped first at a %spx viewport", (viewportWidthPx) => {
    renderAt(viewportWidthPx - APP_CHROME_WIDTH_PX, sessionsTable());
    const labels = renderedHeaderLabels();
    expect(labels).toContain("Repository");
    expect(labels).toEqual(
      expect.arrayContaining(["Session", "Status", "Cost", "Owner"])
    );
  });

  it.each(
    VIEWPORT_WIDTHS_PX
  )("overflows its container at a %spx viewport, so the host scrolls sideways", (viewportWidthPx) => {
    const containerWidthPx = viewportWidthPx - APP_CHROME_WIDTH_PX;
    renderAt(containerWidthPx, sessionsTable());
    expect(renderedTableWidthPx()).toBeGreaterThan(containerWidthPx);
  });

  it("ignores a stale enabled value for the retired width-budget flag", () => {
    const containerWidthPx = 1440 - APP_CHROME_WIDTH_PX;
    renderAt(containerWidthPx, sessionsTable(), { seedRetiredFlag: true });
    expect(renderedHeaderLabels()).toContain("Repository");
    expect(renderedTableWidthPx()).toBeGreaterThan(containerWidthPx);
  });
});
