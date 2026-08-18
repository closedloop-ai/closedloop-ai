// The `deriveFailedGroups` half of the stall cron's derivation suite, split out
// of `derive.test.ts` when the combined file crossed the 1,000-line ceiling
// (ISS-5386). The seam is the exported function under test: `derive.test.ts`
// covers `deriveStallSample` (age and depth), this file covers the failing-group
// verdict, and the two share only the fixtures module.
import type { MergeQueueState } from "@repo/github/merge-queue";
import { describe, expect, it } from "vitest";
import {
  deriveFailedGroups,
  deriveStallSample,
  FailedGroupsStatus,
} from "./derive";
import {
  ACTIONS_INTEGRATION_ID,
  ADVISORY_CHECK_NAME,
  checkRun,
  entry,
  IMPOSTOR_INTEGRATION_ID,
  MergeQueueEntryState,
  NOW,
  queueState,
  REQUIRED_CHECK_NAME,
  REQUIRED_CONTEXTS,
  REQUIRED_STATUS_NAME,
  statusContext,
  VERCEL_INTEGRATION_ID,
} from "./merge-queue-entry-fixtures";

const EMPTY_REQUIRED_SET_REASON = /required-context set/;
const TRUNCATED_PAGE_REASON = /could not be fully read/;
const AMBIGUOUS_POSTER_REASON = /poster could not be established/;

function okGroups(state: MergeQueueState, required = REQUIRED_CONTEXTS) {
  const sample = deriveFailedGroups(state, required);
  if (sample.status !== FailedGroupsStatus.Ok) {
    throw new Error(`expected an Ok sample, got ${sample.reason}`);
  }
  return sample;
}

function unknownGroups(state: MergeQueueState, required = REQUIRED_CONTEXTS) {
  const sample = deriveFailedGroups(state, required);
  if (sample.status !== FailedGroupsStatus.Unknown) {
    throw new Error(
      `expected an Unknown sample, got ${sample.failedGroups} failing`
    );
  }
  return sample;
}

describe("deriveFailedGroups", () => {
  it("counts the 2026-08-04 incident shape: red required status, entry still AWAITING_CHECKS", () => {
    // The motivating case. GitHub had not evicted the group yet — it waits for
    // the remaining checks to resolve — so `state` still reads healthy while the
    // group is already dead and everything behind it is stalled.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          state: MergeQueueEntryState.AwaitingChecks,
          pullRequest: 4400,
          contexts: [
            checkRun(REQUIRED_CHECK_NAME, { conclusion: "SUCCESS" }),
            statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" }),
          ],
        }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    expect(sample.failing[0]).toMatchObject({
      pullRequest: 4400,
      contexts: [REQUIRED_STATUS_NAME],
    });
  });

  it("is reported alongside a YOUNG age, which is the churn case the age metric cannot see", () => {
    // The acceptance criterion: a group that fails, is evicted, re-forms and
    // fails again keeps resetting `committedDate`, so age stays low forever.
    // Both readings come off the same queue in the same tick.
    const state = queueState([
      entry({
        minutesOld: 5,
        contexts: [statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" })],
      }),
    ]);

    expect(deriveStallSample(state, NOW)).toMatchObject({ groupAgeMinutes: 5 });
    expect(okGroups(state).failedGroups).toBe(1);
  });

  it("ignores a failing context that is not required", () => {
    // `deploy-scripts` sat red on main for weeks under ISS-5136 without blocking
    // anything. Counting advisory failures would pin the gauge above zero and
    // the monitor would be muted within a day.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(ADVISORY_CHECK_NAME, { conclusion: "FAILURE" }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("ignores an UNMERGEABLE entry that has no group built", () => {
    // Merge-conflicted PRs sit UNMERGEABLE with a null headCommit indefinitely —
    // two of seven live entries on a healthy queue. Counting them would make the
    // gauge permanently non-zero.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: null,
            state: MergeQueueEntryState.Unmergeable,
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("does not count an UNMERGEABLE entry even when it HAS a group built", () => {
    // ISS-5833. This asserted the opposite until 105 of 116 non-zero production
    // ticks turned out to be exactly this shape — an `UNMERGEABLE` entry with no
    // failing context at all. `UNMERGEABLE` is what the queue shows while it
    // re-evaluates an entry against a base that is still moving. Nothing here
    // has reported red, so nothing here is red.
    expect(
      okGroups(
        queueState([
          entry({ minutesOld: 5, state: MergeQueueEntryState.Unmergeable }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("still counts an UNMERGEABLE group that DOES carry a red required context", () => {
    // The state is ignored, not treated as exonerating. Production warn lines
    // show this combination really occurs, so dropping the state branch must not
    // turn into a blanket amnesty for anything labelled UNMERGEABLE — the group
    // is judged on its contexts exactly like every other entry.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          pullRequest: 4395,
          state: MergeQueueEntryState.Unmergeable,
          contexts: [checkRun(REQUIRED_CHECK_NAME, { conclusion: "FAILURE" })],
        }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    expect(sample.failing[0].contexts).toEqual([REQUIRED_CHECK_NAME]);
  });

  it("counts the real failure and NOT the transient UNMERGEABLE beside it", () => {
    // The mixed-signal case, and the one that stops this from being satisfied by
    // suppressing everything: a genuine terminal required failure sits in the
    // same queue as an entry the queue is merely re-evaluating against a moving
    // base. Exactly one of them is a verdict.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          pullRequest: 4545,
          contexts: [checkRun(REQUIRED_CHECK_NAME, { conclusion: "FAILURE" })],
        }),
        entry({
          minutesOld: 3,
          pullRequest: 4540,
          state: MergeQueueEntryState.Unmergeable,
          contexts: [checkRun(REQUIRED_CHECK_NAME, { conclusion: "SUCCESS" })],
        }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    expect(sample.failing.map((group) => group.pullRequest)).toEqual([4545]);
  });

  it("does not count a required check that is still running or already green", () => {
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, { conclusion: null }),
              statusContext(REQUIRED_STATUS_NAME, { state: "PENDING" }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("does not count a failing check posted under a required name by the WRONG integration", () => {
    // A required context is `{name, integration}`. Anyone can name a check
    // `typecheck`; only the one from the required integration blocks the merge.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "FAILURE",
                integrationId: IMPOSTOR_INTEGRATION_ID,
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("does not count a HUMAN-posted status under a required context name", () => {
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                creator: "User",
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("lets a newer SUCCESS retire an older FAILURE for the same context", () => {
    // The rollup keeps every ATTEMPT. Testing for failure before collapsing to
    // the live attempt would keep the gauge red after a re-run had already fixed
    // the group.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "FAILURE",
                completedMinutesAgo: 30,
              }),
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "SUCCESS",
                completedMinutesAgo: 2,
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("lets a newer FAILURE override an older SUCCESS, so the rule is newest-wins and not prefer-success", () => {
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "SUCCESS",
                completedMinutesAgo: 30,
              }),
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "FAILURE",
                completedMinutesAgo: 2,
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(1);
  });

  it("does not depend on the order contexts arrive in", () => {
    const attempts = [
      checkRun(REQUIRED_CHECK_NAME, {
        conclusion: "FAILURE",
        completedMinutesAgo: 30,
      }),
      checkRun(REQUIRED_CHECK_NAME, {
        conclusion: "SUCCESS",
        completedMinutesAgo: 2,
      }),
    ];
    const build = (contexts: typeof attempts) =>
      okGroups(queueState([entry({ minutesOld: 5, contexts })])).failedGroups;

    expect(build([...attempts].reverse())).toBe(build(attempts));
  });

  it("reports UNKNOWN rather than zero when the required set is empty", () => {
    // With nothing to intersect against every group reads clean. That is an
    // absence of evidence, and publishing it as 0 is the false-healthy this
    // signal exists to avoid.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" }),
            ],
          }),
        ]),
        []
      ).reason
    ).toMatch(EMPTY_REQUIRED_SET_REASON);
  });

  it("reports UNKNOWN when a clean group's context page was truncated", () => {
    // The failure could be on the page we never saw.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, { conclusion: "SUCCESS" }),
            ],
            contextsTotalCount: 150,
          }),
        ])
      ).reason
    ).toMatch(TRUNCATED_PAGE_REASON);
  });

  it("does NOT confirm a failure visible on a truncated page", () => {
    // Reversed deliberately. The rollup returns one node per re-run ATTEMPT, so
    // a cut page can hide the newer SUCCESS that already retired the FAILURE we
    // can see — truncation invents failures as readily as it hides them. The
    // group is unresolved, and with nothing else confirmed the gauge is omitted
    // rather than paging on a check that may already be green.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" }),
            ],
            contextsTotalCount: 150,
          }),
        ])
      ).reason
    ).toMatch(TRUNCATED_PAGE_REASON);
  });

  it("still publishes a confirmed failure when ANOTHER group is truncated", () => {
    // The suppression bug: one clean-but-truncated group used to force Unknown
    // for the whole tick, so a confirmed red group elsewhere went unreported at
    // exactly the moment the queue was wedged. Uncertainty is per group.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          pullRequest: 4400,
          contexts: [statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" })],
        }),
        entry({
          minutesOld: 3,
          pullRequest: 4401,
          contexts: [checkRun(REQUIRED_CHECK_NAME, { conclusion: "SUCCESS" })],
          contextsTotalCount: 150,
        }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    // Published as a LOWER BOUND, and the caller is told so.
    expect(sample.unresolved).toBe(1);
    expect(sample.failing[0].pullRequest).toBe(4400);
  });

  it("treats a truncated UNMERGEABLE group as unresolved, not as a failure", () => {
    // ISS-5833. The state no longer short-circuits the truncation test, so this
    // group is judged on its contexts like any other — and its page was cut, so
    // the honest answer is that it is not known, not that it is red.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            state: MergeQueueEntryState.Unmergeable,
            contexts: [],
            contextsTotalCount: 150,
          }),
        ])
      ).reason
    ).toMatch(TRUNCATED_PAGE_REASON);
  });

  it("treats a group with no rollup at all as not-yet-failing rather than unknown", () => {
    // A freshly formed group legitimately has no checks reported yet. That is a
    // real, complete reading of zero — not a truncated page.
    expect(
      okGroups(queueState([entry({ minutesOld: 1, withRollup: false })]))
        .failedGroups
    ).toBe(0);
  });

  it("counts each failing group once, however many of its required contexts are red", () => {
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          pullRequest: 4401,
          contexts: [
            checkRun(REQUIRED_CHECK_NAME, { conclusion: "TIMED_OUT" }),
            statusContext(REQUIRED_STATUS_NAME, { state: "ERROR" }),
          ],
        }),
        entry({ minutesOld: 3, pullRequest: 4402 }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    expect(sample.failing[0].contexts).toEqual([
      REQUIRED_CHECK_NAME,
      REQUIRED_STATUS_NAME,
    ]);
  });

  it("prefers the CheckRun when a CheckRun and a StatusContext share a name and a timestamp", () => {
    // Mirrors the tie-break in dedupeStatusCheckRollupCandidates rather than
    // leaving the winner to arrival order.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_CHECK_NAME, {
                state: "FAILURE",
                createdMinutesAgo: 10,
              }),
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "SUCCESS",
                completedMinutesAgo: 10,
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(0);
  });

  it("matches a required context whose integration differs per context", () => {
    // The Vercel status and the Actions check are required under DIFFERENT
    // integrations; a single global integration id would drop one of them.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" }),
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "SUCCESS",
                integrationId: VERCEL_INTEGRATION_ID,
              }),
            ],
          }),
        ])
      ).failing[0].contexts
    ).toEqual([REQUIRED_STATUS_NAME]);
  });

  it("never lets an UNDATED attempt displace a dated one, in either direction", () => {
    // A node can arrive with no timestamps at all. Sorting it as "newest" would
    // let it retire a real, dated result — clearing a genuine failure in one
    // direction and inventing one in the other — so it must sort OLDEST.
    const undatedSuccess = checkRun(REQUIRED_CHECK_NAME, {
      conclusion: "SUCCESS",
    });
    const undatedFailure = checkRun(REQUIRED_CHECK_NAME, {
      conclusion: "FAILURE",
    });
    const build = (contexts: (typeof undatedSuccess)[]) =>
      okGroups(queueState([entry({ minutesOld: 5, contexts })])).failedGroups;

    expect(
      build([
        checkRun(REQUIRED_CHECK_NAME, {
          conclusion: "FAILURE",
          completedMinutesAgo: 2,
        }),
        undatedSuccess,
      ])
    ).toBe(1);
    expect(
      build([
        checkRun(REQUIRED_CHECK_NAME, {
          conclusion: "SUCCESS",
          completedMinutesAgo: 2,
        }),
        undatedFailure,
      ])
    ).toBe(0);
  });

  it("does not let a CASE-VARIANT success retire a required failure", () => {
    // Inverted from the original assertion, which was wrong. Required-ness is
    // decided by `entry.context === node.name`, so `TYPECHECK` is NOT the
    // required `typecheck`; a lower-cased dedupe key let that unrelated
    // context's SUCCESS evict the required one's FAILURE. Same eviction bug as
    // the wrong-integration case, reached through case instead.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "FAILURE",
                completedMinutesAgo: 30,
              }),
              checkRun(REQUIRED_CHECK_NAME.toUpperCase(), {
                conclusion: "SUCCESS",
                completedMinutesAgo: 2,
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(1);
  });

  it("does not let a newer WRONG-INTEGRATION success retire a required failure", () => {
    // The headline defect: collapsing by name before applying required-ness let
    // an impostor attempt win the key and the group read clean. Both orderings
    // are asserted so the fix cannot pass by arrival-order accident.
    const real = checkRun(REQUIRED_CHECK_NAME, {
      conclusion: "FAILURE",
      completedMinutesAgo: 30,
    });
    const impostor = checkRun(REQUIRED_CHECK_NAME, {
      conclusion: "SUCCESS",
      completedMinutesAgo: 2,
      integrationId: IMPOSTOR_INTEGRATION_ID,
    });

    expect(
      okGroups(
        queueState([entry({ minutesOld: 5, contexts: [real, impostor] })])
      ).failedGroups
    ).toBe(1);
    expect(
      okGroups(
        queueState([entry({ minutesOld: 5, contexts: [impostor, real] })])
      ).failedGroups
    ).toBe(1);
  });

  it("does not let a newer HUMAN-posted success retire a required failure", () => {
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                createdMinutesAgo: 30,
              }),
              statusContext(REQUIRED_STATUS_NAME, {
                state: "SUCCESS",
                createdMinutesAgo: 2,
                creator: "User",
              }),
            ],
          }),
        ])
      ).failedGroups
    ).toBe(1);
  });

  it("matches a required context by NAME ALONE when the rule carries no integration id", () => {
    // GitHub documents integration_id as optional. Treating such a rule as
    // matching nothing would leave the required set non-empty while nothing
    // could satisfy it — a confident zero over a genuinely failing check.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "FAILURE",
                integrationId: IMPOSTOR_INTEGRATION_ID,
              }),
            ],
          }),
        ]),
        [{ context: REQUIRED_CHECK_NAME, integrationId: null }]
      ).failedGroups
    ).toBe(1);
  });

  it("treats an unreadable rollup node as missing information, not as clean", () => {
    // wongk and codex both: `.catch(null)` leaves a PLACEHOLDER in the array, so
    // totalCount still equals nodes.length and a length-based completeness check
    // sees no gap — the unreadable node is skipped and the group publishes 0.
    // The gap is measured against READABLE nodes for exactly that reason.
    // totalCount EQUALS the array length here, which is what GitHub actually
    // returns; the previous version of this test only passed because it set the
    // two deliberately unequal.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, { conclusion: "SUCCESS" }),
              null,
            ],
            contextsTotalCount: 2,
          }),
        ])
      ).reason
    ).toMatch(TRUNCATED_PAGE_REASON);
  });

  it("does not collapse two required rules sharing a name under different integrations", () => {
    // wongk and codex both: keying on the context name alone let a newer success
    // from one required app retire a failure from another required app of the
    // same name. The rules contract identifies a required context by
    // {context, integration_id}, so the collapse key must be that pair.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "FAILURE",
                completedMinutesAgo: 30,
                integrationId: ACTIONS_INTEGRATION_ID,
              }),
              checkRun(REQUIRED_CHECK_NAME, {
                conclusion: "SUCCESS",
                completedMinutesAgo: 2,
                integrationId: VERCEL_INTEGRATION_ID,
              }),
            ],
          }),
        ]),
        [
          {
            context: REQUIRED_CHECK_NAME,
            integrationId: ACTIONS_INTEGRATION_ID,
          },
          {
            context: REQUIRED_CHECK_NAME,
            integrationId: VERCEL_INTEGRATION_ID,
          },
        ]
      ).failedGroups
    ).toBe(1);
  });

  it("counts a HUMAN-posted status under an integration-less required rule", () => {
    // wongk and codex both: the Bot test stands in for the integration id a
    // StatusContext does not carry, so it may only apply where the rule NAMES an
    // integration. A name-only rule constrains nothing but the name, and
    // rejecting a user-posted status there dropped a real failure.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                creator: "User",
              }),
            ],
          }),
        ]),
        [{ context: REQUIRED_STATUS_NAME, integrationId: null }]
      ).failedGroups
    ).toBe(1);
  });

  it("publishes Unknown, not a lower bound of 1, when the required set is unreadable", () => {
    // ISS-5833. Every verdict is context-based now, so an unreadable required
    // set leaves NOTHING confirmable — including the UNMERGEABLE entry that used
    // to supply a bogus lower bound of 1 here. Unknown is the honest answer.
    expect(
      unknownGroups(
        queueState([
          entry({ minutesOld: 5, state: MergeQueueEntryState.Unmergeable }),
          entry({ minutesOld: 3, contexts: [] }),
        ]),
        []
      ).reason
    ).toMatch(EMPTY_REQUIRED_SET_REASON);
  });

  it("still reports a truthful 0 for an IDLE queue when the required set is empty", () => {
    // The reason the empty-required-set check lives INSIDE the loop instead of
    // being an early return. Uncertainty is per BUILT group, so a queue with
    // nothing built has nothing to be uncertain about and must publish 0, not
    // Unknown. Hoisting that check out of the loop passes every other test in
    // this file — this is the one that fails.
    const sample = okGroups(
      queueState([entry({ minutesOld: null }), entry({ minutesOld: null })]),
      []
    );

    expect(sample.failedGroups).toBe(0);
    expect(sample.unresolved).toBe(0);
  });

  it("records the queue state on a failing group, for the diagnostic warn line", () => {
    // `state` no longer decides anything, so this assertion is the only thing
    // keeping it on the payload the runbook sends on-call to read.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            state: MergeQueueEntryState.Unmergeable,
            contexts: [
              checkRun(REQUIRED_CHECK_NAME, { conclusion: "FAILURE" }),
            ],
          }),
        ])
      ).failing[0].state
    ).toBe(MergeQueueEntryState.Unmergeable);
  });

  it("tallies BUILT UNMERGEABLE groups without letting them touch the count", () => {
    // ISS-5833 removed the only trace these groups left behind. The tally is
    // what keeps the premise falsifiable in production, so it has to move for a
    // built UNMERGEABLE entry, ignore an unbuilt one, and never move the count.
    const sample = okGroups(
      queueState([
        entry({ minutesOld: 5, state: MergeQueueEntryState.Unmergeable }),
        entry({ minutesOld: 3, state: MergeQueueEntryState.Unmergeable }),
        entry({ minutesOld: null, state: MergeQueueEntryState.Unmergeable }),
        entry({ minutesOld: 4 }),
      ])
    );

    expect(sample.builtUnmergeable).toBe(2);
    expect(sample.failedGroups).toBe(0);
  });

  it("still reports the tally when the verdict is Unknown", () => {
    // The tally comes from queue state, which is fully read here — only the
    // CONTEXTS are unknown. Dropping it to null on this arm would discard a
    // number we hold, on exactly the tick that asks whether the ISS-5833
    // exclusion was justified. `null` has to mean genuinely unknown.
    const sample = unknownGroups(
      queueState([
        entry({
          minutesOld: 5,
          state: MergeQueueEntryState.Unmergeable,
          contexts: [],
          contextsTotalCount: 150,
        }),
        entry({ minutesOld: 3, state: MergeQueueEntryState.Unmergeable }),
        entry({ minutesOld: null, state: MergeQueueEntryState.Unmergeable }),
      ])
    );

    expect(sample.reason).toMatch(TRUNCATED_PAGE_REASON);
    expect(sample.builtUnmergeable).toBe(2);
  });

  it("still reports the tally when the required set is unreadable", () => {
    // The other route to Unknown, where not one group could be judged. The
    // population is just as known as it is above.
    expect(
      unknownGroups(
        queueState([
          entry({ minutesOld: 5, state: MergeQueueEntryState.Unmergeable }),
          entry({ minutesOld: 3 }),
        ]),
        []
      ).builtUnmergeable
    ).toBe(1);
  });

  it("treats a required status with NO creator as unresolved, not as clean", () => {
    // ISS-5386. `creator` is nullable in GitHub's schema, and the optional chain
    // in the Bot stand-in rendered a null one as "not a Bot" — so the status
    // stopped matching its required rule, was dropped before the failure test,
    // and a genuinely red required context published a confident 0. That was the
    // one path here where an oddity degraded toward healthy.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                creator: null,
              }),
            ],
          }),
        ])
      ).reason
    ).toMatch(AMBIGUOUS_POSTER_REASON);
  });

  it("does NOT let a creatorless SUCCESS retire a failure it may not own", () => {
    // Ambiguous in BOTH directions, exactly like a truncated page. If the status
    // IS the required integration's, its newer SUCCESS retires the older
    // FAILURE and the group is green; if it is not, the FAILURE stands. The
    // poster is what decides, and it cannot be read — so neither answer is
    // published.
    expect(
      unknownGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                createdMinutesAgo: 30,
              }),
              statusContext(REQUIRED_STATUS_NAME, {
                state: "SUCCESS",
                creator: null,
                createdMinutesAgo: 2,
              }),
            ],
          }),
        ])
      ).reason
    ).toMatch(AMBIGUOUS_POSTER_REASON);
  });

  it("still publishes a confirmed failure when ANOTHER group's poster is unreadable", () => {
    // Uncertainty is per group here too: an unreadable poster on one group must
    // not suppress a group elsewhere that is confirmed red.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          pullRequest: 4400,
          contexts: [statusContext(REQUIRED_STATUS_NAME, { state: "FAILURE" })],
        }),
        entry({
          minutesOld: 3,
          pullRequest: 4401,
          contexts: [
            statusContext(REQUIRED_STATUS_NAME, {
              state: "FAILURE",
              creator: null,
            }),
          ],
        }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    expect(sample.unresolved).toBe(1);
    expect(sample.failing[0].pullRequest).toBe(4400);
  });

  it("judges a creatorless status normally when its rule names no integration", () => {
    // The narrowing that keeps this from swallowing the queue. The Bot test is a
    // STAND-IN for an integration id, so it only bites where the rule actually
    // names one. A rule constraining nothing but the name is judged on the name,
    // and a missing creator costs it nothing — counting this group unresolved
    // would go dark on a failure the ruleset can fully identify.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                creator: null,
              }),
            ],
          }),
        ]),
        [{ context: REQUIRED_STATUS_NAME, integrationId: null }]
      ).failedGroups
    ).toBe(1);
  });

  it("still counts a failure on ANOTHER context when one poster is unreadable", () => {
    // The page is whole, so the red `typecheck` CheckRun is fully knowable — an
    // unreadable poster on a DIFFERENT required context cannot un-fail it. The
    // collapse is keyed on the RULE, so only a status satisfying that same rule
    // could have retired it. Condemning the whole group here would have reported
    // "no other group was confirmed failing" about a group that plainly was.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          pullRequest: 4410,
          contexts: [
            checkRun(REQUIRED_CHECK_NAME, { conclusion: "FAILURE" }),
            statusContext(REQUIRED_STATUS_NAME, {
              state: "SUCCESS",
              creator: null,
            }),
          ],
        }),
      ])
    );

    expect(sample.failedGroups).toBe(1);
    expect(sample.failing[0]).toMatchObject({
      pullRequest: 4410,
      contexts: [REQUIRED_CHECK_NAME],
    });
    expect(sample.unresolved).toBe(0);
  });

  it("judges a creatorless status when a same-named rule names no integration", () => {
    // Two required rules can share a context name under different integrations.
    // The poster-less status already satisfies the rule that names none, so the
    // group is judged rather than deferred — the ambiguity test has to ask the
    // same matcher the verdict does, not merely spot that SOME same-named rule
    // carries an integration id.
    expect(
      okGroups(
        queueState([
          entry({
            minutesOld: 5,
            contexts: [
              statusContext(REQUIRED_STATUS_NAME, {
                state: "FAILURE",
                creator: null,
              }),
            ],
          }),
        ]),
        [
          { context: REQUIRED_STATUS_NAME, integrationId: null },
          {
            context: REQUIRED_STATUS_NAME,
            integrationId: VERCEL_INTEGRATION_ID,
          },
        ]
      ).failedGroups
    ).toBe(1);
  });

  it("ignores a creatorless status under a NON-required context name", () => {
    // The other narrowing. An unrequired context cannot condemn a group however
    // it is posted, so it must not make one unresolved either.
    const sample = okGroups(
      queueState([
        entry({
          minutesOld: 5,
          contexts: [
            statusContext(ADVISORY_CHECK_NAME, {
              state: "FAILURE",
              creator: null,
            }),
          ],
        }),
      ])
    );

    expect(sample.failedGroups).toBe(0);
    expect(sample.unresolved).toBe(0);
  });
});
