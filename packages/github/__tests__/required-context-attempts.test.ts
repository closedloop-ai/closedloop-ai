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
  liveAttempts,
  RequiredAttemptState,
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
  it.each([
    "SUCCESS",
    "SKIPPED",
    "NEUTRAL",
  ])("treats %s as satisfying the required rule, as branch protection does", (conclusion) => {
    expect(stateOfCheckRun(conclusion)).toBe(RequiredAttemptState.Satisfied);
  });

  it("treats a null conclusion as pending, not as satisfied", () => {
    expect(stateOfCheckRun(null)).toBe(RequiredAttemptState.Pending);
  });

  it.each([
    "FAILURE",
    "TIMED_OUT",
    "STARTUP_FAILURE",
    "STALE",
  ])("treats the terminal failure %s as not satisfying", (conclusion) => {
    expect(stateOfCheckRun(conclusion)).toBe(RequiredAttemptState.NotSatisfied);
  });

  it.each([
    "CANCELLED",
    "ACTION_REQUIRED",
  ])("treats %s as not satisfying even though it is not a queue-ejection failure", (conclusion) => {
    // Both are deliberately absent from TERMINAL_CHECK_CONCLUSIONS, which is
    // the EJECTION classification. Reading "not a terminal failure" as
    // "passed" is the false-green the allow-list exists to prevent.
    expect(stateOfCheckRun(conclusion)).toBe(RequiredAttemptState.NotSatisfied);
    expect(liveAttempts([checkRun(conclusion)], REQUIRED).at(0)?.failed).toBe(
      false
    );
  });

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
