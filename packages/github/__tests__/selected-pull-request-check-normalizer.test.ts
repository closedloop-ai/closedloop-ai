import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksPartialReason,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { describe, expect, it } from "vitest";
import {
  normalizeSelectedPullRequestCheckContext,
  selectLatestSelectedPullRequestChecks,
} from "../selected-pull-request-check-normalizer";

describe("selected pull-request check normalizer", () => {
  it.each([
    ["QUEUED", null, SelectedPullRequestCheckCategory.Pending],
    ["IN_PROGRESS", null, SelectedPullRequestCheckCategory.Pending],
    ["WAITING", null, SelectedPullRequestCheckCategory.Pending],
    ["REQUESTED", null, SelectedPullRequestCheckCategory.Pending],
    ["PENDING", null, SelectedPullRequestCheckCategory.Pending],
    ["COMPLETED", "SUCCESS", SelectedPullRequestCheckCategory.Successful],
    ["COMPLETED", "CANCELLED", SelectedPullRequestCheckCategory.Neutral],
    ["COMPLETED", "NEUTRAL", SelectedPullRequestCheckCategory.Neutral],
    ["COMPLETED", "SKIPPED", SelectedPullRequestCheckCategory.Neutral],
    ["COMPLETED", "ACTION_REQUIRED", SelectedPullRequestCheckCategory.Failing],
    ["COMPLETED", "FAILURE", SelectedPullRequestCheckCategory.Failing],
    ["COMPLETED", "STALE", SelectedPullRequestCheckCategory.Failing],
    ["COMPLETED", "STARTUP_FAILURE", SelectedPullRequestCheckCategory.Failing],
    ["COMPLETED", "TIMED_OUT", SelectedPullRequestCheckCategory.Failing],
  ])("maps CheckRun %s/%s to %s", (status, conclusion, category) => {
    const result = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({ status, conclusion }),
      0
    );

    expect(result).toMatchObject({
      ok: true,
      attempt: { check: { category } },
    });
  });

  it.each([
    ["EXPECTED", SelectedPullRequestCheckCategory.Pending],
    ["PENDING", SelectedPullRequestCheckCategory.Pending],
    ["SUCCESS", SelectedPullRequestCheckCategory.Successful],
    ["ERROR", SelectedPullRequestCheckCategory.Failing],
    ["FAILURE", SelectedPullRequestCheckCategory.Failing],
  ])("maps StatusContext %s to %s", (state, category) => {
    const result = normalizeSelectedPullRequestCheckContext(
      makeStatusContext({ state }),
      0
    );

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        check: {
          category,
          sourceKind: SelectedPullRequestCheckSourceKind.StatusContext,
        },
      },
    });
  });

  it("preserves stable app identity and provider fields", () => {
    const result = normalizeSelectedPullRequestCheckContext(makeCheckRun(), 0);

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        check: {
          providerId: "check-node-1",
          sourceIdentity: "check_run:app-node:test",
          sourceApp: {
            nodeId: "app-node",
            databaseId: 7,
            slug: "ci",
            name: "CI",
          },
          providerStatus: "COMPLETED",
          providerConclusion: "SUCCESS",
        },
      },
    });
  });

  it.each([
    [
      makeCheckRun({ status: "FUTURE" }),
      SelectedPullRequestChecksPartialReason.UnknownOutcome,
    ],
    [
      makeCheckRun({ status: "COMPLETED", conclusion: null }),
      SelectedPullRequestChecksPartialReason.UnknownOutcome,
    ],
    [
      makeStatusContext({ state: "FUTURE" }),
      SelectedPullRequestChecksPartialReason.UnknownOutcome,
    ],
    [
      { __typename: "FutureContext" },
      SelectedPullRequestChecksPartialReason.MalformedContext,
    ],
  ])("rejects unknown or malformed outcomes", (input, reason) => {
    expect(normalizeSelectedPullRequestCheckContext(input, 0)).toEqual({
      ok: false,
      reason,
    });
  });

  it("selects the latest timestamped attempt per source", () => {
    const older = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({
        id: "older",
        conclusion: "FAILURE",
        createdAt: "2026-08-04T19:55:00Z",
        completedAt: "2026-08-04T20:00:00Z",
      }),
      0
    );
    const newer = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({
        id: "newer",
        conclusion: "SUCCESS",
        createdAt: "2026-08-04T20:01:00Z",
        completedAt: "2026-08-04T20:05:00Z",
      }),
      1
    );
    if (!(older.ok && newer.ok)) {
      throw new Error("Expected valid attempts");
    }

    const selection = selectLatestSelectedPullRequestChecks([
      newer.attempt,
      older.attempt,
    ]);

    expect(selection.hasAmbiguousSource).toBe(false);
    expect(selection.checks).toMatchObject([
      {
        providerId: "newer",
        category: SelectedPullRequestCheckCategory.Successful,
      },
    ]);
  });

  it("selects a newer queued rerun by its creation time", () => {
    const completed = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({
        id: "z-older-completed",
        conclusion: "SUCCESS",
        createdAt: "2026-08-04T19:59:00Z",
        startedAt: "2026-08-04T20:00:00Z",
        completedAt: "2026-08-04T20:15:00Z",
      }),
      0
    );
    const queued = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({
        id: "a-newer-queued",
        status: "QUEUED",
        conclusion: null,
        createdAt: "2026-08-04T20:10:00Z",
        startedAt: null,
        completedAt: null,
      }),
      1
    );
    if (!(completed.ok && queued.ok)) {
      throw new Error("Expected valid attempts");
    }

    expect(
      selectLatestSelectedPullRequestChecks([completed.attempt, queued.attempt])
    ).toMatchObject({
      hasAmbiguousSource: false,
      checks: [
        {
          providerId: "a-newer-queued",
          category: SelectedPullRequestCheckCategory.Pending,
          createdAt: "2026-08-04T20:10:00Z",
        },
      ],
    });
  });

  it("marks equal or missing attempt timestamps ambiguous", () => {
    const first = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({
        id: "a",
        createdAt: null,
        startedAt: null,
        completedAt: null,
      }),
      0
    );
    const second = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({
        id: "b",
        createdAt: null,
        startedAt: null,
        completedAt: null,
      }),
      1
    );
    if (!(first.ok && second.ok)) {
      throw new Error("Expected valid attempts");
    }

    expect(
      selectLatestSelectedPullRequestChecks([first.attempt, second.attempt])
    ).toMatchObject({
      hasAmbiguousSource: true,
      checks: [{ providerId: "b" }],
    });
  });

  it("keeps app-less runs distinct and marks their source identity ambiguous", () => {
    const first = normalizeSelectedPullRequestCheckContext(
      {
        ...makeCheckRun({
          id: "first",
          completedAt: "2026-08-04T20:00:00Z",
        }),
        checkSuite: { app: null },
      },
      0
    );
    const second = normalizeSelectedPullRequestCheckContext(
      {
        ...makeCheckRun({
          id: "second",
          completedAt: "2026-08-04T20:05:00Z",
        }),
        checkSuite: { app: null },
      },
      1
    );
    if (!(first.ok && second.ok)) {
      throw new Error("Expected valid attempts");
    }

    expect(
      selectLatestSelectedPullRequestChecks([first.attempt, second.attempt])
    ).toMatchObject({
      hasAmbiguousSource: true,
      checks: [{ providerId: "first" }, { providerId: "second" }],
    });
  });
});

function makeCheckRun(
  overrides: Partial<{
    id: string;
    status: string;
    conclusion: string | null;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }> = {}
) {
  return {
    __typename: "CheckRun",
    id: "check-node-1",
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    createdAt: "2026-08-04T19:58:00Z",
    startedAt: "2026-08-04T19:59:00Z",
    completedAt: "2026-08-04T20:00:00Z",
    detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
    url: "https://api.github.com/repos/acme/widgets/check-runs/1",
    checkSuite: {
      app: {
        id: "app-node",
        databaseId: 7,
        slug: "ci",
        name: "CI",
        url: "https://github.com/apps/ci",
      },
    },
    ...overrides,
  };
}

function makeStatusContext(
  overrides: Partial<{ state: string; createdAt: string | null }> = {}
) {
  return {
    __typename: "StatusContext",
    context: "deploy",
    state: "SUCCESS",
    createdAt: "2026-08-04T20:00:00Z",
    targetUrl: "https://vercel.com/acme/widgets/1",
    ...overrides,
  };
}
