import {
  LossClass,
  type LostWorkSessionRow,
} from "@repo/api/src/types/session-analytics";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LostSessionsTable,
  SESSIONS_UNAVAILABLE_REASON,
} from "../components/lost-sessions-table";

/**
 * The behavioral contract of the lost-session list (ISS-4987), which the
 * page-client suite renders but never exercises: the sort interaction, the
 * caption's population-vs-capped branches, and the three settled states that
 * have to read as three different truths.
 *
 * Raised in review (comment 3709038622): a styling or refactor pass could
 * collapse any of these without a single test going red.
 */

// Module-level per the repo's useTopLevelRegex rule.
const LAST_ACTIVITY_HEADER = /last activity/i;
const POPULATION_57 = /57 sessions in range/i;
/** The component caps the visible list at 12 rows. */
const CAPPED_12 = /showing the 12 costliest/i;
const ANY_POPULATION = /sessions in range/i;
const SHOWING_3 = /showing the 3 costliest/i;
const POPULATION_3 = /3 sessions in range/i;
const ANY_CAPPED = /costliest/i;
const EMPTY_COPY = /no lost sessions in this range/i;
const ACTIONABLE_LABEL = /actionable/i;
const SYSTEMIC_LABEL = /systemic/i;
const UNATTRIBUTED_LABEL = /unattributed/i;

function sessionRow(
  overrides: Partial<LostWorkSessionRow> = {}
): LostWorkSessionRow {
  return {
    cause: "Abandoned mid-run",
    date: "2026-07-20",
    engineer: "Ada Lovelace",
    id: "session-1",
    lossClass: LossClass.Actionable,
    minutes: 30,
    repo: "closedloop-ai/symphony-alpha",
    title: "Investigate the failing gate",
    ...overrides,
  };
}

const ROWS: LostWorkSessionRow[] = [
  sessionRow({ id: "short", minutes: 12, title: "Short run" }),
  sessionRow({
    date: "2026-07-22",
    id: "long",
    lossClass: LossClass.Systemic,
    minutes: 240,
    title: "Long run",
  }),
  sessionRow({
    date: "2026-07-18",
    id: "middle",
    lossClass: LossClass.Unattributed,
    minutes: 90,
    title: "Middle run",
  }),
];

/** Row titles in render order, which is what the sort actually controls. */
function renderedTitles(): string[] {
  const rows = screen.getAllByRole("row").slice(1);
  return rows.map(
    (row) => within(row).getAllByRole("cell")[0].textContent ?? ""
  );
}

describe("the lost-session list", () => {
  it("defaults to the costliest runs first", () => {
    render(
      <LostSessionsTable
        loading={false}
        sessions={ROWS}
        totalLostSessions={3}
      />
    );

    const titles = renderedTitles();
    expect(titles[0]).toContain("Long run");
    expect(titles[2]).toContain("Short run");
  });

  it("re-sorts when a sortable column header is activated", () => {
    render(
      <LostSessionsTable
        loading={false}
        sessions={ROWS}
        totalLostSessions={3}
      />
    );

    // Sorting by last activity is the only other interaction on this screen,
    // and nothing else exercises the handler.
    fireEvent.click(screen.getByRole("button", { name: LAST_ACTIVITY_HEADER }));

    const byDate = renderedTitles();
    expect(byDate[0]).toContain("Long run");
    expect(byDate[2]).toContain("Middle run");

    fireEvent.click(screen.getByRole("button", { name: LAST_ACTIVITY_HEADER }));

    const reversed = renderedTitles();
    expect(reversed[0]).toContain("Middle run");
    expect(reversed[2]).toContain("Long run");
  });

  it("names the whole population and how much of it is on screen when capped", () => {
    const many = Array.from({ length: 30 }, (_unused, index) =>
      sessionRow({ id: `session-${index}`, minutes: index + 1 })
    );

    render(
      <LostSessionsTable
        loading={false}
        sessions={many}
        totalLostSessions={57}
      />
    );

    expect(screen.getByText(POPULATION_57)).toBeInTheDocument();
    expect(screen.getByText(CAPPED_12)).toBeInTheDocument();
  });

  it("claims only what it can see when the totals rollup is unavailable", () => {
    render(
      <LostSessionsTable
        loading={false}
        sessions={ROWS}
        totalLostSessions={null}
      />
    );

    // No population sentence: the caption must not invent a total it does not
    // have, and must not imply the list IS the population.
    expect(screen.queryByText(ANY_POPULATION)).toBeNull();
    expect(screen.getByText(SHOWING_3)).toBeInTheDocument();
  });

  it("does not claim a cap when the list is the whole population", () => {
    render(
      <LostSessionsTable
        loading={false}
        sessions={ROWS}
        totalLostSessions={3}
      />
    );

    expect(screen.getByText(POPULATION_3)).toBeInTheDocument();
    expect(screen.queryByText(ANY_CAPPED)).toBeNull();
  });

  it("keeps unavailable, empty and populated as three distinct states", () => {
    const { rerender } = render(
      <LostSessionsTable
        loading={false}
        sessions={null}
        totalLostSessions={null}
      />
    );
    // Settled WITHOUT a value: a reason, never an empty table that would read
    // as "no lost sessions".
    expect(screen.getByText(SESSIONS_UNAVAILABLE_REASON)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    rerender(
      <LostSessionsTable loading={false} sessions={[]} totalLostSessions={0} />
    );
    // A genuine zero is the best answer this table can give, and says so.
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByText(SESSIONS_UNAVAILABLE_REASON)).toBeNull();

    rerender(
      <LostSessionsTable
        loading={false}
        sessions={ROWS}
        totalLostSessions={3}
      />
    );
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
  });

  it("renders every loss class with its own label rather than one shared tone", () => {
    render(
      <LostSessionsTable
        loading={false}
        sessions={ROWS}
        totalLostSessions={3}
      />
    );

    // All three classes are present in the fixture; each has to be
    // distinguishable, not collapsed into a single styling.
    const table = screen.getByRole("table");
    expect(within(table).getByText(ACTIONABLE_LABEL)).toBeInTheDocument();
    expect(within(table).getByText(SYSTEMIC_LABEL)).toBeInTheDocument();
    expect(within(table).getByText(UNATTRIBUTED_LABEL)).toBeInTheDocument();
  });
});
