/**
 * ISS-9848 — the LOC/$ card states the basis the SERVER published, not the one
 * this client was compiled against.
 *
 * THE DEFECT. The cloud deploys ahead of installed Desktop builds, so an
 * already-shipped client kept describing whatever denominator was current the
 * day it was built. ISS-6526 moved that denominator and every installed viewer
 * went on captioning the number with the old one; only a client release could
 * fix it, which is exactly the wrong lever for a server-side change.
 *
 * `SessionsSummaryCards` is the composite BOTH shells mount — `apps/app`'s
 * Sessions page and the desktop `SessionsView` — so grading it here grades what
 * production renders on both surfaces.
 *
 * The sentence lives inside the card's `InfoHint`, which only mounts its content
 * when open, so every case opens the hint the way a reader does (pointer onto
 * the trigger) rather than asserting against props.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import {
  SessionsSummaryCardId,
  sessionsSummaryCardOptions,
} from "../sessions-summary-card-visibility";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * The sentence a total-cost basis publishes, and the one an older basis-less
 * server falls back to. Spelled out rather than imported from the module under
 * test, so a rewritten map cannot make these cases agree with themselves.
 */
const TOTAL_COST_SENTENCE =
  "Merged gross lines divided by the total estimated cost across matched sessions.";

/** What a basis this build never compiled against must coarsen to. */
const UNRECOGNIZED_SENTENCE =
  "This figure was computed on a basis this version of the app does not recognize.";

/**
 * The OTHER basis-dependent sentence in the same hint — the one that names the
 * numerator and the unit. Spelled out here for the same reason as the two
 * above: a rewritten map must not be able to agree with this fixture.
 */
const LINES_PER_DOLLAR_WHAT =
  "Lines of code merged per dollar, output efficiency. Higher is better.";

/** What that sentence must coarsen to when the basis is unrecognized. */
const UNRECOGNIZED_WHAT =
  "Numerator and denominator are not stated by this response.";

/**
 * A future basis, delivered the way a real one arrives: through `JSON.parse`,
 * from a server newer than this build. ISS-9814's points numerator is the
 * concrete next one.
 *
 * The DTO field is an open `string` (whitlockk review on #6929), so this needs no
 * cast to compile — and that is the contract, not a convenience: a closed union
 * here would let a consumer branch exhaustively over the one member this build
 * knows and never compile the arm these cases exercise.
 */
const NEWER_SERVER_PAYLOAD: Pick<
  AgentSessionUsageSummary,
  "mergedLocPerDollarBasis"
> = JSON.parse('{"mergedLocPerDollarBasis":"pensero_points_over_total_cost"}');

function usageFixture(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      totalSessions: 12,
      totalEstimatedCost: 42,
      apiEstimatedCost: 42,
      mergedPrCount: 7,
      // Identical on EVERY case below. The whole question is whether two
      // responses publishing the same number are told apart by their basis, so
      // a fixture that varied the value would let the number do the
      // distinguishing.
      mergedLocPerDollar: 3.5,
      ...overrides,
    }
  );
}

/**
 * ISS-9978: what the card calls itself when it cannot name the ratio. Spelled
 * out rather than imported from the module under test, like every other fixture
 * here — a rewritten constant must not be able to agree with this file.
 */
const UNRECOGNIZED_LABEL = "Efficiency ratio";

/** The population caption, and what an unrecognized basis coarsens it to. */
const SHIPPED_DETAIL = "across sessions in range";
const UNRECOGNIZED_DETAIL = "scope not stated";

/**
 * Render, open the LOC/$ card's info hint, and return its rendered text.
 *
 * ISS-9978 made the label basis-dependent, and the hint's accessible name is
 * derived from it (`About {label}`), so the name to look under moves with the
 * payload — which is why this takes it rather than assuming the merged label.
 */
function readInfoHintText(
  usage: AgentSessionUsageSummary,
  label: string = LOC_PER_DOLLAR_LABEL
): string {
  render(
    <SessionsSummaryCards authenticated isLoading={false} usage={usage} />
  );
  const trigger = screen.getByRole("button", { name: `About ${label}` });
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  const hint = screen.getByRole("dialog", { name: `About ${label}` });
  return hint.textContent ?? "";
}

describe("ISS-9848 — the LOC/$ card renders the basis the payload states", () => {
  it("states the total-cost basis when the server names it", () => {
    const hint = readInfoHintText(
      usageFixture({ mergedLocPerDollarBasis: "merged_lines_over_total_cost" })
    );

    expect(hint).toContain(TOTAL_COST_SENTENCE);
  });

  it("keeps the pre-ISS-9848 sentence when the server states no basis", () => {
    // An older cloud omits the field. Its divisor IS total estimated cost, so
    // this reader is exactly as correct as it was before the field existed —
    // and must not be captioned "we cannot describe this".
    const hint = readInfoHintText(usageFixture());

    expect(hint).toContain(TOTAL_COST_SENTENCE);
    expect(hint).not.toContain(UNRECOGNIZED_SENTENCE);
  });

  it("declines to describe a basis from a newer server rather than guessing", () => {
    const hint = readInfoHintText(
      usageFixture(NEWER_SERVER_PAYLOAD),
      UNRECOGNIZED_LABEL
    );

    expect(hint).toContain(UNRECOGNIZED_SENTENCE);
    // THE REGRESSION. Before the basis travelled, this response rendered the
    // total-cost sentence over a number computed some other way — one caption,
    // two quantities, and no way for the reader to know which.
    expect(hint).not.toContain(TOTAL_COST_SENTENCE);
  });

  it("still renders the ratio itself under an unrecognized basis", () => {
    // Coarsening the caption must not take the number with it: the value is
    // whatever the server computed, and it is still that value.
    render(
      <SessionsSummaryCards
        authenticated
        isLoading={false}
        usage={usageFixture(NEWER_SERVER_PAYLOAD)}
      />
    );

    expect(screen.getByText("3.50")).toBeInTheDocument();
  });

  it("stops calling the figure LOC/$ when the basis is one it cannot name", () => {
    const hint = readInfoHintText(
      usageFixture(NEWER_SERVER_PAYLOAD),
      UNRECOGNIZED_LABEL
    );

    expect(hint).toContain(UNRECOGNIZED_WHAT);
    // THE REGRESSION. Coarsening only the "how" left this hint reading "Lines
    // of code merged per dollar, output efficiency. Higher is better." directly
    // above "computed on a basis this version of the app does not recognize" —
    // the card naming a numerator, a unit and a direction for a ratio the
    // response had just declined to name (codex review on #6929).
    expect(hint).not.toContain(LINES_PER_DOLLAR_WHAT);
  });

  it("keeps the lines-per-dollar sentence for a stated and an absent basis", () => {
    // Both arms every server in production today lands on. Pinned together
    // because this is what makes the change non-perceivable against a real
    // deployment: the only render that moves is reachable solely from a server
    // newer than this client.
    expect(
      readInfoHintText(
        usageFixture({
          mergedLocPerDollarBasis: "merged_lines_over_total_cost",
        })
      )
    ).toContain(LINES_PER_DOLLAR_WHAT);
    cleanup();
    expect(readInfoHintText(usageFixture())).toContain(LINES_PER_DOLLAR_WHAT);
  });

  it("tells two responses carrying the SAME ratio and DIFFERENT bases apart", () => {
    // Both publish `mergedLocPerDollar: 3.5`. A reader holding only the number
    // cannot separate them, which is the whole reason the basis is on the wire.
    const stated = readInfoHintText(
      usageFixture({ mergedLocPerDollarBasis: "merged_lines_over_total_cost" })
    );
    cleanup();
    const newer = readInfoHintText(
      usageFixture(NEWER_SERVER_PAYLOAD),
      UNRECOGNIZED_LABEL
    );

    expect(stated).not.toBe(newer);
  });
});

/**
 * ISS-9978 — the two surfaces #6929 deliberately left compiled in.
 *
 * The info hint was taught to read its basis from the payload; the card's own
 * LABEL and the caption under the value were not. Both are claims of exactly
 * the kind the hint had stopped making: the label asserts the UNIT and the
 * NUMERATOR ("LOC / $ (Merged)"), the caption asserts the POPULATION ("across
 * sessions in range"). Under a basis this build never compiled against, the
 * card coarsened both sentences and then went on making both claims anyway —
 * the larger of them in the biggest type on the tile.
 */
describe("ISS-9978 — the label and caption state only what the basis claims", () => {
  it("stops naming the unit and numerator in the label under an unrecognized basis", () => {
    render(
      <SessionsSummaryCards
        authenticated
        isLoading={false}
        usage={usageFixture(NEWER_SERVER_PAYLOAD)}
      />
    );

    expect(screen.getByText(UNRECOGNIZED_LABEL)).toBeInTheDocument();
    // THE REGRESSION. The hint said it could not name the ratio while the label
    // 18px above it called the figure lines-of-code per dollar, merged.
    expect(screen.queryByText(LOC_PER_DOLLAR_LABEL)).not.toBeInTheDocument();
  });

  it("stops claiming the population in the caption under an unrecognized basis", () => {
    render(
      <SessionsSummaryCards
        authenticated
        isLoading={false}
        usage={usageFixture(NEWER_SERVER_PAYLOAD)}
      />
    );

    expect(screen.getByText(UNRECOGNIZED_DETAIL)).toBeInTheDocument();
    expect(screen.queryByText(SHIPPED_DETAIL)).not.toBeInTheDocument();
  });

  it("still renders the ratio itself once the label and caption coarsen", () => {
    // The sibling of every negative above: coarsening must not withdraw data
    // the reader can use. Without this, hiding the whole card would pass.
    render(
      <SessionsSummaryCards
        authenticated
        isLoading={false}
        usage={usageFixture(NEWER_SERVER_PAYLOAD)}
      />
    );

    expect(screen.getByText("3.50")).toBeInTheDocument();
  });

  it.each([
    [
      "a stated basis",
      { mergedLocPerDollarBasis: "merged_lines_over_total_cost" },
    ],
    ["no basis at all", {}],
  ])(
    "keeps the shipped label and caption for %s",
    (_case, overrides: Partial<AgentSessionUsageSummary>) => {
      // Both arms every server in production today lands on. This is what makes
      // the change non-perceivable against a real deployment: the only render
      // that moves needs a server newer than this client. Positive siblings for
      // the two `queryByText(...).not` assertions above, on the same locators.
      render(
        <SessionsSummaryCards
          authenticated
          isLoading={false}
          usage={usageFixture(overrides)}
        />
      );

      expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
      expect(screen.getByText(SHIPPED_DETAIL)).toBeInTheDocument();
      expect(screen.queryByText(UNRECOGNIZED_LABEL)).not.toBeInTheDocument();
      expect(screen.queryByText(UNRECOGNIZED_DETAIL)).not.toBeInTheDocument();
    }
  );

  it("leaves the options-menu row naming the card statically", () => {
    // ISS-8900's precedent, applied deliberately: a menu row that renamed itself
    // as the payload changed reads as a DIFFERENT card appearing. The row keeps
    // the stable constant while the card resolves — that divergence is the
    // decision, not a drift, so it is pinned rather than left to be "fixed".
    const locPerDollarOption = sessionsSummaryCardOptions().find(
      (option) => option.key === SessionsSummaryCardId.LocPerDollar
    );

    expect(locPerDollarOption?.label).toBe("LOC / $");
  });
});
