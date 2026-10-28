import { describe, expect, it } from "vitest";
import {
  ALL_SESSION_COUNT_POPULATIONS,
  SESSION_COUNT_DATE_BASIS,
  SESSION_COUNT_POPULATION,
  SESSION_COUNT_POPULATION_SCOPE,
  type SessionCountPopulation,
} from "../session-count-population";
import { differingScopeAxes } from "../session-count-population-reconciliation";

/**
 * ISS-10604: which stored timestamp each windowed count's range is measured
 * against, written out by hand from the traced SQL rather than read out of the
 * module it polices. A fixture built from `SESSION_COUNT_DATE_BASIS` would agree
 * with a wrong assignment, which is the false-green this repo has shipped.
 *
 * The two LIST rows read `lastActivity` — cloud through
 * `SESSIONS_SURFACE_DATE_FIELD = "lastActivityAt"`, desktop through
 * `SESSIONS_SURFACE_DATE_WINDOW_FIELD`.
 *
 * The two DASHBOARD rows are GONE rather than moved to `lastActivity`.
 * ISS-10604's ruling (2026-09-17: align, onto the list's basis) shipped behind
 * `sessions-analytics-activity-window` default-off, so while that gate stood the
 * rows correctly read `started` — what the axis disclosed, not what the rollout
 * would make it (#7549 review, whitlockk). ISS-10541 retired the cohort AND the two
 * populations: the tile renders `sessionsInWindowOrg` /
 * `sessionsInWindowThisDevice`, so there is nothing separate left to answer for.
 */
const EXPECTED_DATE_BASIS = [
  { population: "sessionsInWindowOrg", dateBasis: "lastActivity" },
  { population: "sessionsInWindowThisDevice", dateBasis: "lastActivity" },
  { population: "localSessionCorpus", dateBasis: "notWindowed" },
  { population: "cloudSyncDeliveredSessions", dateBasis: "notWindowed" },
  { population: "cloudSyncInFlightSessions", dateBasis: "notWindowed" },
  { population: "settledImportSources", dateBasis: "notWindowed" },
  { population: "discoveredImportSources", dateBasis: "notWindowed" },
  { population: "maintenanceRebuildSessions", dateBasis: "notWindowed" },
] as const;

describe("ISS-10604: every population states which date column bounds it", () => {
  it.each(EXPECTED_DATE_BASIS)(
    "$population is windowed on $dateBasis",
    ({ population, dateBasis }) => {
      expect(
        SESSION_COUNT_POPULATION_SCOPE[population as SessionCountPopulation]
          .dateBasis
      ).toBe(dateBasis);
    }
  );

  it("answers for every registered population, so a new count cannot skip the axis", () => {
    const answered = new Set(
      EXPECTED_DATE_BASIS.map((row) => row.population as string)
    );
    for (const population of ALL_SESSION_COUNT_POPULATIONS) {
      expect(
        answered.has(population),
        `population "${population}" has no expected date basis in this fixture`
      ).toBe(true);
    }
    expect(answered.size).toBe(ALL_SESSION_COUNT_POPULATIONS.length);
  });

  it("gives a real column to exactly the windowed populations, and to no others", () => {
    // The invariant that stops the axis rotting into decoration: a count a date
    // range bounds MUST name the column, and a count no range bounds must not
    // claim one. Stated over the live records, so registering a new
    // `selectedWindow` population as `notWindowed` reddens here even though the
    // table above would have been updated to match it.
    for (const population of ALL_SESSION_COUNT_POPULATIONS) {
      const scope = SESSION_COUNT_POPULATION_SCOPE[population];
      const windowed = scope.time === "selectedWindow";
      expect(
        scope.dateBasis !== "notWindowed",
        `population "${population}" is time-scoped "${scope.time}" but its date basis is "${scope.dateBasis}"`
      ).toBe(windowed);
    }
  });

  it("registers one basis for every count it lists, and keeps both in the enum", () => {
    // This used to read "on both bases", because the list and the dashboard did
    // disagree while the alignment was default-off. They do not any more, and
    // the two assertions below are deliberately NOT the same claim: the first is
    // what the product SHIPS, the second is what the vocabulary can EXPRESS. An
    // enum narrowed to the shipped set would leave the next count added on
    // session start unable to say so, which is the hole ISS-10604 found.
    const registered = new Set<string>(
      ALL_SESSION_COUNT_POPULATIONS.map(
        (population) => SESSION_COUNT_POPULATION_SCOPE[population].dateBasis
      )
    );
    // Two, not three, since ISS-10541: every windowed count this registry lists
    // is on last activity, while `started` survives in the ENUM below for the
    // reads ISS-10604 left alone. Two of those (tokenops-waste, lost-work) do
    // render session counts on that basis and are simply unregistered — each on
    // its own page with no Sessions tile beside it — so the member is
    // load-bearing, which is why the two lists are asserted separately rather
    // than against each other.
    expect([...registered].sort()).toEqual(["lastActivity", "notWindowed"]);
    expect(Object.values(SESSION_COUNT_DATE_BASIS).sort()).toEqual([
      "lastActivity",
      "notWindowed",
      "started",
    ]);
  });

  it("names the axes a live pair genuinely differs on, in disclosure order", () => {
    // The derivation has to keep WORKING, not merely keep existing. ISS-10541
    // left no two registered populations disagreeing on `dateBasis`, so this
    // states the property over the pair that DOES still differ — the org and
    // this-device spellings of one sentence — rather than over a synthetic
    // record. A synthetic flip was tried and dropped: it could only ever detect
    // `"dateBasis" ∈ SESSION_COUNT_SCOPE_AXES`, which the case above already
    // pins as a literal, and it cost the module a widened public API to say so.
    expect(
      differingScopeAxes(
        SESSION_COUNT_POPULATION.SessionsInWindowOrg,
        SESSION_COUNT_POPULATION.SessionsInWindowThisDevice
      )
    ).toEqual(["owner", "device"]);
  });
});
