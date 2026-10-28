import type { Page } from "@playwright/test";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  KnownFlag,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { waitForClerkUser } from "./app-bootstrap";

// Deterministic synthetic teams for specs that render the full authenticated app
// shell while mocking their own `/me` (the branch-view family). Without this, the
// sidebar's `useTeams()` pulls the live, shared-stage team list (~40 real UUIDs),
// which is non-deterministic across previews and leaks into the rendered DOM
// (FEA-1676). Fixed ids/names/slugs/dates keep the rendered shell stable.
const SYNTHETIC_ORG_ID = "org-e2e-synthetic";
const SYNTHETIC_CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

export const SYNTHETIC_TEAMS: TeamWithCounts[] = [
  {
    id: "team-e2e-synthetic-alpha",
    organizationId: SYNTHETIC_ORG_ID,
    name: "E2E Synthetic Team Alpha",
    slug: "e2e-synthetic-team-alpha",
    createdAt: SYNTHETIC_CREATED_AT,
    updatedAt: SYNTHETIC_CREATED_AT,
    memberCount: 3,
    projectCount: 2,
  },
  {
    id: "team-e2e-synthetic-beta",
    organizationId: SYNTHETIC_ORG_ID,
    name: "E2E Synthetic Team Beta",
    slug: "e2e-synthetic-team-beta",
    createdAt: SYNTHETIC_CREATED_AT,
    updatedAt: SYNTHETIC_CREATED_AT,
    memberCount: 1,
    projectCount: 0,
  },
];

/**
 * The localStorage key `packages/analytics/client.ts` reads the flag fixture
 * from. Keep aligned with that module.
 *
 * EXPORTED, and that is the point (marisolashgrove, PR #6678): a spec that seeds
 * the fixture without going through {@link installMockedFeatureFlags} has to
 * name this key, and while it was private every such spec wrote its own copy.
 * Two did. A private constant also made the ISS-9244 exposure derivation grep
 * for the raw literal as a second, separately-remembered step.
 */
export const FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";

type MockedFeatureFlag = {
  enabled: boolean;
  metadata: Record<string, never>;
  variant: null;
};

export type MockedFeatureFlagsResponse = {
  errorsWhileComputingFlags: false;
  featureFlagPayloads: Record<string, never>;
  featureFlags: Record<string, boolean>;
  flags: Record<string, MockedFeatureFlag>;
};

// PostHog currently emits both spellings, while a child path names a different
// endpoint this fixture has no response contract for.
const MOCKED_FEATURE_FLAG_PATHS = new Set(["/flags", "/flags/"]);

export function mockedFeatureFlagsPayload(
  method: string,
  pathname: string,
  featureFlags: Record<string, boolean>
): MockedFeatureFlagsResponse | undefined {
  if (method !== "POST" || !MOCKED_FEATURE_FLAG_PATHS.has(pathname)) {
    return undefined;
  }

  return {
    errorsWhileComputingFlags: false,
    featureFlagPayloads: {},
    featureFlags,
    flags: Object.fromEntries(
      Object.entries(featureFlags).map(([key, enabled]) => [
        key,
        { enabled, metadata: {}, variant: null },
      ])
    ),
  };
}

/**
 * Playwright's URL predicate has no method, so the handler rechecks the real
 * request before returning a decision payload. Exporting the same predicate the
 * installer registers keeps its closed path set executable by the offline guard.
 */
export function isMockedFeatureFlagsRoute(url: URL): boolean {
  return MOCKED_FEATURE_FLAG_PATHS.has(url.pathname);
}
const ONBOARDING_PATHNAME = "/onboarding";
const GUIDED_ONBOARDING_SNAPSHOT_PATHNAME = "/onboarding/guided/snapshot";
const TEAMS_PATHNAME = "/teams";
const USERS_PATHNAME = "/users";

// Intercept the shell's `GET /teams` read and return the synthetic set. Scoped to
// the exact `/teams` collection path and GET only, so team sub-resources
// (`/teams/<id>`, `/teams/<id>/repositories`, …) and mutations fall through to
// the spec's own routes or the live backend.
export async function installDeterministicTeamsFixture(
  page: Page
): Promise<void> {
  await page.route(
    (url) => url.pathname === TEAMS_PATHNAME,
    async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }

      await route.fulfill({
        body: JSON.stringify({ success: true, data: SYNTHETIC_TEAMS }),
        contentType: "application/json",
        status: 200,
      });
    }
  );
}

export async function installAuthenticatedShellFixture(
  page: Page,
  input: { user: unknown }
): Promise<void> {
  await installDeterministicTeamsFixture(page);

  await page.route(
    (url) => url.pathname === USERS_PATHNAME,
    async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }

      await route.fulfill({
        body: JSON.stringify({ data: [input.user], success: true }),
        contentType: "application/json",
        status: 200,
      });
    }
  );

  await installSettledOnboardingFixture(page);
}

/**
 * Pin both onboarding reads to a workspace that is past first run: wizard and
 * guided tour complete, checklist dismissed, nothing left to prompt for.
 *
 * ISS-7089 F2 deleted the `invite-spotlight` flag, so the first-run nudge is no
 * longer switched off for every spec by the flag mock. On a real containerized
 * org — one team, one project, one member — the checklist renders and the
 * spotlight floats a `fixed`, clickable card near its invite row, over whatever
 * the surface under test happens to be. Any spec that drives the My Tasks board
 * against the live backend, rather than mocking the shell, has to pin this or
 * it is testing the board through a nudge card.
 */
export async function installSettledOnboardingFixture(
  page: Page
): Promise<void> {
  const snapshot: GuidedOnboardingSnapshot = {
    attemptId: "attempt-e2e-settled",
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 1,
    state: serializeOnboardingState({
      accountProvider: null,
      history: [
        OnboardingPhase.DashboardAvailable,
        OnboardingPhase.DashboardTour,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
  await page.route(
    (url) =>
      url.pathname === ONBOARDING_PATHNAME ||
      url.pathname === GUIDED_ONBOARDING_SNAPSHOT_PATHNAME,
    async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }

      await route.fulfill({
        body: JSON.stringify({
          data:
            new URL(request.url()).pathname ===
            GUIDED_ONBOARDING_SNAPSHOT_PATHNAME
              ? snapshot
              : {
                  checklist: [],
                  checklistDismissed: true,
                  wizardCompleted: true,
                },
          success: true,
        }),
        contentType: "application/json",
        status: 200,
      });
    }
  );
}

export async function installMockedFeatureFlags(
  page: Page,
  featureFlags: Record<string, boolean>
): Promise<void> {
  await page.addInitScript(
    ({ flags, storageKey }) => {
      globalThis.localStorage.setItem(storageKey, JSON.stringify(flags));
    },
    { flags: featureFlags, storageKey: FEATURE_FLAGS_STORAGE_KEY }
  );

  await page.route(isMockedFeatureFlagsRoute, async (route) => {
    const request = route.request();
    const payload = mockedFeatureFlagsPayload(
      request.method(),
      new URL(request.url()).pathname,
      featureFlags
    );
    if (payload === undefined) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      body: JSON.stringify(payload),
      contentType: "application/json",
      status: 200,
    });
  });
}

/**
 * Navigates a client-mocked shell spec and waits for Clerk to hydrate a user
 * before returning (ISS-5173).
 *
 * "Client-mocked" is not "no live dependency": `installAuthenticatedShellFixture`
 * mocks the app's own data reads, but the shell still boots the real Clerk SDK
 * against the shared dev FAPI. A bare `page.goto` therefore races the first
 * content assertion against that bootstrap, which is the FEA-2299 cold-shell
 * render race — and the reason branches-surface and the responsive suites were
 * quarantined under FEA-2727 / FEA-3865-3867 while the branch-view family, which
 * adopted the self-heal in `openBranchView`, kept gating.
 *
 * `waitForClerkUser` is idempotent and returns immediately once `window.Clerk`
 * has a user, so applying it to every cold navigation costs nothing on a healthy
 * run and recovers in place on a slow or rate-limited one.
 */
export async function gotoMockedShell(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForClerkUser(page);
}
