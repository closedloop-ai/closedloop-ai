import { SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { stubResizableContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-4906: the Sessions grid's fold fit widens the leading track by the
 * container's leftover. That leftover is bounded by the width of the first
 * NON-fitting track and resets to ~0 the moment the next column starts to fit —
 * so re-fitting on every measured width steps every column after the lead
 * sideways at each threshold a continuous resize drag crosses.
 *
 * The lead's rendered minimum is the behavioural witness: it IS the fitted
 * width, and everything after it is offset by it. These assert it holds still
 * through a run of measurements and moves once, after they stop.
 *
 * Widths are chosen inside one fit band so a re-fit is guaranteed to change the
 * lead — if the damping regressed, the "unchanged" assertions would fail.
 */

/** The leading `minmax(<n>px, …)` track of a rendered grid template. */
const LEAD_TRACK_MIN_PX_PATTERN = /^minmax\((\d+(?:\.\d+)?)px/;
const SETTLE_MS = 150;
const NARROW_WIDTH_PX = 1108;
const WIDER_WIDTH_PX = 1188;

const ROW: SessionTableRow = createSessionTableRowFixture({
  costLabel: "$772.39",
  harness: "Claude Code",
  id: "session-1",
  name: "Fold damping session",
  status: "Active",
});

/** The rendered minimum width of the grid's leading track, in px. */
function renderedLeadWidthPx(): number {
  const table = screen.getByRole("table");
  const template = (table.firstElementChild as HTMLElement).style
    .gridTemplateColumns;
  const lead = template.match(LEAD_TRACK_MIN_PX_PATTERN);
  if (!lead) {
    throw new Error(`No px leading track in rendered template: "${template}"`);
  }
  return Number(lead[1]);
}

function renderTable(enabled: boolean) {
  render(
    <AppCoreStoryProviders
      enabledFlags={
        enabled ? [SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY] : []
      }
    >
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={(row, className) => (
          <span className={className}>{row.name}</span>
        )}
      />
    </AppCoreStoryProviders>
  );
}

describe("SessionsTable fold-fit damping (ISS-4906)", () => {
  let container: ReturnType<typeof stubResizableContainerWidthPx> | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    container?.restore();
    container = null;
    vi.useRealTimers();
  });

  it("flag OFF: re-fits on every measurement, so the lead tracks the width immediately", () => {
    container = stubResizableContainerWidthPx(NARROW_WIDTH_PX);
    renderTable(false);
    const before = renderedLeadWidthPx();

    act(() => container?.setWidth(WIDER_WIDTH_PX));

    // ISS-4889's shipped behavior, and the state the flag-off path must keep.
    expect(renderedLeadWidthPx()).not.toBe(before);
  });

  it("flag ON: holds the fitted lead still while the width keeps changing", () => {
    container = stubResizableContainerWidthPx(NARROW_WIDTH_PX);
    renderTable(true);
    const settledLead = renderedLeadWidthPx();

    // A drag: each frame lands before the settle window elapses.
    for (const width of [1128, 1148, 1168, WIDER_WIDTH_PX]) {
      act(() => container?.setWidth(width));
      act(() => {
        vi.advanceTimersByTime(SETTLE_MS - 1);
      });
      expect(renderedLeadWidthPx()).toBe(settledLead);
    }
  });

  it("flag ON: re-fits once the width stops changing, so the fold still lands on a boundary at rest", () => {
    container = stubResizableContainerWidthPx(NARROW_WIDTH_PX);
    renderTable(true);
    const settledLead = renderedLeadWidthPx();

    act(() => container?.setWidth(WIDER_WIDTH_PX));
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });

    // The ISS-4889 guarantee is stated AT REST — the fit is deferred, not dropped.
    expect(renderedLeadWidthPx()).not.toBe(settledLead);
  });
});
