// @vitest-environment jsdom

/**
 * ISS-11074 AC3. The web Welcome's Full Privacy Policy link resolved against the
 * app host and landed on Page not found, because the web host supplied no
 * privacy destination and the shared dialog's default was root-relative.
 * `packages/app` pins the dialog's own default; this pins what the web shell
 * actually renders, through the REAL web host, shared host and dialog.
 */

import {
  GUIDED_ONBOARDING_SNAPSHOT_PATH,
  type GuidedOnboardingSnapshot,
} from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { LEGAL_PRIVACY_PATH } from "@repo/app/shared/lib/legal-links";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet, post: vi.fn(), put: vi.fn() }),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn(() => Promise.resolve()) }),
  useOrganization: () => ({ organization: null }),
  useOrganizationList: () => ({
    createOrganization: vi.fn(),
    setActive: vi.fn(),
  }),
  useUser: () => ({
    user: {
      emailAddresses: [],
      primaryEmailAddress: { emailAddress: "ada@example.test" },
    },
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/dashboard",
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({ data: null }),
}));

vi.mock("@/hooks/use-github-authorize-href", () => ({
  useGitHubAuthorizeHref: () => "/github/connect",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useNavOrgSlug: () => "acme",
}));

// The welcome step renders this literal; no shared label constant exists.
const FULL_PRIVACY_POLICY = "Full Privacy Policy";
const CONFIGURED_WEB_ORIGIN = "https://web.test";

/** The server's first-run answer for a signed-in account with no run yet. */
const firstRunSnapshot: GuidedOnboardingSnapshot = {
  attemptId: null,
  context: {
    accountProvider: AccountProvider.GitHub,
    accountStatus: AccountStatus.Established,
    desktopAppDownloaded: false,
    githubConnected: true,
    membership: OrganizationMembership.FirstUser,
    organizationHasSyncedSessionData: KnownFlag.No,
    teamInvited: false,
    tourCompleted: false,
  },
  experienceVariant: null,
  restoreOutcome: OnboardingRestoreOutcome.Absent,
  revision: 0,
  state: serializeOnboardingState(createInitialOnboardingState()),
};

function renderWebHost() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            isLoaded: true,
            orgId: null,
            userId: "user-a",
          })}
        >
          <WebGuidedOnboardingDialogHost />
        </AuthAdapterProvider>
      </FeatureFlagAdapterProvider>
    </QueryClientProvider>
  );
}

describe("web guided Welcome privacy link (ISS-11074)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.startsWith(GUIDED_ONBOARDING_SNAPSHOT_PATH)) {
        return Promise.resolve(firstRunSnapshot);
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the canonical privacy policy URL through the web host chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_URL", CONFIGURED_WEB_ORIGIN);
    renderWebHost();

    const takeover = await screen.findByRole("dialog");
    const link = within(takeover).getByRole("link", {
      name: FULL_PRIVACY_POLICY,
    });

    // Composed rather than read from `privacyPolicyHref()`, which the dialog's
    // default also calls, so a regression inside that helper still fails here.
    // `getAttribute`, not `.href`: the attribute is what the host chain wrote,
    // before jsdom resolves it against the app origin.
    expect(link.getAttribute("href")).toBe(
      `${CONFIGURED_WEB_ORIGIN}${LEGAL_PRIVACY_PATH}`
    );
  });
});
