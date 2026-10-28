import { describe, expect, it } from "vitest";
import {
  ALL_SESSION_COUNT_POPULATIONS,
  SESSION_COUNT_DEVICE_SCOPE,
  SESSION_COUNT_OWNER_SCOPE,
  SESSION_COUNT_POPULATION_SCOPE,
  SESSION_COUNT_WORKSPACE_SCOPE,
  type SessionCountPopulation,
} from "../session-count-population";

/** The device phrase this population must NOT be describing itself with. */
const oppositeDevicePhrase = (device: string) =>
  device === SESSION_COUNT_DEVICE_SCOPE.ThisDevice
    ? SESSION_COUNT_DEVICE_SCOPE_PHRASES[
        SESSION_COUNT_DEVICE_SCOPE.AllSyncedDevices
      ]
    : SESSION_COUNT_DEVICE_SCOPE_PHRASES[SESSION_COUNT_DEVICE_SCOPE.ThisDevice];

/** The owner phrase this population must NOT be describing itself with. */
const oppositeOwnerPhrase = (owner: string) =>
  owner === SESSION_COUNT_OWNER_SCOPE.CurrentUser
    ? SESSION_COUNT_OWNER_SCOPE_PHRASES[SESSION_COUNT_OWNER_SCOPE.Organization]
    : SESSION_COUNT_OWNER_SCOPE_PHRASES[SESSION_COUNT_OWNER_SCOPE.CurrentUser];

/**
 * The workspace phrase this population must NOT be describing itself with.
 *
 * The third 2-value axis, which had no opposite check while device and owner
 * did (tamsinb review). Load-bearing in its own right, and MORE so than its
 * two siblings: every population registered today is `AllWorkspaces`, so the
 * positive check alone is satisfied by a composer that emits the whole phrase
 * map for this axis and never reads the scope record at all.
 */
const oppositeWorkspacePhrase = (workspace: string) =>
  workspace === SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces
    ? SESSION_COUNT_WORKSPACE_SCOPE_PHRASES[
        SESSION_COUNT_WORKSPACE_SCOPE.CurrentWorkspace
      ]
    : SESSION_COUNT_WORKSPACE_SCOPE_PHRASES[
        SESSION_COUNT_WORKSPACE_SCOPE.AllWorkspaces
      ];

import {
  describeSessionCountPopulation,
  describeSessionCountScope,
  SESSION_COUNT_DATE_BASIS_PHRASES,
  SESSION_COUNT_DEVICE_SCOPE_PHRASES,
  SESSION_COUNT_OWNER_SCOPE_PHRASES,
  SESSION_COUNT_POPULATION_LABELS,
  SESSION_COUNT_TIME_SCOPE_PHRASES,
  SESSION_COUNT_WORKSPACE_SCOPE_PHRASES,
} from "../session-count-population-display";

/**
 * The population set, written out by hand rather than derived from the module
 * under test. This is the same independent-witness pattern as the desktop Labs
 * key ledger: without it, DELETING a population would shrink every check below
 * and leave the suite green, because each one iterates whatever the map happens
 * to contain. Literal strings are deliberate here for that reason — a const
 * reference would import the very thing being witnessed.
 */
const EXPECTED_POPULATIONS = [
  "sessionsInWindowOrg",
  "sessionsInWindowThisDevice",
  "localSessionCorpus",
  "cloudSyncDeliveredSessions",
  "cloudSyncInFlightSessions",
  "settledImportSources",
  "discoveredImportSources",
  "maintenanceRebuildSessions",
] as const;

describe("session count population registry", () => {
  it("carries exactly the populations the product renders", () => {
    expect([...ALL_SESSION_COUNT_POPULATIONS].sort()).toEqual(
      [...EXPECTED_POPULATIONS].sort()
    );
  });

  it("gives every population a label and a scope record", () => {
    for (const population of EXPECTED_POPULATIONS) {
      const typed = population as SessionCountPopulation;
      expect(SESSION_COUNT_POPULATION_LABELS[typed]).toBeTruthy();
      expect(SESSION_COUNT_POPULATION_SCOPE[typed]).toBeDefined();
    }
  });
});

describe("ISS-8474 AC-1: every count names its population and its scope", () => {
  it("discloses the device, workspace and time scope of every population", () => {
    for (const population of EXPECTED_POPULATIONS) {
      const typed = population as SessionCountPopulation;
      const scope = SESSION_COUNT_POPULATION_SCOPE[typed];
      const disclosure = describeSessionCountScope(typed);

      // Asserts the MAPPING, not the shape. The phrase for the scope this
      // population actually has must be present, and the phrase for the scope
      // it does NOT have must be absent — which is what makes inverting a
      // phrase map redden. Shape-only assertions (four parts, truthy enum
      // fields) survive a swap of two phrases within one axis, and every count
      // would then disclose the wrong device.
      expect(disclosure).toContain(
        SESSION_COUNT_DEVICE_SCOPE_PHRASES[scope.device]
      );
      expect(disclosure).toContain(
        SESSION_COUNT_WORKSPACE_SCOPE_PHRASES[scope.workspace]
      );
      expect(disclosure).toContain(
        SESSION_COUNT_TIME_SCOPE_PHRASES[scope.time]
      );
      expect(disclosure).toContain(
        SESSION_COUNT_OWNER_SCOPE_PHRASES[scope.owner]
      );
      // ISS-10604. The empty `notWindowed` phrase makes `toContain` vacuous, so
      // the basis is asserted through its two real values instead: the one this
      // population has must be present, the one it does not must be absent, and
      // an unwindowed count must carry neither.
      expect(disclosure).toContain(
        SESSION_COUNT_DATE_BASIS_PHRASES[scope.dateBasis]
      );
      for (const basis of ["lastActivity", "started"] as const) {
        const expected = basis === scope.dateBasis;
        expect(
          disclosure.includes(SESSION_COUNT_DATE_BASIS_PHRASES[basis]),
          `${population} discloses "${SESSION_COUNT_DATE_BASIS_PHRASES[basis]}" but its date basis is "${scope.dateBasis}"`
        ).toBe(expected);
      }
      expect(disclosure).not.toContain(oppositeDevicePhrase(scope.device));
      expect(disclosure).not.toContain(oppositeOwnerPhrase(scope.owner));
      expect(disclosure).not.toContain(
        oppositeWorkspacePhrase(scope.workspace)
      );
    }
  });

  it("keeps every scope phrase distinct, within its axis and across all axes", () => {
    // What IS detectable without pinning prose: a phrase collapsed onto its
    // sibling ("on this Mac" for both device values), an empty phrase, or one
    // word doing duty on two axes. Each would make two different scopes read
    // the same, which is AC-2 failing inside the phrase maps.
    const everyPhrase = [
      ...Object.values(SESSION_COUNT_OWNER_SCOPE_PHRASES),
      ...Object.values(SESSION_COUNT_DEVICE_SCOPE_PHRASES),
      ...Object.values(SESSION_COUNT_WORKSPACE_SCOPE_PHRASES),
      ...Object.values(SESSION_COUNT_TIME_SCOPE_PHRASES),
      // ISS-10604: the `notWindowed` phrase is deliberately empty — an
      // unwindowed count has no column to name — and `describeSessionCountScope`
      // drops empty clauses. It is excluded here rather than exempted inside the
      // loop so the other two basis phrases still owe the same non-empty,
      // distinct-across-axes guarantee as every phrase before them.
      ...Object.entries(SESSION_COUNT_DATE_BASIS_PHRASES)
        .filter(([basis]) => basis !== "notWindowed")
        .map(([, phrase]) => phrase),
    ];
    for (const phrase of everyPhrase) {
      expect(phrase.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(everyPhrase).size).toBe(everyPhrase.length);
    expect(SESSION_COUNT_DATE_BASIS_PHRASES.notWindowed).toBe("");
  });

  /*
   * WHAT THIS FILE DELIBERATELY CANNOT CATCH, stated rather than left as a
   * silent hole: swapping two phrases WITHIN one axis — giving `ThisDevice` the
   * all-devices wording and vice versa. Every count then discloses the wrong
   * device and this suite stays green, because every assertion here reads the
   * phrase through the same map the mutation edited. Detecting it requires
   * pinning the English, and the English is the operator's call — a test that
   * pinned it would turn a rewording into a red suite, which is the failure
   * mode this file is shaped to avoid. The control for a permutation is the
   * wording review, not this file.
   *
   * This holds on the 2-VALUE axes too, not only on 3-value `time` (tamsinb
   * review asked whether the opposite check closed it for the 2-value ones; it
   * does not). `oppositeDevicePhrase` reads the SAME map the swap edited, so
   * after a swap the positive and negative assertions move together and both
   * still pass — verified by running exactly that mutation. What the opposite
   * checks DO catch is a composer that emits BOTH phrases of an axis, or reads
   * the wrong scope field, which the positive assertion alone admits. That is
   * why all three 2-value axes now carry one.
   */

  it("derives the disclosure from the scope record, so it cannot describe a scope the count lacks", () => {
    // Two populations differing on exactly one axis must produce disclosures
    // differing on exactly one axis-phrase. A hand-written disclosure would not
    // hold this property.
    const org = describeSessionCountScope(
      "sessionsInWindowOrg" as SessionCountPopulation
    ).split(", ");
    const local = describeSessionCountScope(
      "localSessionCorpus" as SessionCountPopulation
    ).split(", ");
    const shared = org.filter((phrase, index) => phrase === local[index]);
    expect(shared.length).toBeLessThan(org.length);
  });
});

describe("ISS-8474 AC-2: no two populations share an indistinguishable label", () => {
  it("renders a distinct full disclosure for every population", () => {
    const seen = new Map<string, SessionCountPopulation>();
    for (const population of EXPECTED_POPULATIONS) {
      const typed = population as SessionCountPopulation;
      const rendered = describeSessionCountPopulation(typed);
      const collidedWith = seen.get(rendered);
      expect(
        collidedWith,
        `${population} renders the same disclosure as ${collidedWith}: "${rendered}"`
      ).toBeUndefined();
      seen.set(rendered, typed);
    }
    expect(seen.size).toBe(EXPECTED_POPULATIONS.length);
  });

  it("never gives two populations of DIFFERENT units the same bare label", () => {
    // The stricter half. A scope suffix can be truncated, tooltipped away, or
    // read past; the noun beside the number is what survives. A session count
    // and a transcript count sharing that noun is the ISS-5281 conflation.
    const labelsByUnit = new Map<string, string>();
    for (const population of EXPECTED_POPULATIONS) {
      const typed = population as SessionCountPopulation;
      const label = SESSION_COUNT_POPULATION_LABELS[typed];
      const unit = SESSION_COUNT_POPULATION_SCOPE[typed].unit;
      const priorUnit = labelsByUnit.get(label);
      if (priorUnit !== undefined) {
        expect(
          priorUnit,
          `label "${label}" is used for both a ${priorUnit} count and a ${unit} count`
        ).toBe(unit);
      }
      labelsByUnit.set(label, unit);
    }
  });

  it("counts the import harness row in a different unit from a session count", () => {
    // ISS-5281's conflation, asserted rather than only described. One OpenCode
    // import source is a whole `opencode.db` holding an unbounded number of
    // sessions (`sourcePathsForWatchEvent` returns `[dbPath]`), so the harness
    // row's `1 / 1` and the Sessions list's `1` are not the same kind of thing
    // and never convert at a fixed rate (codex and whitlockk review).
    //
    // The unit is what the LABEL is chosen from, and the label is the operator's
    // to reword, so this pins the unit rather than the English: regressing
    // either harness population back onto the session unit reddens here, which
    // is what stops "Transcript files found" (or any per-file noun) returning
    // to a count that enumerates stores.
    const sessionUnit =
      SESSION_COUNT_POPULATION_SCOPE[
        "sessionsInWindowOrg" as SessionCountPopulation
      ].unit;
    for (const population of [
      "settledImportSources",
      "discoveredImportSources",
    ] as const) {
      const unit =
        SESSION_COUNT_POPULATION_SCOPE[population as SessionCountPopulation]
          .unit;
      expect(
        unit,
        `${population} must not be counted in the same unit as a session count`
      ).not.toBe(sessionUnit);
    }
  });

  it("detects a real collision between two DIFFERENT populations", () => {
    // Comparing a population to itself proves only that the function is pure.
    // This builds the collision the guard exists to catch: two distinct
    // populations whose scope records are already byte-identical
    // (LocalSessionCorpus and MaintenanceRebuildSessions) given one label, then
    // runs the same seen-Map logic and requires it to fire.
    const left = "localSessionCorpus" as SessionCountPopulation;
    const right = "maintenanceRebuildSessions" as SessionCountPopulation;
    expect(SESSION_COUNT_POPULATION_SCOPE[left]).toEqual(
      SESSION_COUNT_POPULATION_SCOPE[right]
    );
    const sharedLabel = SESSION_COUNT_POPULATION_LABELS[left];
    const collided = [left, right].map(
      (population) =>
        `${sharedLabel} (${describeSessionCountScope(population)})`
    );
    expect(new Set(collided).size).toBe(1);
    // ...and the real map must NOT be in that state.
    expect(
      new Set(
        EXPECTED_POPULATIONS.map((population) =>
          describeSessionCountPopulation(population as SessionCountPopulation)
        )
      ).size
    ).toBe(EXPECTED_POPULATIONS.length);
  });
});
