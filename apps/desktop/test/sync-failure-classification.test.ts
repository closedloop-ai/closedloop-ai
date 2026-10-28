/**
 * @file sync-failure-classification.test.ts
 * @description Unit coverage for the shared classification module (ISS-8614,
 * PRD-699 §7.2): the resolution order, the hardwired unknown tail, the Appendix A
 * default table, and the status-deviation ledger's shrink-only budget.
 *
 * NOT the acceptance oracle. `sync-classification-standard-conformance.test.ts`
 * is — it drives each lane's REAL client with injected failures, so a lane naming
 * the right class in a table its dispatch never consults still fails there. This
 * file asks the narrower question that harness cannot: does the module itself
 * answer what the standard says, and is its debt ledger honest.
 *
 * The expected classes below are TRANSCRIBED from Appendix A, never derived from
 * the module under test. A table computed from the implementation stays green
 * when the implementation is emptied.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  SYNC_LANE_IDS,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  appendixADefaultFor,
  appendixAStatuses,
  COMPONENT_INVENTORY_ROUTE_PROFILE,
  chargesItemBudget,
  classifySyncFailure,
  INVOCATION_PARTS_ROUTE_PROFILE,
  type RouteProfile,
  SESSION_METADATA_ROUTE_PROFILE,
  STATUS_DEVIATION_BUDGET,
  SYNC_ROUTE_PROFILES,
  SyncFailureClass,
} from "../src/shared/sync-failure-classification.js";
import { StandardClass } from "./helpers/sync-classification-standard.js";

/** A ticket slug, which is what every ledger entry owes. */
const TICKET_SLUG = /^ISS-\d+$/;

/** Appendix A's default mapping, hand-transcribed. See the file header. */
const APPENDIX_A: readonly (readonly [number, SyncFailureClass])[] = [
  [400, SyncFailureClass.Item],
  [401, SyncFailureClass.Environmental],
  [403, SyncFailureClass.Environmental],
  [404, SyncFailureClass.Environmental],
  [408, SyncFailureClass.Environmental],
  [409, SyncFailureClass.Environmental],
  [410, SyncFailureClass.Environmental],
  [413, SyncFailureClass.Item],
  [422, SyncFailureClass.Item],
  [429, SyncFailureClass.Environmental],
  [500, SyncFailureClass.Environmental],
  [501, SyncFailureClass.ProtocolAbsent],
  [502, SyncFailureClass.Environmental],
  [503, SyncFailureClass.Environmental],
  [504, SyncFailureClass.Environmental],
];

/** A route with no policy of its own, so a case reads the default and nothing else. */
const BARE_PROFILE: RouteProfile = {
  lane: SyncLaneId.SessionMetadata,
  statusDeviations: new Map(),
};

test("every status Appendix A assigns is answered from its table, not the hardwired tail", () => {
  for (const [status, expected] of APPENDIX_A) {
    assert.equal(
      classifySyncFailure(BARE_PROFILE, status),
      expected,
      `HTTP ${status}: Appendix A assigns ${expected}`
    );
  }
  // The positive half: a status dropped from the record would still answer
  // ENVIRONMENTAL above (the tail catches it) and only the four non-environmental
  // rows would red. This pins the table's SIZE so a silent drop of 401 or 503 —
  // whose default equals the tail — cannot pass.
  assert.deepEqual(
    [...appendixAStatuses()].sort((a, b) => a - b),
    APPENDIX_A.map(([status]) => status).sort((a, b) => a - b)
  );
});

test("a status the standard never assigned is deferred, not guessed as the item's fault", () => {
  // ISS-9695: the tail must be reachable by OMISSION. A build that has never seen
  // a status must not charge an item for it.
  for (const status of [418, 425, 451, 599, 0, 999]) {
    assert.equal(
      classifySyncFailure(BARE_PROFILE, status),
      SyncFailureClass.Environmental,
      `HTTP ${status} is unmapped and must defer`
    );
  }
});

test("resolution order: a coded reason beats a status deviation, which beats the default", () => {
  const profile: RouteProfile = {
    lane: SyncLaneId.TranscriptArchive,
    codes: new Map([["stale_upload", SyncFailureClass.Item]]),
    statusDeviations: new Map([
      [
        409,
        {
          class: SyncFailureClass.ProtocolAbsent,
          because: "synthetic",
          resolvedBy: "ISS-1",
        },
      ],
    ]),
  };
  // Appendix A's default for 409 is ENVIRONMENTAL, the deviation says
  // PROTOCOL-ABSENT, the code says ITEM. Each rung must win over the one below
  // it, so all three answers differ — a case where two agreed would prove nothing.
  assert.equal(appendixADefaultFor(409), SyncFailureClass.Environmental);
  assert.equal(
    classifySyncFailure(profile, 409, "stale_upload"),
    SyncFailureClass.Item
  );
  assert.equal(
    classifySyncFailure(profile, 409),
    SyncFailureClass.ProtocolAbsent
  );
  assert.equal(
    classifySyncFailure(BARE_PROFILE, 409),
    SyncFailureClass.Environmental
  );
});

test("a code this build cannot map falls through to the status it arrived with", () => {
  // Appendix A's mixed-failure rule: a rolling deploy that starts sending a newer
  // vocabulary must not silently reclassify every status the build already
  // decides. 413 is ITEM by the table; an unknown code alongside it changes
  // nothing.
  const profile: RouteProfile = {
    lane: SyncLaneId.SessionMetadata,
    codes: new Map([["validation_failed", SyncFailureClass.Item]]),
    statusDeviations: new Map(),
  };
  assert.equal(
    classifySyncFailure(profile, 413, "quota_exhausted_v3"),
    SyncFailureClass.Item
  );
  assert.equal(
    classifySyncFailure(profile, 503, "quota_exhausted_v3"),
    SyncFailureClass.Environmental
  );
});

test("component profile: PRD-699 C1 drops 409 to the default and KEEPS 422 an item", () => {
  // The correction the ticket exists to get right. 409 is unreachable on this
  // route, so it earns no verdict; 422 is the route's primary validation
  // rejection, and deferring it would strand a permanently-invalid batch forever.
  assert.equal(
    classifySyncFailure(COMPONENT_INVENTORY_ROUTE_PROFILE, 409),
    SyncFailureClass.Environmental
  );
  assert.equal(
    classifySyncFailure(COMPONENT_INVENTORY_ROUTE_PROFILE, 422),
    SyncFailureClass.Item
  );
  assert.equal(
    classifySyncFailure(COMPONENT_INVENTORY_ROUTE_PROFILE, 413),
    SyncFailureClass.Item
  );
  // The one place this route departs from the standard: an UNCODED 400 is read
  // as version skew here, not the batch's fault. Since ISS-8609 that is the
  // compatibility residual rather than the whole rule — see the next test.
  assert.equal(
    classifySyncFailure(COMPONENT_INVENTORY_ROUTE_PROFILE, 400),
    SyncFailureClass.Environmental
  );
});

test("ISS-8609: the components route's CODES decide its 400, and a bare one keeps the old fold", () => {
  // The wire spellings below are hand-written literals, NOT read off
  // `DesktopComponentsSyncRestErrorCode`. A fixture that imports the const it
  // guards stays green through a rename — and a rename is a wire break for every
  // server/desktop pair that does not ship together. The duplication IS the test,
  // for the same reason the Appendix A table above is transcribed.
  //
  // Each coded row is chosen so the rung BELOW it answers differently, which is
  // what makes the assertion causal rather than coincidental: the skew code on a
  // 422, whose Appendix A default is ITEM; the content code on a 400, whose
  // ledger deviation is ENVIRONMENTAL. So neither `codes` entry can be deleted
  // and stay green.
  assert.equal(
    classifySyncFailure(
      COMPONENT_INVENTORY_ROUTE_PROFILE,
      400,
      "schema_version_unsupported"
    ),
    SyncFailureClass.Environmental
  );
  assert.equal(
    classifySyncFailure(
      COMPONENT_INVENTORY_ROUTE_PROFILE,
      422,
      "schema_version_unsupported"
    ),
    SyncFailureClass.Environmental,
    "the skew code outranks 422's ITEM default: an API deploy clears it, the batch is fine"
  );
  assert.equal(
    classifySyncFailure(
      COMPONENT_INVENTORY_ROUTE_PROFILE,
      400,
      "validation_failed"
    ),
    SyncFailureClass.Item,
    "a content-attributable 400 must reach the ITEM ladder, not the environmental defer"
  );

  // The cross-repo arm, and the normal case rather than the edge one: the
  // desktop is INSTALLED and the cloud deploys first, so a build that has not
  // been told about a code is routine. Both must land on today's fold, never on
  // the standard's ITEM default.
  assert.equal(
    classifySyncFailure(COMPONENT_INVENTORY_ROUTE_PROFILE, 400),
    SyncFailureClass.Environmental,
    "a bare 400 from a server predating ISS-8609 keeps deferring"
  );
  assert.equal(
    classifySyncFailure(
      COMPONENT_INVENTORY_ROUTE_PROFILE,
      400,
      "component_quota_exhausted_v9"
    ),
    SyncFailureClass.Environmental,
    "a code this build cannot map is no signal; the status still answers"
  );

  // The consequence of codes-first, pinned so it is a decision rather than a
  // discovery. `validation_failed` outranks ANY status it rides, so a coded 503
  // charges the item budget — which is right if the server means it (the payload
  // is at fault) and a latent hazard if it does not, because `validation_failed`
  // is SHARED by four write-lane routes. The route cannot emit this today: it
  // sends that code on the 422 alone, and `errorResponse` / `forbiddenResponse` /
  // `payloadTooLargeResponse` all send no code at all. The invariant that keeps it
  // that way is stated on the base const in
  // `packages/api/src/types/desktop-write-lane.ts`; this assertion is what makes
  // breaking it visible here rather than in a quarantined inventory.
  assert.equal(
    classifySyncFailure(
      COMPONENT_INVENTORY_ROUTE_PROFILE,
      503,
      "validation_failed"
    ),
    SyncFailureClass.Item,
    "codes beat statuses in both directions — see the invariant on the base const"
  );
});

test("invocation profile: a bare 404 is environmental and 501 protocol-absent, with no ledger entry", () => {
  assert.equal(
    classifySyncFailure(INVOCATION_PARTS_ROUTE_PROFILE, 404),
    SyncFailureClass.Environmental
  );
  assert.equal(
    classifySyncFailure(INVOCATION_PARTS_ROUTE_PROFILE, 501),
    SyncFailureClass.ProtocolAbsent
  );
  assert.equal(
    INVOCATION_PARTS_ROUTE_PROFILE.statusDeviations.size,
    0,
    "every status on this route takes Appendix A's default; an entry here is new debt"
  );
});

test("session metadata profile: pending-fragment 409 stays on the row ladder", () => {
  assert.equal(appendixADefaultFor(409), SyncFailureClass.Environmental);
  assert.equal(
    classifySyncFailure(SESSION_METADATA_ROUTE_PROFILE, 409),
    SyncFailureClass.Item
  );
});

test("session metadata profile: coded 403s keep recovery failures on the right gate", () => {
  assert.equal(
    classifySyncFailure(
      SESSION_METADATA_ROUTE_PROFILE,
      403,
      "feature_disabled"
    ),
    SyncFailureClass.Environmental,
    "capability-off is lane-wide: no parent-session recovery POST can pass"
  );
  assert.equal(
    classifySyncFailure(
      SESSION_METADATA_ROUTE_PROFILE,
      403,
      "target_not_owned"
    ),
    SyncFailureClass.Item,
    "ownership misses stay scoped to the stale target/comment instead of parking unrelated trace comments"
  );
  assert.equal(
    classifySyncFailure(SESSION_METADATA_ROUTE_PROFILE, 403),
    SyncFailureClass.Environmental,
    "an uncoded 403 has no wire reason and falls back to Appendix A"
  );
});

test("session metadata profile: bare 404 stays a lane-wide deploy-skew default", () => {
  assert.equal(appendixADefaultFor(404), SyncFailureClass.Environmental);
  assert.equal(
    classifySyncFailure(SESSION_METADATA_ROUTE_PROFILE, 404),
    SyncFailureClass.Environmental
  );
  assert.equal(
    SESSION_METADATA_ROUTE_PROFILE.statusDeviations.has(404),
    false,
    "the session route's bare 404 follows Appendix A"
  );
});

test("every ledger entry is live debt and names the ticket that codes it away", () => {
  for (const profile of SYNC_ROUTE_PROFILES) {
    assert.deepEqual(
      noOpDeviationStatuses(profile),
      [],
      `${profile.lane}: an entry recording the class the module already answers is not a deviation`
    );
    for (const [status, deviation] of profile.statusDeviations) {
      assert.match(
        deviation.resolvedBy,
        TICKET_SLUG,
        `${profile.lane} / ${status}: every status-keyed entry is DEBT and owes a resolving ticket`
      );
      assert.ok(
        deviation.because.length > 20,
        `${profile.lane} / ${status}: an entry must say why the route cannot answer the default`
      );
    }
  }
});

test("the liveness guard rejects a no-op entry the standard assigns no default", () => {
  // Comparing against `appendixADefaultFor` ALONE cannot decide this: it answers
  // null for a status Appendix A never assigned, so `notEqual(class, null)` held
  // for an entry that moves no verdict and still spent a shrink-only budget slot.
  // 451 is unassigned, so the module answers it from the ISS-9695 tail.
  assert.equal(appendixADefaultFor(451), null);
  assert.deepEqual(
    noOpDeviationStatuses(oneEntryLedger(451, SyncFailureClass.Environmental)),
    [451],
    "an entry answering the hardwired tail changes nothing and is not debt"
  );
  assert.deepEqual(
    noOpDeviationStatuses(oneEntryLedger(451, SyncFailureClass.Item)),
    [],
    "an entry that moves an unassigned status off the tail IS live debt"
  );
});

test("the conformance oracle's independent vocabulary still agrees with this module's", () => {
  // ISS-8614. `helpers/sync-classification-standard.ts` keeps its OWN copy of
  // Appendix A's three classes on purpose — it is the independent oracle the
  // profile-backed lanes are held to, and importing this module's spelling would
  // let one wrong definition move the lanes and their check together. This is
  // what makes that duplication safe rather than merely duplicated: a rename on
  // either side reds HERE, where the two are deliberately brought face to face,
  // instead of going green on both.
  assert.deepEqual(
    { ...StandardClass },
    { ...SyncFailureClass },
    "the oracle's transcribed vocabulary drifted from the module's"
  );
});

test("chargesItemBudget answers ITEM and only ITEM", () => {
  // The projection four lanes fold their two- and three-valued effects through.
  // Asserted per member rather than by shape so a class silently flipped sides
  // reds here, at the one definition, instead of at whichever lane noticed.
  assert.equal(chargesItemBudget(SyncFailureClass.Item), true);
  assert.equal(chargesItemBudget(SyncFailureClass.Environmental), false);
  assert.equal(chargesItemBudget(SyncFailureClass.ProtocolAbsent), false);
});

/**
 * Which burn-down lanes are profile-backed. Exhaustive, so a new lane fails
 * `tsc` until it answers.
 */
const LANE_HAS_ROUTE_PROFILE: Record<SyncLaneId, boolean> = {
  [SyncLaneId.SessionMetadata]: true,
  [SyncLaneId.InvocationParts]: true,
  [SyncLaneId.TranscriptArchive]: true,
  [SyncLaneId.ComponentInventory]: true,
};

test("every profile-backed lane in the burn-down contract ships exactly one route profile", () => {
  // ISS-8614's acceptance is every profile-backed burn-down lane, so a lane the
  // module forgot is the defect this catches.
  assert.deepEqual(
    [...SYNC_ROUTE_PROFILES.map((profile) => profile.lane)].sort(),
    SYNC_LANE_IDS.filter((lane) => LANE_HAS_ROUTE_PROFILE[lane]).sort(),
    "a lane with no profile answers from its own table, which is the defect ISS-8614 closes"
  );
});

test("the status-deviation ledger matches its shrink-only budget", () => {
  // §7.2's "refuse an uncoded new error class at review time", made mechanical.
  // Adding an entry reds this until the budget is raised deliberately; coding one
  // away reds it until the budget is lowered. Without it this module is the fifth
  // table with better documentation.
  const total = SYNC_ROUTE_PROFILES.reduce(
    (count, profile) => count + profile.statusDeviations.size,
    0
  );
  assert.equal(
    total,
    STATUS_DEVIATION_BUDGET,
    "the ledger changed size — raise the budget only for an entry that could not be coded, and LOWER it whenever one is deleted"
  );
});

/**
 * The class {@link classifySyncFailure} answers for `status` when no ledger entry
 * covers it: Appendix A's default where the standard assigns one, the hardwired
 * ENVIRONMENTAL tail where it does not. Transcribed, not asked of the module —
 * see the file header.
 */
function classWithoutDeviation(status: number): SyncFailureClass {
  return appendixADefaultFor(status) ?? SyncFailureClass.Environmental;
}

/** The ledger's entries that answer what the module already answers, so move no verdict. */
function noOpDeviationStatuses(profile: RouteProfile): number[] {
  return [...profile.statusDeviations]
    .filter(
      ([status, deviation]) => deviation.class === classWithoutDeviation(status)
    )
    .map(([status]) => status);
}

/** A synthetic one-entry ledger, so the guard above can be run against a case the real ledger must never hold. */
function oneEntryLedger(
  status: number,
  failureClass: SyncFailureClass
): RouteProfile {
  return {
    lane: SyncLaneId.SessionMetadata,
    statusDeviations: new Map([
      [
        status,
        {
          class: failureClass,
          because: "synthetic",
          resolvedBy: "ISS-1",
        },
      ],
    ]),
  };
}
