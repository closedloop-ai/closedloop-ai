import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { trackWidthsPx as widthsForTemplate } from "@repo/app/test/grid-track-geometry";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable } from "../agents-table";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-6245 — the Agents inventory renders EVERY declared track and lets the
 * host scroll sideways, at the widths ISS-5522 filed.
 *
 * This is the counterfactual guard for the width-budget removal. ISS-5813's
 * budget dropped whole data columns to make the row fit; the trade was never
 * wanted, so the column set is now unconditional and overflow is the answer.
 * Re-introducing any collapse-to-fit path fails these cases: the yielded column
 * disappears from the header set, and the rendered track total stops exceeding
 * the container.
 *
 * `renderedTableWidthPx() > containerWidthPx` IS the horizontal-scroll
 * assertion. `GridTable` renders no overflow wrapper — the host owns the scroll
 * container and each row plus the header is `min-w-fit` — so tracks costing
 * more than the container is exactly the state in which a right-edge cell is
 * reachable by scrolling rather than absent.
 */

const APP_CHROME_WIDTH_PX = 272;

/** The widths ISS-5522 filed, plus ISS-5813's third measured width. */
const VIEWPORT_WIDTHS_PX = [1280, 1440] as const;

/**
 * The retired ISS-5813 Labs/PostHog key, spelled literally because the constant
 * is deleted. Seeded ON below to prove nothing reads it any more — an install
 * carrying a stale `true` must still get the full column set.
 */
const RETIRED_WIDTH_BUDGET_FLAG_KEY = "grid-table-width-budget";

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    harness: Harness.Claude,
    id: "uuid-default",
    invocations: 10,
    kind: AgentComponentKind.Mcp,
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    locPerDollar: 2.5,
    name: "Default Component",
    sessions: 3,
    slug: "mcp::uuid-default",
    source: "repo-a",
    sourceType: SourceType.Repo,
    trend: [],
    ...overrides,
  };
}

// The five tool components ISS-5522 named going blank.
const ITEMS: AgentComponent[] = ["bash", "read", "edit", "grep", "write"].map(
  (name, index) =>
    makeComponent({
      id: `uuid-${name}`,
      invocations: 10 + index,
      kind: AgentComponentKind.Tool,
      locPerDollar: 2.5 + index,
      name,
      sessions: 3 + index,
      slug: `tool::${name}`,
    })
);

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderTableAt(
  containerWidthPx: number,
  { seedRetiredFlag } = { seedRetiredFlag: false }
) {
  restoreContainerWidth?.();
  restoreContainerWidth = stubContainerWidthPx(containerWidthPx);
  const table = (
    <AgentsTable
      getComponentHref={(item) => `/agents/${encodeURIComponent(item.id)}`}
      items={ITEMS}
      metricMode={AgentMetricMode.LocPerDollar}
      onSort={() => {
        // no-op
      }}
      sortBy="name"
      sortDir="asc"
    />
  );
  return render(
    seedRetiredFlag ? (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [RETIRED_WIDTH_BUDGET_FLAG_KEY],
        })}
      >
        {table}
      </FeatureFlagAdapterProvider>
    ) : (
      table
    ),
    { wrapper: AppCoreStoryProviders }
  );
}

function headerRowElement(): HTMLElement {
  const headerRow = screen.getByText("Component").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the agents table header row");
  }
  return headerRow;
}

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

describe("Agents inventory renders every column (ISS-6245)", () => {
  // `Source` and `Harness` are the two tracks ISS-5813's budget yielded at these
  // widths. Naming them specifically is the point: a generic "some columns
  // render" assertion would survive the exact regression this guards.
  it.each(
    VIEWPORT_WIDTHS_PX
  )("keeps the columns the budget used to drop at a %spx viewport", (viewportWidthPx) => {
    renderTableAt(viewportWidthPx - APP_CHROME_WIDTH_PX);
    const labels = renderedHeaderLabels();
    expect(labels).toContain("Component");
    expect(labels).toContain("Source");
    expect(labels).toContain("Harness");
  });

  it.each(
    VIEWPORT_WIDTHS_PX
  )("overflows its container at a %spx viewport, so the host scrolls sideways", (viewportWidthPx) => {
    const containerWidthPx = viewportWidthPx - APP_CHROME_WIDTH_PX;
    renderTableAt(containerWidthPx);
    expect(renderedTableWidthPx()).toBeGreaterThan(containerWidthPx);
  });

  it("ignores a stale enabled value for the retired width-budget flag", () => {
    const containerWidthPx = 1280 - APP_CHROME_WIDTH_PX;
    renderTableAt(containerWidthPx, { seedRetiredFlag: true });
    const labels = renderedHeaderLabels();
    expect(labels).toContain("Source");
    expect(labels).toContain("Harness");
    expect(renderedTableWidthPx()).toBeGreaterThan(containerWidthPx);
  });
});
