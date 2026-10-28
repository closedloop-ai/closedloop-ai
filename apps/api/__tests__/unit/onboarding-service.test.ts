/**
 * Unit tests for onboardingService.getStatus.
 *
 * Verifies that the checklist does not include a ConnectLinear item and that
 * all six expected checklist items are returned with correct ids.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Partial, not total: `service.ts` reads the real `GitHubInstallationStatus`
// enum through `connectedGitHubInstallationWhere`, and a total mock omits it —
// every case in this file then dies on the import rather than its assertion.
// Restating the enum values here instead would reintroduce exactly the
// copy-drift that sharing the predicate removed.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // Minimal `Prisma.sql` tag stub (mirrors frustration-setting-service.test):
  // records the static SQL text and the interpolated values so the atomic-write
  // tests can assert the statement without a live database. Nested `Sql`
  // fragments are inlined the way the real tag flattens them.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const isFragment = (
        value: unknown
      ): value is { text: string; values: unknown[] } =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as { text?: unknown }).text === "string" &&
        Array.isArray((value as { values?: unknown }).values);

      let text = "";
      const flattened: unknown[] = [];
      strings.forEach((chunk, index) => {
        text += chunk;
        if (index >= values.length) {
          return;
        }
        const value = values[index];
        if (isFragment(value)) {
          text += value.text;
          flattened.push(...value.values);
          return;
        }
        text += "?";
        flattened.push(value);
      });
      return { text, values: flattened };
    },
  },
}));

const NOT_PERSISTED_PATTERN = /not persisted/;

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { withDb } from "@repo/database";
import type { RenderedSqlStatement } from "@/__tests__/support/organizations/render-settings-sql";
import {
  renderedWhereClause,
  renderSql,
} from "@/__tests__/support/organizations/render-settings-sql";
import {
  organizationSettingsWriteStatements,
  SETTINGS_WRITE_STATEMENT_COUNT,
} from "@/__tests__/support/organizations/settings-write-statements";
import { createModelDouble } from "@/__tests__/support/read-narrowing-projection.test-db";
import {
  ONBOARDING_SETTINGS_KEY,
  onboardingService,
} from "@/app/onboarding/service";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";

const mockWithDb = withDb as unknown as Mock;
/**
 * ISS-7142 moved the settings write onto `withDb.tx`, so the throw its row-count
 * guard raises actually rolls the statement back instead of reporting a write
 * that already committed. Only the transport moved — every assertion below still
 * pins the same statement shape.
 */
const mockWithDbTx = (withDb as unknown as { tx: Mock }).tx;

const ORG_ID = "org-1";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const LEGACY_ORG_DISMISSED_AT = "2026-02-03T04:05:06.789Z";

const callerFindFirst = vi.fn();
const gitHubUserConnectionFindUnique = vi.fn();

/**
 * Set up the nine sequential withDb calls that getStatus makes:
 *   1. organization.findUnique (org settings)
 *   2. team.count
 *   3. project.count
 *   4. computeTarget.findFirst (ISS-5490 — desktop install signal)
 *   5. gitHubInstallation.findFirst
 *   6. googleIntegration.findUnique
 *   7. user.count
 *   8. user.findFirst (ISS-5991 — the caller's own dismissal timestamp, org-scoped)
 *   9. onboardingAttempt.findFirst (ISS-10988 — the caller's own guided run)
 *
 * The mocks are positional, so a call added to the service's `Promise.all` has
 * to be added here at the same index or every later stub answers the wrong
 * query.
 */
function mockGetStatusCalls({
  org = { settings: {} },
  teamCount = 0,
  projectCount = 0,
  computeTarget = null,
  githubInstallation = null,
  githubUserConnection = null,
  googleIntegration = null,
  userCount = 1,
  caller = null,
}: {
  org?: { settings: object };
  teamCount?: number;
  projectCount?: number;
  computeTarget?: { id: string } | null;
  githubInstallation?: { id: string } | null;
  githubUserConnection?: { revokedAt: Date | null; scopes: string[] } | null;
  googleIntegration?: { id: string } | null;
  userCount?: number;
  caller?: { onboardingChecklistDismissedAt: Date | null } | null;
} = {}) {
  mockWithDb
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        organization: {
          findUnique: vi.fn().mockResolvedValue(org),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ team: { count: vi.fn().mockResolvedValue(teamCount) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ project: { count: vi.fn().mockResolvedValue(projectCount) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        computeTarget: {
          findFirst: vi.fn().mockResolvedValue(computeTarget),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        gitHubInstallation: {
          findFirst: vi.fn().mockResolvedValue(githubInstallation),
        },
      })
    )
    // `resolveGitHubDataConnectionStatus` with `hasActiveInstallation: false`
    // reads only the caller's own grant, so this double carries just that
    // delegate — a `gitHubInstallation` delegate here would go uncalled and
    // hide a regression that re-added the duplicate installation query.
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        gitHubUserConnection: {
          findUnique:
            gitHubUserConnectionFindUnique.mockResolvedValue(
              githubUserConnection
            ),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        googleIntegration: {
          findUnique: vi.fn().mockResolvedValue(googleIntegration),
        },
      })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ user: { count: vi.fn().mockResolvedValue(userCount) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ user: { findFirst: callerFindFirst.mockResolvedValue(caller) } })
    )
    .mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ onboardingAttempt: { findFirst: vi.fn().mockResolvedValue(null) } })
    );
}

describe("onboardingService.getStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not include a ConnectLinear item in the checklist", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const ids = status.checklist.map((item) => item.id);
    expect(ids).not.toContain("CONNECT_LINEAR");
  });

  // ISS-5490: DownloadDesktop sits between the project and GitHub rows, where
  // the wizard used to ask for it. The client hides it unless the wizard-trim
  // flag is on, so the service returning it unconditionally is what lets one
  // response serve both rollout states.
  it("returns exactly the six expected checklist items in order", async () => {
    mockGetStatusCalls();

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    expect(status.checklist).toHaveLength(6);
    expect(status.checklist.map((item) => item.id)).toEqual([
      ChecklistItemId.CreateTeam,
      ChecklistItemId.CreateProject,
      ChecklistItemId.DownloadDesktop,
      ChecklistItemId.ConnectGitHub,
      ChecklistItemId.ConnectGoogle,
      ChecklistItemId.InviteMembers,
    ]);
  });

  it("marks CreateTeam complete when teamCount is greater than zero", async () => {
    mockGetStatusCalls({ teamCount: 1 });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.CreateTeam
    );
    expect(item?.completed).toBe(true);
  });

  it("marks CreateTeam incomplete when teamCount is zero", async () => {
    mockGetStatusCalls({ teamCount: 0 });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.CreateTeam
    );
    expect(item?.completed).toBe(false);
  });

  it("marks ConnectGitHub complete when a GitHub installation exists", async () => {
    mockGetStatusCalls({ githubInstallation: { id: "install-1" } });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGitHub
    );
    expect(item?.completed).toBe(true);
  });

  it("marks ConnectGitHub incomplete when no GitHub installation exists", async () => {
    mockGetStatusCalls({ githubInstallation: null });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGitHub
    );
    expect(item?.completed).toBe(false);
  });

  it("marks ConnectGitHub complete on the caller's own grant with no installation", async () => {
    // ISS-11246. This row's only control is a Settings link to the personal
    // sign-in methods panel, which authorizes a PERSONAL grant and never the
    // org App install — so an installation-only answer left the row permanently
    // unticked for a reader who had already done what it asked. It now folds
    // through the same `isOnboardingGitHubConnected` the guided snapshot uses,
    // which is what keeps the two surfaces answering identically.
    mockGetStatusCalls({
      githubInstallation: null,
      githubUserConnection: { revokedAt: null, scopes: [GITHUB_REPO_SCOPE] },
    });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGitHub
    );
    expect(item?.completed).toBe(true);
    // Scoped to the CALLER, which is what stops one member's grant finishing
    // the row for the whole org.
    expect(gitHubUserConnectionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_userId: { organizationId: ORG_ID, userId: USER_ID },
        },
      })
    );
  });

  it("leaves ConnectGitHub incomplete on a revoked grant or one without repo scope", async () => {
    mockGetStatusCalls({
      githubInstallation: null,
      githubUserConnection: {
        revokedAt: new Date("2026-01-01T00:00:00.000Z"),
        scopes: [GITHUB_REPO_SCOPE],
      },
    });
    const revoked = await onboardingService.getStatus(ORG_ID, USER_ID);

    mockGetStatusCalls({
      githubInstallation: null,
      githubUserConnection: { revokedAt: null, scopes: ["read:user"] },
    });
    const insufficientScope = await onboardingService.getStatus(
      ORG_ID,
      USER_ID
    );

    expect(
      revoked.checklist.find((c) => c.id === ChecklistItemId.ConnectGitHub)
        ?.completed
    ).toBe(false);
    expect(
      insufficientScope.checklist.find(
        (c) => c.id === ChecklistItemId.ConnectGitHub
      )?.completed
    ).toBe(false);
  });

  it("marks ConnectGoogle complete when a Google integration exists", async () => {
    mockGetStatusCalls({ googleIntegration: { id: "google-1" } });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.ConnectGoogle
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InviteMembers complete when userCount is greater than one", async () => {
    mockGetStatusCalls({ userCount: 2 });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InviteMembers
    );
    expect(item?.completed).toBe(true);
  });

  it("marks InviteMembers incomplete when userCount is one", async () => {
    mockGetStatusCalls({ userCount: 1 });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    const item = status.checklist.find(
      (c) => c.id === ChecklistItemId.InviteMembers
    );
    expect(item?.completed).toBe(false);
  });
});

// ISS-5991: dismissal is the caller's, not the organization's.
describe("onboardingService checklist dismissal is per-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports dismissed for the user who has a dismissal timestamp", async () => {
    mockGetStatusCalls({
      caller: {
        onboardingChecklistDismissedAt: new Date("2026-02-03T04:05:06Z"),
      },
    });

    const status = await onboardingService.getStatus(ORG_ID, USER_ID);

    expect(status.checklistDismissed).toBe(true);
  });

  it("reports not dismissed for a member of an org whose legacy settings blob was dismissed", async () => {
    mockGetStatusCalls({
      org: {
        settings: {
          onboarding: { checklistDismissedAt: LEGACY_ORG_DISMISSED_AT },
        },
      },
      caller: { onboardingChecklistDismissedAt: null },
    });

    const status = await onboardingService.getStatus(ORG_ID, OTHER_USER_ID);

    expect(status.checklistDismissed).toBe(false);
  });

  it("writes the dismissal to the calling user and never to the organization", async () => {
    const userUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const organizationUpdate = vi.fn();
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({
        user: { updateMany: userUpdateMany },
        organization: { update: organizationUpdate },
      })
    );
    mockGetStatusCalls({
      caller: { onboardingChecklistDismissedAt: new Date() },
    });

    const status = await onboardingService.dismissChecklist(ORG_ID, USER_ID);

    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    expect(
      userUpdateMany.mock.calls[0]?.[0]?.data?.onboardingChecklistDismissedAt
    ).toBeInstanceOf(Date);
    expect(organizationUpdate).not.toHaveBeenCalled();
    expect(status.checklistDismissed).toBe(true);
  });

  // The tenant guard belongs in the query, not in the caller: a userId that does
  // not belong to organizationId must match no row.
  it("scopes both the dismissal write and the status read to the caller's organization", async () => {
    const userUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ user: { updateMany: userUpdateMany } })
    );
    mockGetStatusCalls({
      caller: { onboardingChecklistDismissedAt: new Date() },
    });

    await onboardingService.dismissChecklist(ORG_ID, USER_ID);

    expect(userUpdateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: USER_ID,
      organizationId: ORG_ID,
    });
    expect(callerFindFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: USER_ID,
      organizationId: ORG_ID,
    });
  });

  it("re-dismissing leaves the same dismissal state rather than a different one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    const userUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const dismiss = async () => {
      mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
        fn({ user: { updateMany: userUpdateMany } })
      );
      mockGetStatusCalls({
        caller: { onboardingChecklistDismissedAt: new Date() },
      });
      return await onboardingService.dismissChecklist(ORG_ID, USER_ID);
    };

    await dismiss();
    const second = await dismiss();

    const [first, repeat] = userUpdateMany.mock.calls.map(
      (call) => call[0]?.data?.onboardingChecklistDismissedAt
    );
    expect(repeat).toEqual(first);
    expect(second.checklistDismissed).toBe(true);
  });
});

/**
 * ISS-7092: `completeWizard`'s organization write is a SINGLE atomic statement.
 *
 * This block supersedes the ISS-7081 one, which asserted the `select` and the
 * returned columns of a Prisma `update` that this change deletes outright. That
 * ticket's contract — the settings write must not read or return a credential
 * column — is not weakened here, it is strengthened: the write now reads no
 * columns at all and returns none, and the first two cases assert exactly that
 * against the new shape. Its third case (the merged wizard state actually
 * persists) moved to the integration suite, where a real Postgres evaluates the
 * `jsonb_set` rather than a hand-written stub of it.
 *
 * The persistence and concurrency proofs deliberately do NOT live here: a mock
 * cannot execute `jsonb_set`, so a unit test asserting it would only be checking
 * a simulation of Postgres. See
 * `__tests__/integration/onboarding-complete-wizard-settings-race.integration.test.ts`.
 */
describe("onboardingService.completeWizard writes settings atomically", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockCompleteWizardCalls(rowsUpdated = 1) {
    const executeRaw = vi.fn((_statement: RenderedSqlStatement) =>
      Promise.resolve(rowsUpdated)
    );
    // Present so a regression back to read-modify-write is observable: the
    // atomic path must never read the settings blob first.
    const organization = createModelDouble([
      {
        id: ORG_ID,
        settings: {},
      },
    ]);
    mockWithDbTx.mockImplementationOnce((fn: (db: unknown) => unknown) =>
      fn({ $executeRaw: executeRaw, organization })
    );
    mockGetStatusCalls();
    return { executeRaw, organization };
  }

  it("runs the settings write inside a transaction, so the row-count guard can roll back", async () => {
    const { executeRaw } = mockCompleteWizardCalls();

    await onboardingService.completeWizard(ORG_ID, USER_ID);

    // ISS-7142, asserted on the TRANSPORT rather than the thrown message: the
    // shared writer's not-found string is byte-identical to the one this
    // service threw privately before that change, so a message assertion stays
    // green against a write that never enters a transaction — and the `> 1`
    // branch is a refusal only because the throw rolls the statement back.
    expect(mockWithDbTx).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledTimes(SETTINGS_WRITE_STATEMENT_COUNT);
  });

  it("patches in one statement, then re-stamps updated_at from behind the row lock", async () => {
    const { executeRaw, organization } = mockCompleteWizardCalls();

    await onboardingService.completeWizard(ORG_ID, USER_ID);

    expect(executeRaw).toHaveBeenCalledTimes(SETTINGS_WRITE_STATEMENT_COUNT);
    // ISS-7157: the second statement is the post-lock `updated_at` re-stamp.
    // Asserting its shape, not just the count, is what makes the count mean
    // something — a stray extra settings write would satisfy a bare `2`.
    const { settings, stamp } = organizationSettingsWriteStatements(
      executeRaw.mock.calls
    );
    expect(settings.text).toContain("jsonb_set");
    expect(renderSql(stamp)).toContain('"updated_at" = GREATEST("updated_at"');
    expect(stamp.values[0]).toBeInstanceOf(Date);
    expect(renderedWhereClause(stamp)).toBe(
      `"id" = ${JSON.stringify(ORG_ID)}::uuid`
    );
    // No read of the blob, so no credential column can be returned by the
    // write path, and no read-then-write window exists for a racing writer.
    expect(organization.findUnique).not.toHaveBeenCalled();
    expect(organization.update).not.toHaveBeenCalled();
  });

  it("patches only the onboarding key in place and returns no columns", async () => {
    const { executeRaw } = mockCompleteWizardCalls();

    await onboardingService.completeWizard(ORG_ID, USER_ID);

    const statement = executeRaw.mock.calls[0][0];
    expect(statement.text).toContain("jsonb_set");
    expect(statement.text).toContain('UPDATE "organizations"');
    expect(statement.values).toContain(ONBOARDING_SETTINGS_KEY);
    // ISS-7122: predicate text AND the bound id together, as the WHOLE clause.
    // This replaces a bare `values).toContain(ORG_ID)` — which only proved the
    // id reached the statement SOMEWHERE, and stayed green under every widening
    // of the predicate, including one that dropped the equality outright.
    expect(renderedWhereClause(statement)).toBe('"id" = "org-1"::uuid');
    expect(statement.text).not.toContain("RETURNING");
    // The patch target is the LIVE column, not a fresh object. Without this,
    // rewriting the `COALESCE("settings", …)` base as a bare `'{}'::jsonb`
    // wipes every sibling settings key and the rest of this block stays green
    // — the integration suite catches it, but that is a slower signal, and no
    // assertion here can observe what Postgres does with the statement.
    expect(statement.text).toContain('COALESCE("settings"');
  });

  it("binds the wizard fields as a jsonb patch rather than a whole-blob replacement", async () => {
    const { executeRaw } = mockCompleteWizardCalls();

    await onboardingService.completeWizard(
      ORG_ID,
      USER_ID,
      "team-9",
      "project-9"
    );

    const statement = executeRaw.mock.calls[0][0];
    const patch = statement.values.find(
      (value): value is string =>
        typeof value === "string" && value.startsWith("{")
    );
    expect(JSON.parse(patch ?? "{}")).toMatchObject({
      wizardCompletedBy: USER_ID,
      createdTeamId: "team-9",
      createdProjectId: "project-9",
    });
    // Merged into the existing object, not substituted for it.
    expect(statement.text).toContain("||");
  });

  it("throws rather than reporting a completion when no organization row matched", async () => {
    mockCompleteWizardCalls(0);

    await expect(
      onboardingService.completeWizard(ORG_ID, USER_ID)
    ).rejects.toThrow(NOT_PERSISTED_PATTERN);
  });
});
