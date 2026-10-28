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

  it.each([
    ["a non-object context", null],
    ["a context with no typename", {}],
    ["a non-string typename", { __typename: 7 }],
  ])("rejects %s before dispatching on its kind", (_label, input) => {
    expect(normalizeSelectedPullRequestCheckContext(input, 0)).toEqual({
      ok: false,
      reason: SelectedPullRequestChecksPartialReason.MalformedContext,
    });
  });

  it.each([
    ["a blank name", { ...makeCheckRun(), name: "   " }],
    [
      "a non-HTTP details url",
      { ...makeCheckRun(), detailsUrl: "ftp://ci.example/runs/1" },
    ],
    ["an unparseable timestamp", { ...makeCheckRun(), createdAt: "yesterday" }],
  ])("rejects a check run with %s", (_label, input) => {
    expect(normalizeSelectedPullRequestCheckContext(input, 0)).toEqual({
      ok: false,
      reason: SelectedPullRequestChecksPartialReason.MalformedContext,
    });
  });

  it.each([
    ["a blank context name", { ...makeStatusContext(), context: "   " }],
    [
      "an unparseable target url",
      { ...makeStatusContext(), targetUrl: "vercel.example/acme/widgets/1" },
    ],
  ])("rejects a status context with %s", (_label, input) => {
    expect(normalizeSelectedPullRequestCheckContext(input, 0)).toEqual({
      ok: false,
      reason: SelectedPullRequestChecksPartialReason.MalformedContext,
    });
  });

  it("rejects a completed check run whose conclusion has no category", () => {
    expect(
      normalizeSelectedPullRequestCheckContext(
        makeCheckRun({ conclusion: "MYSTERY" }),
        0
      )
    ).toEqual({
      ok: false,
      reason: SelectedPullRequestChecksPartialReason.UnknownOutcome,
    });
  });

  it("falls back to the check-run resource url when details url is absent", () => {
    const result = normalizeSelectedPullRequestCheckContext(
      { ...makeCheckRun(), detailsUrl: null },
      0
    );

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        check: {
          targetUrl: "https://api.github.com/repos/acme/widgets/check-runs/1",
        },
      },
    });
  });

  it("emits a null target url when a check run publishes neither url", () => {
    const result = normalizeSelectedPullRequestCheckContext(
      { ...makeCheckRun(), detailsUrl: null, url: null },
      0
    );

    expect(result).toMatchObject({
      ok: true,
      attempt: { check: { targetUrl: null } },
    });
  });

  it("nulls the optional app fields GitHub omitted", () => {
    const result = normalizeSelectedPullRequestCheckContext(
      {
        ...makeCheckRun(),
        checkSuite: { app: { id: "app-node", name: "CI" } },
      },
      0
    );

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        check: {
          sourceApp: {
            nodeId: "app-node",
            databaseId: null,
            slug: null,
            name: "CI",
            url: null,
          },
          sourceIdentity: `${SelectedPullRequestCheckSourceKind.CheckRun}:app-node:test`,
        },
        sourceIdentityIsAmbiguous: false,
      },
    });
  });

  it("marks an undated status context unknown in its synthetic provider id", () => {
    const result = normalizeSelectedPullRequestCheckContext(
      { ...makeStatusContext({ createdAt: null }), targetUrl: null },
      3
    );

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        check: {
          providerId: `${SelectedPullRequestCheckSourceKind.StatusContext}:deploy:unknown:SUCCESS`,
          createdAt: null,
          targetUrl: null,
        },
        observedAt: null,
        observedAtIsAmbiguous: true,
        position: 3,
      },
    });
  });

  it("prefers the later position when two attempts share an id and a time", () => {
    const first = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({ conclusion: "SUCCESS" }),
      0
    );
    const second = normalizeSelectedPullRequestCheckContext(
      makeCheckRun({ conclusion: "FAILURE" }),
      1
    );
    if (!(first.ok && second.ok)) {
      throw new Error("Expected valid attempts");
    }

    expect(
      selectLatestSelectedPullRequestChecks([first.attempt, second.attempt])
    ).toMatchObject({
      hasAmbiguousSource: true,
      checks: [
        {
          providerId: "check-node-1",
          category: SelectedPullRequestCheckCategory.Failing,
        },
      ],
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
