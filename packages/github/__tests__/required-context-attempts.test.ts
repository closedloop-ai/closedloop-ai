// ISS-6018 — the BRANCH-PROTECTION axis this module added on top of the
// matcher it inherited from the stall cron's derivation.
//
// The moved half (`requiredKey`, `liveAttempts`, `failed`, the ambiguity rules)
// keeps its coverage through the cron's own suites, which exercise it end to
// end. `RequiredAttemptState` is new here and nothing in those suites reads it,
// so without this file `SATISFYING_CHECK_CONCLUSIONS` — whose whole design note
// is "allow-list, never a denylist" — could be turned into a denylist, or lose
// `SKIPPED`, with this package's suite fully green.

import { describe, expect, it } from "vitest";
import {
  type RequiredContext,
  ROLLUP_CONTEXT_FIELDS,
  type RollupContextNode,
} from "../merge-queue.ts";
import {
  ambiguousPosterKeys,
  ambiguousStatusCandidates,
  type ContextAttempt,
  contextNameOf,
  isConfirmedFailure,
  isSkippedNode,
  liveAttempts,
  RequiredAttemptState,
  unreportedRequiredContexts,
} from "../required-context-attempts.ts";

/** SYNTHETIC. Production reads the real ids live from the branch ruleset. */
const ACTIONS_INTEGRATION_ID = 15_368;
const VERCEL_INTEGRATION_ID = 8329;

const CHECK_NAME = "typecheck";
const STATUS_NAME = "Vercel – app-stage";

const REQUIRED: RequiredContext[] = [
  { context: CHECK_NAME, integrationId: ACTIONS_INTEGRATION_ID },
  { context: STATUS_NAME, integrationId: VERCEL_INTEGRATION_ID },
];

function checkRun(conclusion: string | null): RollupContextNode {
  return {
    __typename: "CheckRun",
    name: CHECK_NAME,
    conclusion,
    completedAt: "2026-08-13T10:00:00Z",
    startedAt: null,
    checkSuite: { app: { databaseId: ACTIONS_INTEGRATION_ID } },
  };
}

function statusContext(state: string): RollupContextNode {
  return {
    __typename: "StatusContext",
    context: STATUS_NAME,
    state,
    createdAt: "2026-08-13T10:00:00Z",
    creator: { __typename: "Bot" },
  };
}

function stateOfCheckRun(conclusion: string | null): RequiredAttemptState {
  const attempt = liveAttempts([checkRun(conclusion)], REQUIRED).at(0);
  if (!attempt) {
    throw new Error(`no attempt matched for conclusion ${conclusion}`);
  }
  return attempt.state;
}

function stateOfStatusContext(state: string): RequiredAttemptState {
  const attempt = liveAttempts([statusContext(state)], REQUIRED).at(0);
  if (!attempt) {
    throw new Error(`no attempt matched for state ${state}`);
  }
  return attempt.state;
}

describe("RequiredAttemptState for a CheckRun", () => {
  it.each(["SUCCESS", "SKIPPED", "NEUTRAL"])(
    "treats %s as satisfying the required rule, as branch protection does",
    (conclusion) => {
      expect(stateOfCheckRun(conclusion)).toBe(RequiredAttemptState.Satisfied);
    }
  );

  it("treats a null conclusion as pending, not as satisfied", () => {
    expect(stateOfCheckRun(null)).toBe(RequiredAttemptState.Pending);
  });

  it.each(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "STALE"])(
    "treats the terminal failure %s as not satisfying",
    (conclusion) => {
      expect(stateOfCheckRun(conclusion)).toBe(
        RequiredAttemptState.NotSatisfied
      );
    }
  );

  it.each(["CANCELLED", "ACTION_REQUIRED"])(
    "treats %s as not satisfying even though it is not a queue-ejection failure",
    (conclusion) => {
      // Both are deliberately absent from TERMINAL_CHECK_CONCLUSIONS, which is
      // the EJECTION classification. Reading "not a terminal failure" as
      // "passed" is the false-green the allow-list exists to prevent.
      expect(stateOfCheckRun(conclusion)).toBe(
        RequiredAttemptState.NotSatisfied
      );
      expect(liveAttempts([checkRun(conclusion)], REQUIRED).at(0)?.failed).toBe(
        false
      );
    }
  );

  it("treats a conclusion GitHub has not shipped yet as not satisfying", () => {
    // The set is an allow-list precisely so a future enum member cannot arrive
    // and be read as green.
    expect(stateOfCheckRun("SOME_FUTURE_CONCLUSION")).toBe(
      RequiredAttemptState.NotSatisfied
    );
  });
});

describe("RequiredAttemptState for a StatusContext", () => {
  it("treats SUCCESS as satisfying", () => {
    expect(stateOfStatusContext("SUCCESS")).toBe(
      RequiredAttemptState.Satisfied
    );
  });

  it.each(["PENDING", "EXPECTED"])("treats %s as pending", (state) => {
    expect(stateOfStatusContext(state)).toBe(RequiredAttemptState.Pending);
  });

  it.each(["FAILURE", "ERROR"])("treats %s as not satisfying", (state) => {
    expect(stateOfStatusContext(state)).toBe(RequiredAttemptState.NotSatisfied);
  });
});

describe("attempt ordering for a re-run", () => {
  /** A completed attempt: the one a re-run supersedes. */
  function completedAttempt(
    conclusion: string,
    completedAt: string
  ): RollupContextNode {
    return {
      __typename: "CheckRun",
      name: CHECK_NAME,
      conclusion,
      completedAt,
      startedAt: completedAt,
      checkSuite: {
        createdAt: completedAt,
        app: { databaseId: ACTIONS_INTEGRATION_ID },
      },
    };
  }

  /**
   * A re-run GitHub has dispatched but not started: no `completedAt`, no
   * `startedAt`, and `CheckRun` carries no `createdAt` of its own — the suite's
   * is the only time it has.
   */
  function queuedAttempt(suiteCreatedAt: string | null): RollupContextNode {
    return {
      __typename: "CheckRun",
      name: CHECK_NAME,
      conclusion: null,
      completedAt: null,
      startedAt: null,
      checkSuite: {
        createdAt: suiteCreatedAt,
        app: { databaseId: ACTIONS_INTEGRATION_ID },
      },
    };
  }

  it("lets a queued re-run supersede the completed SUCCESS it re-ran", () => {
    // Without the suite's creation time the queued attempt sorts to -Infinity,
    // loses to the older SUCCESS, and the PR is reported ready while branch
    // protection is still waiting on the re-run.
    const attempt = liveAttempts(
      [
        completedAttempt("SUCCESS", "2026-08-13T10:00:00Z"),
        queuedAttempt("2026-08-13T11:00:00Z"),
      ],
      REQUIRED
    ).at(0);

    expect(attempt?.state).toBe(RequiredAttemptState.Pending);
  });

  it("keeps a later SUCCESS ahead of an older attempt that never scheduled", () => {
    // The inverse, and this module's own subject (ISS-6011): a run that never
    // scheduled is permanently timestamp-less too, and must NOT pin the context
    // pending forever. Ordering on dispatch time is what separates the two.
    const attempt = liveAttempts(
      [
        queuedAttempt("2026-08-13T09:00:00Z"),
        completedAttempt("SUCCESS", "2026-08-13T10:00:00Z"),
      ],
      REQUIRED
    ).at(0);

    expect(attempt?.state).toBe(RequiredAttemptState.Satisfied);
  });

  it("still orders a suite with no creation time last rather than throwing", () => {
    const attempt = liveAttempts(
      [
        completedAttempt("SUCCESS", "2026-08-13T10:00:00Z"),
        queuedAttempt(null),
      ],
      REQUIRED
    ).at(0);

    expect(attempt?.state).toBe(RequiredAttemptState.Satisfied);
  });
});

describe("the shared rollup selection", () => {
  it("asks for the check suite's creation time", () => {
    // The ordering fallback above is unreachable if the field is not selected,
    // and the schema tolerates it being absent — so nothing else would fail.
    expect(ROLLUP_CONTEXT_FIELDS).toContain("checkSuite { createdAt");
  });
});

describe("reading a context off either arm of the rollup union", () => {
  it("takes the name off a CheckRun and the context off a StatusContext", () => {
    // Deliberately different values: identical fixtures would let a swapped
    // ternary pass in one direction.
    expect(contextNameOf(checkRunNode({ name: SHARED_CONTEXT }))).toBe(
      SHARED_CONTEXT
    );
    expect(contextNameOf(statusContextNode({ context: STATUS_NAME }))).toBe(
      STATUS_NAME
    );
  });

  it("counts SKIPPED only on a CheckRun that concluded it", () => {
    expect(isSkippedNode(checkRunNode({ conclusion: "SKIPPED" }))).toBe(true);
    expect(isSkippedNode(checkRunNode({ conclusion: "SUCCESS" }))).toBe(false);
    // A StatusContext has no `conclusion` at all, so the typename test is what
    // keeps a field the node does not carry from being read off it.
    expect(isSkippedNode(statusContextNode({ state: "SUCCESS" }))).toBe(false);
  });
});

describe("matching an attempt to the required RULE", () => {
  it("drops a check run whose name is in no required rule", () => {
    expect(
      liveAttempts(
        [checkRunNode({ name: "lint", conclusion: "FAILURE" })],
        REQUIRED
      )
    ).toEqual([]);
  });

  it("drops a same-named check run posted under a different integration", () => {
    // The impostor case the module header names: matching on the name alone
    // would let this red stand in for the required rule that never reported.
    expect(
      liveAttempts(
        [
          checkRunNode({
            conclusion: "FAILURE",
            integrationId: VERCEL_INTEGRATION_ID,
          }),
        ],
        REQUIRED
      )
    ).toEqual([]);
  });

  it("drops a status posted by a readable human against an integration-scoped rule", () => {
    expect(
      liveAttempts(
        [
          statusContextNode({
            state: "FAILURE",
            creator: { __typename: HUMAN_ACTOR_TYPENAME },
          }),
        ],
        REQUIRED
      )
    ).toEqual([]);
  });

  it("keeps a name-only rule and an integration-scoped rule of the same name apart", () => {
    const required: RequiredContext[] = [
      { context: CHECK_NAME, integrationId: ACTIONS_INTEGRATION_ID },
      { context: CHECK_NAME, integrationId: null },
    ];

    const attempts = liveAttempts(
      [
        checkRunNode({ conclusion: "SUCCESS", completedAt: OLDER_TIMESTAMP }),
        checkRunNode({
          conclusion: "FAILURE",
          completedAt: NEWER_TIMESTAMP,
          integrationId: VERCEL_INTEGRATION_ID,
        }),
      ],
      required
    );

    expect(attempts.map((attempt) => attempt.requiredKey)).toEqual([
      `${CHECK_NAME}\u0000${ACTIONS_INTEGRATION_ID}`,
      `${CHECK_NAME}\u0000*`,
    ]);
    expect(attempts.map((attempt) => attempt.state)).toEqual([
      RequiredAttemptState.Satisfied,
      RequiredAttemptState.NotSatisfied,
    ]);
  });

  it("matches a check run carrying no integration id at all against a name-only rule", () => {
    const attempt = liveAttempts(
      [checkRunNode({ conclusion: "FAILURE", checkSuite: null })],
      NAME_ONLY_REQUIRED
    ).at(0);

    expect(attempt?.requiredKey).toBe(`${CHECK_NAME}\u0000*`);
    expect(attempt?.failed).toBe(true);
  });

  it("skips a node the boundary schema could not read, without shifting positions", () => {
    // Position is a tiebreaker in `beats`, so renumbering the survivors over a
    // hole would silently reorder a timestamp tie.
    const attempts = liveAttempts(
      [
        null,
        checkRunNode({ conclusion: "SUCCESS", completedAt: OLDER_TIMESTAMP }),
      ],
      REQUIRED
    );

    expect(attempts).toHaveLength(1);
    expect(attempts.at(0)?.position).toBe(1);
  });
});

describe("ordering two attempts on one rule", () => {
  it("sorts an unparseable timestamp oldest, so any dated attempt supersedes it", () => {
    expect(
      liveAttempts(
        [
          statusContextNode({
            state: "FAILURE",
            createdAt: UNPARSEABLE_TIMESTAMP,
          }),
        ],
        REQUIRED
      ).at(0)?.observedAtMs
    ).toBe(Number.NEGATIVE_INFINITY);

    const collapsed = liveAttempts(
      [
        statusContextNode({
          state: "FAILURE",
          createdAt: UNPARSEABLE_TIMESTAMP,
        }),
        statusContextNode({ state: "SUCCESS", createdAt: OLDER_TIMESTAMP }),
      ],
      REQUIRED
    );

    expect(collapsed.at(0)?.state).toBe(RequiredAttemptState.Satisfied);
  });

  it("lets a CheckRun outrank a StatusContext on a timestamp tie, in either rollup order", () => {
    const checkRunFirst = liveAttempts(
      [
        checkRunNode({
          name: SHARED_CONTEXT,
          conclusion: "FAILURE",
          completedAt: OLDER_TIMESTAMP,
        }),
        statusContextNode({
          context: SHARED_CONTEXT,
          state: "SUCCESS",
          createdAt: OLDER_TIMESTAMP,
        }),
      ],
      SHARED_REQUIRED
    );
    const statusFirst = liveAttempts(
      [
        statusContextNode({
          context: SHARED_CONTEXT,
          state: "SUCCESS",
          createdAt: OLDER_TIMESTAMP,
        }),
        checkRunNode({
          name: SHARED_CONTEXT,
          conclusion: "FAILURE",
          completedAt: OLDER_TIMESTAMP,
        }),
      ],
      SHARED_REQUIRED
    );

    expect(checkRunFirst).toHaveLength(1);
    expect(checkRunFirst.at(0)?.state).toBe(RequiredAttemptState.NotSatisfied);
    expect(statusFirst.at(0)?.state).toBe(RequiredAttemptState.NotSatisfied);
  });

  it("breaks a remaining tie on rollup position, so the later node wins", () => {
    const attempt = liveAttempts(
      [
        checkRunNode({ conclusion: "FAILURE", completedAt: OLDER_TIMESTAMP }),
        checkRunNode({ conclusion: "SUCCESS", completedAt: OLDER_TIMESTAMP }),
      ],
      REQUIRED
    ).at(0);

    expect(attempt?.position).toBe(1);
    expect(attempt?.state).toBe(RequiredAttemptState.Satisfied);
  });
});

describe("statuses whose poster GitHub did not name", () => {
  it("reports a creatorless status as the attempt a Bot poster would have contributed", () => {
    const candidates = ambiguousStatusCandidates(
      [
        statusContextNode({
          state: "FAILURE",
          createdAt: NEWER_TIMESTAMP,
          creator: null,
        }),
      ],
      REQUIRED
    );

    expect(candidates).toHaveLength(1);
    expect(candidates.at(0)?.requiredKey).toBe(STATUS_RULE_KEY);
    expect(candidates.at(0)?.failed).toBe(true);
    expect(candidates.at(0)?.observedAtMs).toBe(Date.parse(NEWER_TIMESTAMP));
  });

  it("considers nothing but a StatusContext whose creator is missing", () => {
    expect(
      ambiguousStatusCandidates(
        [
          null,
          checkRunNode({ conclusion: "FAILURE" }),
          statusContextNode({
            state: "FAILURE",
            creator: { __typename: HUMAN_ACTOR_TYPENAME },
          }),
          statusContextNode({ state: "FAILURE" }),
        ],
        REQUIRED
      )
    ).toEqual([]);
  });

  it("treats a creatorless status as unambiguous when its rule names no integration", () => {
    // A name-only rule constrains nothing but the context, so a readable Bot
    // poster could not have changed the answer.
    expect(
      ambiguousStatusCandidates(
        [
          statusContextNode({
            context: CHECK_NAME,
            state: "FAILURE",
            creator: null,
          }),
        ],
        NAME_ONLY_REQUIRED
      )
    ).toEqual([]);
  });
});

describe("narrowing the ambiguity to the rules it could flip", () => {
  it("defers a rule whose only attempt is a failing status with no readable poster", () => {
    expect([
      ...ambiguousPosterKeys(
        [statusContextNode({ state: "FAILURE", creator: null })],
        REQUIRED
      ),
    ]).toEqual([STATUS_RULE_KEY]);
  });

  it("does not defer a rule whose only attempt is a passing status with no readable poster", () => {
    // Both readable-poster worlds answer "not failing" (ISS-6399), so there is
    // no question left to defer.
    expect(
      ambiguousPosterKeys(
        [statusContextNode({ state: "SUCCESS", creator: null })],
        REQUIRED
      ).size
    ).toBe(0);
  });

  it("defers a rule when the unreadable poster is newer than the incumbent and disagrees", () => {
    expect([
      ...ambiguousPosterKeys(
        [
          statusContextNode({ state: "SUCCESS", createdAt: OLDER_TIMESTAMP }),
          statusContextNode({
            state: "FAILURE",
            createdAt: NEWER_TIMESTAMP,
            creator: null,
          }),
        ],
        REQUIRED
      ),
    ]).toEqual([STATUS_RULE_KEY]);
  });

  it("holds the readable verdict when the unreadable poster is older than the incumbent", () => {
    // An older attempt can never retire a newer one under `beats`, so this
    // creatorless red could not be the live attempt for its rule.
    expect(
      ambiguousPosterKeys(
        [
          statusContextNode({ state: "SUCCESS", createdAt: NEWER_TIMESTAMP }),
          statusContextNode({
            state: "FAILURE",
            createdAt: OLDER_TIMESTAMP,
            creator: null,
          }),
        ],
        REQUIRED
      ).size
    ).toBe(0);
  });

  it("holds the readable verdict when the unreadable poster would agree with it", () => {
    expect(
      ambiguousPosterKeys(
        [
          statusContextNode({ state: "FAILURE", createdAt: OLDER_TIMESTAMP }),
          statusContextNode({
            state: "FAILURE",
            createdAt: NEWER_TIMESTAMP,
            creator: null,
          }),
        ],
        REQUIRED
      ).size
    ).toBe(0);
  });
});

describe("confirming a failure against the deferred rules", () => {
  it("does not call a passing attempt a failure, whatever is deferred", () => {
    expect(
      isConfirmedFailure(
        contextAttempt({ requiredKey: CHECK_RULE_KEY }),
        new Set([CHECK_RULE_KEY])
      )
    ).toBe(false);
  });

  it("confirms a failure whose own rule is not the deferred one", () => {
    expect(
      isConfirmedFailure(
        failedAttempt({ requiredKey: CHECK_RULE_KEY }),
        new Set([STATUS_RULE_KEY])
      )
    ).toBe(true);
  });

  it("withholds a failure on the very rule an unreadable poster could have retired", () => {
    expect(
      isConfirmedFailure(
        failedAttempt({ requiredKey: CHECK_RULE_KEY }),
        new Set([CHECK_RULE_KEY])
      )
    ).toBe(false);
  });

  it("confirms a failing attempt that matched no required rule at all", () => {
    // pins current behavior; looks odd because `liveAttempts` can never hand
    // one over — the collapse drops an unmatched attempt before this point.
    expect(
      isConfirmedFailure(
        failedAttempt({ requiredKey: null }),
        new Set([CHECK_RULE_KEY, STATUS_RULE_KEY])
      )
    ).toBe(true);
  });

  it("keeps a confirmed red reported while another rule's poster is unreadable", () => {
    // The point of scoping the deferral to a rule (ISS-5386): the creatorless
    // status can only have retired its OWN rule's failure.
    const nodes = [
      checkRunNode({ conclusion: "FAILURE", completedAt: NEWER_TIMESTAMP }),
      statusContextNode({
        state: "FAILURE",
        createdAt: NEWER_TIMESTAMP,
        creator: null,
      }),
    ];
    const deferred = ambiguousPosterKeys(nodes, REQUIRED);

    expect(deferred.has(STATUS_RULE_KEY)).toBe(true);
    expect(
      liveAttempts(nodes, REQUIRED)
        .filter((attempt) => isConfirmedFailure(attempt, deferred))
        .map((attempt) => attempt.name)
    ).toEqual([CHECK_NAME]);
  });
});

describe("required rules with nothing reported against them", () => {
  it("names only the rule no attempt matched", () => {
    expect(
      unreportedRequiredContexts(
        [checkRunNode({ conclusion: "SUCCESS", completedAt: OLDER_TIMESTAMP })],
        REQUIRED
      )
    ).toEqual([STATUS_NAME]);
  });

  it("still reports a rule whose only same-named check run came from another integration", () => {
    expect(
      unreportedRequiredContexts(
        [
          checkRunNode({
            conclusion: "SUCCESS",
            completedAt: OLDER_TIMESTAMP,
            integrationId: VERCEL_INTEGRATION_ID,
          }),
        ],
        REQUIRED
      )
    ).toEqual([CHECK_NAME, STATUS_NAME]);
  });
});

/** A required rule spelled without an `integration_id`, matched by name alone. */
const NAME_ONLY_REQUIRED: RequiredContext[] = [
  { context: CHECK_NAME, integrationId: null },
];

/**
 * A context both arms of the rollup union can report, so one required rule can
 * collect a CheckRun and a StatusContext and force the source-priority tie.
 */
const SHARED_CONTEXT = "e2e-gate";
const SHARED_REQUIRED: RequiredContext[] = [
  { context: SHARED_CONTEXT, integrationId: null },
];

const CHECK_RULE_KEY = `${CHECK_NAME}\u0000${ACTIONS_INTEGRATION_ID}`;
const STATUS_RULE_KEY = `${STATUS_NAME}\u0000${VERCEL_INTEGRATION_ID}`;

const OLDER_TIMESTAMP = "2026-08-13T09:00:00Z";
const NEWER_TIMESTAMP = "2026-08-13T11:00:00Z";
/** `Date.parse` answers NaN here, which is a different hole from `null`. */
const UNPARSEABLE_TIMESTAMP = "whenever";

/** An `Actor.__typename` that is a readable poster but not an integration. */
const HUMAN_ACTOR_TYPENAME = "User";

type CheckRunNode = Extract<RollupContextNode, { __typename: "CheckRun" }>;

type CheckRunFields = {
  name: string;
  conclusion: string | null;
  completedAt: string | null;
  startedAt: string | null;
  checkSuite: CheckRunNode["checkSuite"];
  integrationId: number | null;
};

type StatusContextFields = {
  context: string;
  state: string;
  createdAt: string | null;
  creator: { __typename: string } | null;
};

function checkRunNode(
  overrides: Partial<CheckRunFields> = {}
): RollupContextNode {
  const fields: CheckRunFields = {
    name: CHECK_NAME,
    conclusion: null,
    completedAt: null,
    startedAt: null,
    checkSuite: { createdAt: null, app: { databaseId: null } },
    integrationId: ACTIONS_INTEGRATION_ID,
    ...overrides,
  };
  return {
    __typename: "CheckRun",
    name: fields.name,
    conclusion: fields.conclusion,
    completedAt: fields.completedAt,
    startedAt: fields.startedAt,
    checkSuite: fields.checkSuite
      ? {
          createdAt: fields.checkSuite.createdAt,
          app: { databaseId: fields.integrationId },
        }
      : null,
  };
}

function statusContextNode(
  overrides: Partial<StatusContextFields> = {}
): RollupContextNode {
  return {
    __typename: "StatusContext",
    context: STATUS_NAME,
    state: "SUCCESS",
    createdAt: OLDER_TIMESTAMP,
    creator: { __typename: "Bot" },
    ...overrides,
  };
}

/**
 * `isConfirmedFailure` takes a bare `ContextAttempt`, so its inputs are built
 * rather than derived: one shape it must answer for — a failing attempt that
 * matched no rule — is unreachable through `liveAttempts`.
 */
function contextAttempt(
  overrides: Partial<ContextAttempt> = {}
): ContextAttempt {
  return {
    name: CHECK_NAME,
    failed: false,
    state: RequiredAttemptState.Satisfied,
    requiredKey: CHECK_RULE_KEY,
    observedAtMs: Date.parse(OLDER_TIMESTAMP),
    sourcePriority: 0,
    position: 0,
    ...overrides,
  };
}

function failedAttempt(
  overrides: Partial<ContextAttempt> = {}
): ContextAttempt {
  return contextAttempt({
    failed: true,
    state: RequiredAttemptState.NotSatisfied,
    ...overrides,
  });
}
