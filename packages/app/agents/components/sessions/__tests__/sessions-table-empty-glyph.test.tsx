import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostAvailability } from "../../../lib/cost-availability";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-4996 defect B: one table must speak one empty-value glyph.
 *
 * Started and Last-active were the last two columns that returned their own raw
 * "—" string, which the cell wrapped at `text-xs` full opacity, while the eight
 * optional columns beside them rendered the shared `GridEmptyValue` at
 * `text-sm` half opacity. Two glyphs for the same fact — "we have nothing here"
 * — in adjacent cells of the same row.
 *
 * The assertions below deliberately compare against `GridEmptyValue`'s OWN
 * rendered output rather than a hardcoded class string. Asserting the empty
 * cells merely agree with each other would still pass if every column drifted
 * to the same wrong glyph; comparing against the sentinel proves they route
 * through it.
 */

/** A container wider than the table, so no column folds out of the assertions. */
const NATURAL_LAYOUT_CONTAINER_PX = 4000;

const EM_DASH = "—";

/**
 * A session with nothing to say in any optional dimension: no branch, no model,
 * no PRs, no resolvable duration, and — the case this ticket is about — no
 * resolvable start or last-activity time.
 */
const EMPTY_DIMENSION_ROW: SessionTableRow = createSessionTableRowFixture({
  autonomy: null,
  branch: null,
  costAvailability: CostAvailability.NoUsage,
  costLabel: "$0.00",
  durationLabel: null,
  id: "ses-empty",
  lastActivityLabel: null,
  model: null,
  name: "agent/no-signal",
  repo: "acme/app",
  startedLabel: null,
  status: "Working",
  user: { avatarUrl: null, name: "Parker Byrd" },
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

/** The class signature the shared sentinel actually renders with, read from it. */
function sharedEmptyGlyphClassName(): string {
  const { container, unmount } = render(<GridEmptyValue />);
  const span = container.querySelector("span");
  if (!span) {
    throw new Error("GridEmptyValue did not render a span");
  }
  const className = span.className;
  unmount();
  return className;
}

/** Every leaf element in the table whose entire content is the empty glyph. */
function emptyGlyphElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      element.childElementCount === 0 && element.textContent?.trim() === EM_DASH
  );
}

let restoreContainerWidth: (() => void) | null = null;

describe("SessionsTable empty-value glyph parity (ISS-4996)", () => {
  beforeEach(() => {
    restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  it("renders one shared empty glyph for every null-valued dimension in the row", () => {
    const { container } = render(
      <SessionsTable
        items={[EMPTY_DIMENSION_ROW]}
        mode="expanded"
        renderName={renderName}
      />
    );

    const glyphs = emptyGlyphElements(container);
    const distinctClassNames = new Set(glyphs.map((el) => el.className));

    // More than one column is empty, so this cannot pass vacuously.
    expect(glyphs.length).toBeGreaterThan(1);
    // ...and every one of them is the SAME glyph.
    expect(distinctClassNames.size).toBe(1);
    // ...which is the shared sentinel, not a bespoke dash that happens to agree.
    expect([...distinctClassNames][0]).toBe(sharedEmptyGlyphClassName());
  });

  it("routes the Started and Last-active cells specifically through that sentinel", () => {
    // The previous assertion is a set property; this pins the two columns the
    // ticket names, so hiding or reordering them cannot quietly satisfy it.
    const shared = sharedEmptyGlyphClassName();
    const { container } = render(
      <SessionsTable
        // Autonomy is force-included regardless of `visibleColumns`, so give it
        // a value — otherwise its own empty cell joins the count and the
        // assertion stops being about the two columns under test.
        items={[{ ...EMPTY_DIMENSION_ROW, autonomy: 88 }]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={new Set(["started", "lastActivity"])}
      />
    );

    expect(screen.getByText("Started")).toBeTruthy();
    expect(screen.getByText("Last active")).toBeTruthy();

    const glyphs = emptyGlyphElements(container);
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      expect(glyph.className).toBe(shared);
    }
  });
});
