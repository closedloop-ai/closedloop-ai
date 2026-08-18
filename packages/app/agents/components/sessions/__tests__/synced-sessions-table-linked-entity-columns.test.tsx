import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import {
  SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID,
  SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID,
  sessionLinkedChipsTrackTestId,
} from "@repo/app/agents/lib/session-linked-entity-chips";
import {
  DS_CHIP_FIT_GEOMETRY,
  estimateChipPlusOverflowWidthPx,
} from "@repo/app/agents/lib/session-qualifier-fit";
import {
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_LABEL,
  SESSIONS_LINKED_ENTITY_COLUMN_MIN_WIDTH_PX,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_LABEL,
} from "@repo/app/agents/lib/sessions-table-columns";
import { GRID_TABLE_V2_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import type { GridTableMode } from "@repo/design-system/components/ui/grid-table";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import { renderWithFlags } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * FEA-4209 / FEA-4210: the `Projects` and `Linked issues` columns.
 *
 * Cells are located by `data-column-id`, never by header text or accessible
 * name. Every Sessions header cell carries a reorder grip, so a
 * header's accessible name is NOT its label, and matching on it silently reads
 * the wrong track.
 */

const SESSION_NAME = "Linked entity row";
const ORG_SLUG = "acme";
/** Comfortably above `CARD_FALLBACK_BREAKPOINT` (768), so the grid path renders. */
const GRID_CONTAINER_WIDTH_PX = 1200;
/**
 * Enough `FEA-####` chips that the measured fit cannot show them all at
 * {@link GRID_CONTAINER_WIDTH_PX} — the estimate is ~90px per chip, so a dozen
 * is already past it and twenty leaves no doubt.
 */
const OVERFLOWING_ISSUE_COUNT = 20;
/**
 * `pl-3` (12) + `pr-3` (12) on a grid body cell — see `GridTableCell`. ISS-5812
 * removed the extra `pl-9` grip lane a reorderable column used to carry, so a
 * reorderable cell spends the same 24px as any other.
 */
const GRID_CELL_PADDING_PX = 24;
/** The overflow control names what it hides, rather than announcing a bare count. */
const OVERFLOW_NAME_REGEX = /^\d+ more issues: FEA-/;

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function issue(
  id: string,
  slug: string,
  overrides: Partial<SessionLinkedArtifact> = {}
): SessionLinkedArtifact {
  return {
    id,
    slug,
    name: null,
    documentType: DocumentType.Feature,
    role: "referenced",
    ...overrides,
  };
}

function buildIssueHref(artifact: SessionLinkedArtifact): string | null {
  return artifact.slug ? `/${ORG_SLUG}/issues/${artifact.slug}` : null;
}

function renderTable(
  options: Readonly<{
    linkedArtifacts?: SessionLinkedArtifact[];
    project?: { id: string; name: string; slug: string | null } | null;
    flagOn?: boolean;
    optIn?: boolean;
    /**
     * Pins the layout instead of depending on an unmeasured container:
     * `expanded` is always the grid, `compact` always the card fallback.
     */
    mode?: GridTableMode;
  }> = {}
) {
  const {
    linkedArtifacts = [],
    project = null,
    flagOn = true,
    optIn = true,
    mode,
  } = options;
  return renderWithFlags(
    <SyncedSessionsTable
      getIssueHref={buildIssueHref}
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={[
        createAgentSessionListItemFixture({
          linkedArtifacts,
          name: SESSION_NAME,
          project,
        }),
      ]}
      mode={mode}
      showLinkedEntityColumns={optIn}
    />,
    flagOn ? [GRID_TABLE_V2_FEATURE_FLAG_KEY] : []
  );
}

function cellFor(columnId: string): HTMLElement {
  const row = screen.getByText(SESSION_NAME).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find the sessions row for ${SESSION_NAME}`);
  }
  const cell = row.querySelector(`[data-column-id="${columnId}"]`);
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Row has no cell for column "${columnId}"`);
  }
  return cell;
}

function queryCell(columnId: string): Element | null {
  return document.querySelector(`[data-column-id="${columnId}"]`);
}

describe("Sessions table — linked-entity columns (FEA-4209 / FEA-4210)", () => {
  it("renders the session's project as a named chip in the Projects column", () => {
    renderTable({
      project: { id: "project-1", name: "Platform Core", slug: "platform" },
    });

    expect(
      screen.getByText(SESSIONS_PROJECTS_COLUMN_LABEL)
    ).toBeInTheDocument();
    // The VALUE, in the right track — not merely "a chip rendered somewhere".
    expect(cellFor(SESSIONS_PROJECTS_COLUMN_ID)).toHaveTextContent(
      "Platform Core"
    );
  });

  it("discloses a project name in full even though its cell can never overflow", () => {
    // The Projects column is the one place `+N` can never be the escape hatch:
    // the contract yields at most one project, and the fit returns early for a
    // single chip. The label is rendered in a `truncate` span inside a narrow
    // track, so without a per-chip tooltip a long name would be unreadable with
    // no affordance at all — no overflow, no tooltip, no accessible name.
    const longName = "Platform Core Infrastructure and Developer Tooling";
    renderTable({ project: { id: "project-1", name: longName, slug: null } });

    const cell = cellFor(SESSIONS_PROJECTS_COLUMN_ID);
    // No overflow control exists for this cell — that is the premise, not an
    // incidental detail, so assert it rather than assume it.
    expect(
      cell.querySelector(
        `[data-testid="${SESSION_LINKED_PROJECTS_OVERFLOW_TEST_ID}"]`
      )
    ).toBeNull();
    const disclosure = cell.querySelector('[data-testid="tooltip-content"]');
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveTextContent(longName);
  });

  it("renders a session with no project as the shared empty sentinel, not a blank cell", () => {
    renderTable({ project: null });

    expect(cellFor(SESSIONS_PROJECTS_COLUMN_ID).textContent?.trim()).toBe("—");
  });

  it("renders each linked issue as a chip that links to that issue", () => {
    renderTable({ linkedArtifacts: [issue("artifact-1", "FEA-654")] });

    expect(screen.getByText(SESSIONS_ISSUES_COLUMN_LABEL)).toBeInTheDocument();
    const cell = cellFor(SESSIONS_ISSUES_COLUMN_ID);
    expect(cell).toHaveTextContent("FEA-654");
    // Content AND destination. A chip that "renders" proves nothing if the
    // resolver returned the wrong route, or no route at all.
    const link = cell.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", `/${ORG_SLUG}/issues/FEA-654`);
  });

  it("keeps non-issue linked artifacts out of the Linked issues column", () => {
    renderTable({
      linkedArtifacts: [
        issue("artifact-1", "FEA-654"),
        issue("artifact-2", "PRD-557", { documentType: DocumentType.Prd }),
        issue("artifact-3", "PLN-1034", {
          documentType: DocumentType.ImplementationPlan,
        }),
      ],
    });

    const cell = cellFor(SESSIONS_ISSUES_COLUMN_ID);
    expect(cell).toHaveTextContent("FEA-654");
    // A column headed "Linked issues" that lists a PRD is a mislabel, not a
    // bonus. Asserted on the CELL, so a PRD rendered in some other column does
    // not fail this and a PRD rendered here cannot pass it.
    expect(cell).not.toHaveTextContent("PRD-557");
    expect(cell).not.toHaveTextContent("PLN-1034");
  });

  it("renders an inert chip, not a dead link, when no route resolves for an issue", () => {
    renderWithFlags(
      <SyncedSessionsTable
        // No `getIssueHref`: the host could not resolve a destination.
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            linkedArtifacts: [issue("artifact-1", "FEA-654")],
            name: SESSION_NAME,
          }),
        ]}
        showLinkedEntityColumns
      />,
      [GRID_TABLE_V2_FEATURE_FLAG_KEY]
    );

    const cell = cellFor(SESSIONS_ISSUES_COLUMN_ID);
    expect(cell).toHaveTextContent("FEA-654");
    expect(cell.querySelector("a")).toBeNull();
  });

  it("names every hidden issue on the overflow control rather than announcing a bare count", () => {
    // A measured width, via the shared shim, so the fit is exercised against a
    // real number rather than jsdom's absent layout — and comfortably above
    // `CARD_FALLBACK_BREAKPOINT`, because the card path is deliberately uncapped
    // and would render no counter at all.
    restoreContainerWidth = stubContainerWidthPx(GRID_CONTAINER_WIDTH_PX);
    const slugs = Array.from(
      { length: OVERFLOWING_ISSUE_COUNT },
      (_unused, index) => `FEA-${9900 + index}`
    );
    renderTable({
      linkedArtifacts: slugs.map((slug, index) =>
        issue(`artifact-${index}`, slug)
      ),
    });

    // A real `<button>`, reachable by keyboard and touch — not a hover-only
    // secret on a role-less span.
    const overflow = screen.getByTestId(SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID);
    expect(overflow.tagName).toBe("BUTTON");
    const accessibleName = overflow.getAttribute("aria-label") ?? "";
    // `+N` announced alone is not a fact anybody can act on, so the control's
    // own name lists what it is hiding.
    expect(accessibleName).toMatch(OVERFLOW_NAME_REGEX);
    // The LAST slug cannot have fitted, so it must be named by the control and
    // must not also be sitting in the row as a visible chip.
    const lastSlug = slugs.at(-1) ?? "";
    expect(accessibleName).toContain(lastSlug);
    expect(
      cellFor(SESSIONS_ISSUES_COLUMN_ID).querySelector("a")
    ).toHaveAttribute("href", `/${ORG_SLUG}/issues/${slugs[0]}`);
    expect(screen.queryByText(lastSlug)).not.toBeInTheDocument();
  });

  it("renders neither column while the shared grid-table-v2 flag is off", () => {
    renderTable({
      flagOn: false,
      linkedArtifacts: [issue("artifact-1", "FEA-654")],
      project: { id: "project-1", name: "Platform Core", slug: "platform" },
    });

    expect(queryCell(SESSIONS_PROJECTS_COLUMN_ID)).toBeNull();
    expect(queryCell(SESSIONS_ISSUES_COLUMN_ID)).toBeNull();
    expect(
      screen.queryByText(SESSIONS_ISSUES_COLUMN_LABEL)
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Platform Core")).not.toBeInTheDocument();
    expect(screen.queryByText("FEA-654")).not.toBeInTheDocument();
  });

  it("floors both tracks wide enough to hold a chip AND its overflow counter", () => {
    // The floor's whole job. A grid body cell spends `pl-3` (12) + `pr-3` (12)
    // = 24px before any content (ISS-5812 removed the extra `pl-9` grip lane a
    // reorderable cell used to carry). Subtracting the wrong padding is what
    // made the first draft of this floor 30px short, so the check runs the real
    // arithmetic instead of restating a number.
    const contentBoxPx =
      SESSIONS_LINKED_ENTITY_COLUMN_MIN_WIDTH_PX - GRID_CELL_PADDING_PX;
    expect(contentBoxPx).toBeGreaterThanOrEqual(
      estimateChipPlusOverflowWidthPx("FEA-4209", DS_CHIP_FIT_GEOMETRY)
    );
  });

  it("clips the capped grid track but WRAPS the uncapped card track", () => {
    // The card path is uncapped: every chip lands in `visible` and no `+N`
    // renders, so there is no overflow control left to reach a clipped chip by.
    // Keeping the grid track's single-line `overflow-hidden` there made every
    // chip past the card field's width unreachable — the defect this pairs
    // against.
    //
    // jsdom has no layout, so the clipping itself is unobservable; the layout
    // RULES are the falsifiable part. Both modes are asserted so neither
    // absence can pass vacuously: `overflow-hidden` must be present on the grid
    // track for its absence on the card track to mean anything, and `flex-wrap`
    // must be absent on the grid track for its presence on the card track to.
    const slugs = Array.from(
      { length: OVERFLOWING_ISSUE_COUNT },
      (_unused, index) => `FEA-${9900 + index}`
    );
    const linkedArtifacts = slugs.map((slug, index) =>
      issue(`artifact-${index}`, slug)
    );
    const trackTestId = sessionLinkedChipsTrackTestId(
      SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID
    );

    const grid = renderTable({ linkedArtifacts, mode: "expanded" });
    const gridTrack = screen.getByTestId(trackTestId);
    expect(gridTrack.className).toContain("overflow-hidden");
    expect(gridTrack.className).not.toContain("flex-wrap");
    grid.unmount();

    renderTable({ linkedArtifacts, mode: "compact" });
    const cardTrack = screen.getByTestId(trackTestId);
    expect(cardTrack.className).toContain("flex-wrap");
    expect(cardTrack.className).not.toContain("overflow-hidden");
    // The premise of the whole assertion: the card mode really did render
    // uncapped, so no `+N` exists and wrapping is the only way any of these
    // links stays reachable.
    expect(
      screen.queryByTestId(SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID)
    ).toBeNull();
    expect(
      cardTrack.querySelectorAll(`a[href^="/${ORG_SLUG}/issues/"]`)
    ).toHaveLength(slugs.length);
  });

  it("bounds the overflow popover to the room Radix measured, so its tail is reachable", () => {
    // `linkedArtifacts` is not a handful in the tail — the projection test
    // carries 27 — and an unbounded list runs past the viewport and strands the
    // links below the fold, which is the exact unreachability the popover exists
    // to fix.
    restoreContainerWidth = stubContainerWidthPx(GRID_CONTAINER_WIDTH_PX);
    renderTable({
      linkedArtifacts: Array.from(
        { length: OVERFLOWING_ISSUE_COUNT },
        (_unused, index) => issue(`artifact-${index}`, `FEA-${9900 + index}`)
      ),
    });

    const trigger = screen.getByTestId(SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID);
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog");
    // Both halves, because either alone is inert: a max-height that never
    // scrolls just hides the tail, and a scroll container with no bound never
    // scrolls.
    expect(panel.className).toContain(
      "max-h-(--radix-popover-content-available-height)"
    );
    expect(panel.className).toContain("overflow-y-auto");
  });

  it("renders neither column for a host that did not opt in, even with the flag on", () => {
    // The desktop Sessions list: its local producer emits neither `project` nor
    // `linkedArtifacts`, so it must not grow two tracks of em dashes when the
    // Labs toggle for the shared key is flipped.
    renderTable({
      linkedArtifacts: [issue("artifact-1", "FEA-654")],
      optIn: false,
      project: { id: "project-1", name: "Platform Core", slug: "platform" },
    });

    expect(queryCell(SESSIONS_PROJECTS_COLUMN_ID)).toBeNull();
    expect(queryCell(SESSIONS_ISSUES_COLUMN_ID)).toBeNull();
  });
});
