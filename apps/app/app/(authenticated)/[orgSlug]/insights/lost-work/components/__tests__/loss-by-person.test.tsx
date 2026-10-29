import {
  LOSS_CLASS_LABELS,
  LossClass,
  type LostWorkPersonRow,
} from "@repo/api/src/types/session-analytics";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NO_VALUE } from "@/lib/analytics/format";
import {
  BASELINE_UNSET_REASON,
  LossByPerson,
  PEOPLE_UNAVAILABLE_REASON,
} from "../loss-by-person";

const SIX_POINTS_WORSE = /\+6 pts worse/;
const FOUR_POINTS_BETTER = /-4 pts better/;
const NO_VERDICT = /pts worse|pts better/;
const HELD_STEADY = /pts, held steady/;
const ONE_SESSION = /\b1 session\b/;
const TWENTY_SEVEN_SESSIONS = /\b27 sessions\b/;

/**
 * ISS-9714. Coverage for the per-engineer coaching table: the
 * unavailable-vs-loading-vs-populated split, the four `BaselineDelta` arms,
 * the dominant-cause present/absent cell, and real click-driven sorting
 * (including the null-baseline-sorts-last and two-nulls-fall-back-to-name
 * behavior `sortRows` pins).
 */

function personRow(
  overrides: Partial<LostWorkPersonRow> = {}
): LostWorkPersonRow {
  return {
    actionableMinutes: 100,
    actionableRatePct: 40,
    actionableSessions: 4,
    baselineDeltaPts: 5,
    dominantCause: "Ended with error, no artifact",
    dominantCauseClass: LossClass.Actionable,
    engineer: "Alice Adams",
    sessionCount: 10,
    systemicMinutes: 20,
    systemicSessions: 1,
    totalMinutes: 500,
    unattributedMinutes: 10,
    unattributedSessions: 1,
    userId: "user-1",
    ...overrides,
  };
}

/**
 * Resolves the on-screen order of a set of unique engineer names by their
 * first index in the rendered text, so sorting assertions read the real DOM
 * output rather than re-deriving `sortRows`.
 */
function engineerRenderOrder(
  container: HTMLElement,
  names: readonly string[]
): string[] {
  const text = container.textContent ?? "";
  // indexOf returns -1 for a name that never rendered, which would sort a
  // dropped row to the FRONT and report the failure as a wrong order instead
  // of as a missing row. Fail on the real problem first.
  const missing = names.filter((name) => !text.includes(name));
  if (missing.length > 0) {
    throw new Error(`Engineers not rendered: ${missing.join(", ")}`);
  }
  return [...names].sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

const ALICE = personRow({
  actionableMinutes: 100,
  actionableRatePct: 10,
  baselineDeltaPts: 5,
  engineer: "Alice Adams",
  systemicMinutes: 20,
  unattributedMinutes: 30,
  userId: "u-alice",
});
const BOB = personRow({
  actionableMinutes: 200,
  actionableRatePct: 30,
  baselineDeltaPts: null,
  engineer: "Bob Baker",
  systemicMinutes: 40,
  unattributedMinutes: 10,
  userId: "u-bob",
});
const CAROL = personRow({
  actionableMinutes: 50,
  actionableRatePct: 20,
  baselineDeltaPts: -3,
  engineer: "Carol Clark",
  systemicMinutes: 60,
  unattributedMinutes: 50,
  userId: "u-carol",
});
const DAVE = personRow({
  actionableMinutes: 150,
  actionableRatePct: 25,
  baselineDeltaPts: null,
  engineer: "Dave Davis",
  systemicMinutes: 10,
  unattributedMinutes: 20,
  userId: "u-dave",
});
const SORT_TEST_ROWS = [ALICE, BOB, CAROL, DAVE];
const SORT_TEST_NAMES = SORT_TEST_ROWS.map((row) => row.engineer);

describe("LossByPerson availability split", () => {
  it("renders the unavailable reason when settled with no people and not loading", () => {
    render(<LossByPerson loading={false} people={null} />);

    expect(screen.getByText(PEOPLE_UNAVAILABLE_REASON)).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Engineer" })
    ).not.toBeInTheDocument();
  });

  it("renders the table's loading skeleton even though people is still null", () => {
    const { container } = render(<LossByPerson loading={true} people={null} />);

    expect(
      screen.queryByText(PEOPLE_UNAVAILABLE_REASON)
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThan(0);
  });

  it("renders the table when people is a real array instead of the unavailable message", () => {
    render(<LossByPerson loading={false} people={[]} />);

    expect(
      screen.queryByText(PEOPLE_UNAVAILABLE_REASON)
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Engineer" })
    ).toBeInTheDocument();
  });
});

describe("renderPersonRows", () => {
  it('shows "No sessions in this range." for a settled empty list', () => {
    render(<LossByPerson loading={false} people={[]} />);

    expect(screen.getByText("No sessions in this range.")).toBeInTheDocument();
  });

  it("renders a populated row instead of the empty-state message", () => {
    render(<LossByPerson loading={false} people={[personRow()]} />);

    expect(
      screen.queryByText("No sessions in this range.")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Alice Adams")).toBeInTheDocument();
  });
});

describe("BaselineDelta", () => {
  it("renders a dash plus the sr-only reason when the baseline is unset", () => {
    render(
      <LossByPerson
        loading={false}
        people={[personRow({ baselineDeltaPts: null })]}
      />
    );

    expect(screen.getByText(BASELINE_UNSET_REASON)).toBeInTheDocument();
    expect(screen.getByText(NO_VALUE)).toBeInTheDocument();
    expect(screen.queryByText(HELD_STEADY)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_VERDICT)).not.toBeInTheDocument();
  });

  it("renders a real zero delta as a finding, not the unset dash", () => {
    render(
      <LossByPerson
        loading={false}
        people={[personRow({ baselineDeltaPts: 0 })]}
      />
    );

    expect(screen.getByText("0 pts, held steady")).toBeInTheDocument();
    expect(screen.queryByText(BASELINE_UNSET_REASON)).not.toBeInTheDocument();
  });

  it("renders a positive delta as worse, in the error tone", () => {
    render(
      <LossByPerson
        loading={false}
        people={[personRow({ baselineDeltaPts: 6 })]}
      />
    );

    const label = screen.getByText(SIX_POINTS_WORSE);
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass("text-destructive");
  });

  it("renders a negative delta as better, in the success tone", () => {
    render(
      <LossByPerson
        loading={false}
        people={[personRow({ baselineDeltaPts: -4 })]}
      />
    );

    const label = screen.getByText(FOUR_POINTS_BETTER);
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass("text-success-foreground");
  });
});

describe("PersonTableRow dominant cause", () => {
  it("appends the lowercased loss class when a dominant cause is present", () => {
    render(
      <LossByPerson
        loading={false}
        people={[
          personRow({
            dominantCause: "Ended with error, no artifact",
            dominantCauseClass: LossClass.Actionable,
          }),
        ]}
      />
    );

    expect(
      screen.getByText(
        `Ended with error, no artifact, ${LOSS_CLASS_LABELS[LossClass.Actionable].toLowerCase()}`
      )
    ).toBeInTheDocument();
  });

  it('shows "No loss recorded" when there is no dominant cause', () => {
    render(
      <LossByPerson
        loading={false}
        people={[personRow({ dominantCause: null })]}
      />
    );

    expect(screen.getByText("No loss recorded")).toBeInTheDocument();
  });
});

describe("session count pluralization reaches the table", () => {
  it('renders "1 session" for a singular count and "N sessions" for a plural one', () => {
    render(
      <LossByPerson
        loading={false}
        people={[
          personRow({
            actionableSessions: 1,
            engineer: "Solo Runner",
            sessionCount: 1,
            systemicSessions: 0,
            unattributedSessions: 0,
            userId: "u-solo",
          }),
          personRow({
            actionableSessions: 9,
            engineer: "Team Player",
            sessionCount: 27,
            systemicSessions: 0,
            unattributedSessions: 0,
            userId: "u-team",
          }),
        ]}
      />
    );

    expect(screen.getByText(ONE_SESSION)).toBeInTheDocument();
    expect(screen.getByText(TWENTY_SEVEN_SESSIONS)).toBeInTheDocument();
  });
});

describe("sortRows / sortValue driven by real header clicks", () => {
  it("sorts by Lost (actionable minutes) descending by default", () => {
    const { container } = render(
      <LossByPerson loading={false} people={SORT_TEST_ROWS} />
    );

    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Bob Baker",
      "Dave Davis",
      "Alice Adams",
      "Carol Clark",
    ]);
  });

  it("toggles Lost to ascending when its active header is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LossByPerson loading={false} people={SORT_TEST_ROWS} />
    );

    await user.click(screen.getByRole("button", { name: "Lost" }));

    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Carol Clark",
      "Alice Adams",
      "Dave Davis",
      "Bob Baker",
    ]);
  });

  it("sorts by Loss rate descending on first click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LossByPerson loading={false} people={SORT_TEST_ROWS} />
    );

    await user.click(screen.getByRole("button", { name: "Loss rate" }));

    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Bob Baker",
      "Dave Davis",
      "Carol Clark",
      "Alice Adams",
    ]);
  });

  it("sorts by Systemic descending on first click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LossByPerson loading={false} people={SORT_TEST_ROWS} />
    );

    await user.click(screen.getByRole("button", { name: "Systemic" }));

    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Carol Clark",
      "Bob Baker",
      "Alice Adams",
      "Dave Davis",
    ]);
  });

  it("sorts by Unattributed descending on first click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LossByPerson loading={false} people={SORT_TEST_ROWS} />
    );

    await user.click(screen.getByRole("button", { name: "Unattributed" }));

    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Carol Clark",
      "Alice Adams",
      "Dave Davis",
      "Bob Baker",
    ]);
  });

  it("sorts a null baseline delta to the end in BOTH directions, tie-broken by engineer name", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LossByPerson loading={false} people={SORT_TEST_ROWS} />
    );

    await user.click(screen.getByRole("button", { name: "vs own baseline" }));

    // desc: non-null values ranked normally (5, then -3); both nulls (Bob,
    // Dave) fall to the end, ordered by `engineer.localeCompare` rather than
    // being graded as a zero.
    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Alice Adams",
      "Carol Clark",
      "Bob Baker",
      "Dave Davis",
    ]);

    await user.click(screen.getByRole("button", { name: "vs own baseline" }));

    // asc: the two real values flip (-3 before 5), but the null pair stays
    // "Bob Baker" before "Dave Davis" — the localeCompare tie-break does not
    // reverse with direction. pins current behavior; looks odd because the
    // null fallback branch never multiplies by `direction`. Filed as ISS-9716;
    // this expectation is the one that flips when that is fixed.
    expect(engineerRenderOrder(container, SORT_TEST_NAMES)).toEqual([
      "Carol Clark",
      "Alice Adams",
      "Bob Baker",
      "Dave Davis",
    ]);
  });
});
