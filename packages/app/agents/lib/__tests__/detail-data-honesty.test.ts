/**
 * ISS-5519 + ISS-5521 — the agent-detail metric cards say only what the payload
 * backs up.
 *
 * ISS-5519: the header row rendered `LOC / $ 9.03` beside `LINES SHIPPED —` and
 * `TOTAL COST —`. The screen appeared to state a quotient of two numbers it
 * simultaneously said it did not have. It is NOT actually a quotient — the ratio
 * is the server's session-level `locPerDollar`, computed from an entirely
 * different population — but the two dashes read as its operands and made a real
 * number look fabricated. Those two cards reduce over `branchesTab`, whose every
 * row the server hardcodes to `additions: null` / `estimatedCostUsd: null`
 * (`service/detail-session-tabs.ts` `buildBranchesTab`) and which the desktop
 * detail sends as `[]`, so they can never carry a value on either surface.
 *
 * ISS-5521: `mergedPrs` is counted server-side over the first
 * `COHORT_SCAN_CAP` cohort sessions in Set-insertion order, while the card's own
 * tooltip claimed it covered "every session" / "the full session cohort". On
 * `tool::bash` that was 2,000 of 7,247 sessions — 28% of the stated population,
 * presented as all of it.
 *
 * ISS-5519's card-dropping is gated by `agents-detail-honesty` (ISS-4779
 * closed-by-default) and every assertion about it is paired with its flag-OFF
 * counterpart: that gate must change nothing until it is turned on.
 *
 * ISS-6462 took the ISS-5521 coverage DISCLOSURE out of that gate — the Packs
 * Performance tile discloses the same cap off the same field ungated, so a flag
 * here left one of the two screens claiming coverage it does not have. Its
 * flag-OFF cases below therefore assert the disclosure IS present, not absent.
 */
import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { COHORT_SCAN_CAP } from "@repo/api/src/types/analytics";
import { makeDetail } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { describe, expect, it } from "vitest";
import { type ComponentMetric, componentMetrics } from "../detail-data";

/**
 * A branch row exactly as `buildBranchesTab` emits it: the branch identity is
 * hydrated, every measurement on it is null. `BranchRow` is declared but not
 * exported by the types module, so the element type is taken from the field.
 */
type DetailBranchRow = AgentComponentDetail["branchesTab"][number];
const unmeasuredBranch = {
  prState: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: null,
} as DetailBranchRow;

const cardKeys = (metrics: readonly ComponentMetric[]): string[] =>
  metrics.map((metric) => metric.key);

const card = (
  metrics: readonly ComponentMetric[],
  key: string
): ComponentMetric | undefined => metrics.find((metric) => metric.key === key);

describe("componentMetrics — dead operand cards (ISS-5519)", () => {
  // The production shape: a subagent whose branch rows exist but carry no
  // measurement, alongside a REAL server-computed LOC/$.
  const subagentWithUnmeasuredBranches = makeDetail({
    kind: AgentComponentKind.Subagent,
    locPerDollar: 9.03,
    branchesTab: Array.from({ length: 12 }, () => unmeasuredBranch),
  });

  it("drops Lines shipped and Total cost when nothing measured them", () => {
    const metrics = componentMetrics(subagentWithUnmeasuredBranches, {
      honest: true,
    });

    expect(cardKeys(metrics)).not.toContain("lines");
    expect(cardKeys(metrics)).not.toContain("cost");
  });

  it("keeps rendering the LOC/$ it can actually compute", () => {
    // The point of the ticket: the ratio is real and must NOT be suppressed
    // alongside the cards that looked like its operands. A fix that dashed this
    // out too would "resolve" the contradiction by deleting the true statement.
    const metrics = componentMetrics(subagentWithUnmeasuredBranches, {
      honest: true,
    });

    expect(card(metrics, "loc-per-dollar")?.value).toBe("9.03");
  });

  it("still renders both cards when the branch rows carry real measurements", () => {
    const measured = makeDetail({
      kind: AgentComponentKind.Subagent,
      branchesTab: [
        { ...unmeasuredBranch, additions: 120, estimatedCostUsd: 4 },
        { ...unmeasuredBranch, additions: 30, estimatedCostUsd: 1.5 },
      ],
    });

    const metrics = componentMetrics(measured, { honest: true });

    // Suppression is keyed on "no measurement", never on the kind — a hydrated
    // payload must bring both cards straight back with no further change.
    expect(card(metrics, "lines")?.value).toBe("150");
    expect(card(metrics, "cost")?.value).toBe("$5.50");
  });

  it("flag OFF leaves both dashed cards exactly where they were", () => {
    const metrics = componentMetrics(subagentWithUnmeasuredBranches);

    expect(card(metrics, "lines")?.value).toBe("—");
    expect(card(metrics, "cost")?.value).toBe("—");
  });
});

describe("componentMetrics — Merged PRs population (ISS-5521)", () => {
  const cappedCohort = makeDetail({
    sessions: 7247,
    mergedPrs: 996,
    mergedPrsTruncated: true,
  });

  it("marks a capped count as a floor rather than a total", () => {
    const merged = card(
      componentMetrics(cappedCohort, { honest: true }),
      "merged"
    );

    // The trailing `+` is this page's own partial-total convention
    // (`detailTabTruncationReadout`, ISS-5464) — the Branches tab a click below
    // says "of 50+ branches". A second glyph for one concept on one page is the
    // drift that convention exists to stop.
    expect(merged?.value).toBe("996+");
  });

  it("names the population it actually counted, and stops claiming every session", () => {
    const merged = card(
      componentMetrics(cappedCohort, { honest: true }),
      "merged"
    );

    // The defect was the copy, not only the number: a tooltip asserting "every
    // session" over a 28% sample is the metric disagreeing with its own label.
    expect(merged?.info?.what).not.toContain("every session");
    expect(merged?.info?.how).not.toContain("full session cohort");
    expect(merged?.info?.how).toContain(
      COHORT_SCAN_CAP.toLocaleString("en-US")
    );
  });

  it("leaves an uncapped cohort's count and copy untouched", () => {
    const wholeCohort = makeDetail({
      sessions: 300,
      mergedPrs: 42,
      mergedPrsTruncated: false,
    });

    const merged = card(
      componentMetrics(wholeCohort, { honest: true }),
      "merged"
    );

    // A component whose cohort fit the scan genuinely IS counted over every
    // session — caveating it would be the same defect pointed the other way.
    expect(merged?.value).toBe("42");
    expect(merged?.info?.what).toContain("every session");
  });

  it("does not caveat a count it does not have", () => {
    // A version-skewed server can report truncation while omitting the count.
    // `≥—` is not a statement about anything.
    const merged = card(
      componentMetrics(
        makeDetail({ mergedPrs: null, mergedPrsTruncated: true }),
        { honest: true }
      ),
      "merged"
    );

    expect(merged?.value).toBe("—");
  });

  it("does not claim the floor is strictly exceeded", () => {
    const merged = card(
      componentMetrics(cappedCohort, { honest: true }),
      "merged"
    );

    // codex review (#4962): a truncated cohort whose unscanned remainder holds
    // no merged PRs — or only PRs already in the scanned sample — has a real
    // total EQUAL to the displayed floor. "At least N" is honest; "the real
    // number is higher" is a strict inequality the data cannot support.
    expect(merged?.info?.how).toContain("may be higher");
    expect(merged?.info?.how).not.toContain("The real number is higher");
  });

  /**
   * ISS-6462 (wongk, #5096 review): the expectation changed because the
   * DISCLOSURE left the `agents-detail-honesty` flag's scope.
   *
   * The Packs Performance tile shipped the same cap disclosure off the same
   * field with no gate, so while this stayed gated the default path had one
   * screen reading "996+ (capped scan)" and this one a bare "996" under an
   * "every session" claim — one response, one cap, two contradicting answers.
   * The flag still owns the unrelated card-dropping, which the suite above
   * still pins on both settings.
   */
  it("discloses the cap with the flag OFF, because the Packs tile does too", () => {
    const merged = card(componentMetrics(cappedCohort), "merged");

    expect(merged?.value).toBe("996+");
    expect(merged?.info?.what).not.toContain("every session");
    expect(merged?.info?.how).toContain(
      COHORT_SCAN_CAP.toLocaleString("en-US")
    );
  });
});

describe("componentMetrics — undeclared Merged PRs coverage (ISS-5521 skew)", () => {
  /**
   * The wire shape of an older cloud server: it applied `COHORT_SCAN_CAP` just
   * like the current one, but predates the disclosure field and therefore OMITS
   * it. `makeDetail` spreads `EMPTY_COHORT_DELIVERY_METRICS`, which declares
   * `mergedPrsTruncated: false`, so the omission has to be re-created explicitly
   * — a fixture that merely left the override off would silently test the
   * declared-complete case instead.
   */
  const skewedProducer = (): AgentComponentDetail => {
    const detail = makeDetail({ sessions: 7247, mergedPrs: 996 });
    Reflect.deleteProperty(detail, "mergedPrsTruncated");
    return detail;
  };

  it("stops claiming the count covered every session", () => {
    const merged = card(
      componentMetrics(skewedProducer(), { honest: true }),
      "merged"
    );

    // codex review (#4962): coercing omission to `false` put this card back on
    // the "every session" copy for exactly the producer most likely to have
    // capped the scan silently.
    expect(merged?.info?.what).not.toContain("every session");
    expect(merged?.info?.how).not.toContain("full session cohort");
    expect(merged?.info?.how).toContain("may be higher");
  });

  it("does not invent a cap the producer never reported", () => {
    const merged = card(
      componentMetrics(skewedProducer(), { honest: true }),
      "merged"
    );

    // Unknown is not "truncated". The floor marker is an assertion in its own
    // right, and this response supports neither assertion — so the number is
    // rendered bare and only the copy carries the uncertainty.
    expect(merged?.value).toBe("996");
  });

  it("drops the full-cohort claim with the flag OFF too (ISS-6462)", () => {
    // Same reason as the capped case above: the disclosure is no longer gated,
    // so the skewed producer's undeclared coverage reads as undeclared on the
    // default path rather than as "every session".
    const merged = card(componentMetrics(skewedProducer()), "merged");

    expect(merged?.value).toBe("996");
    expect(merged?.info?.what).not.toContain("every session");
    expect(merged?.info?.how).toContain("may be higher");
  });
});
