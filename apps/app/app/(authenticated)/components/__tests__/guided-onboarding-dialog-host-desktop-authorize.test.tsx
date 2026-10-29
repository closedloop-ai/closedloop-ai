// @vitest-environment jsdom

import { DESKTOP_AUTHORIZE_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

/**
 * ISS-11910 / ISS-11912. The web guided-onboarding takeover is mounted from the
 * sidebar on EVERY authenticated page, so a desktop sign-up ran the whole web
 * wizard over the desktop authorize/consent card and delayed the hand-back by
 * minutes — and the web attempt it posted is what left the desktop adopting a
 * web position instead of running its own sync-policy step.
 */
const mocks = vi.hoisted(() => ({
  githubStatusEnabled: null as boolean | null,
  guidedHostMounted: false,
  organizationListRequest: vi.fn(),
  pathname: "/acme/dashboard",
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock(
  "@repo/app/onboarding/components/guided-onboarding-dialog-host",
  () => ({
    GuidedOnboardingDialogHost: () => {
      mocks.guidedHostMounted = true;
      return <div data-testid="guided-takeover" />;
    },
  })
);

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: (options?: { enabled?: boolean }) => {
    mocks.githubStatusEnabled = options?.enabled ?? null;
    return { data: null };
  },
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: true }),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useOrganization: () => ({ isLoaded: true, organization: { name: "Acme" } }),
  useOrganizationList: (request?: unknown) => {
    mocks.organizationListRequest(request);
    return {
      createOrganization: vi.fn(),
      isLoaded: true,
      setActive: vi.fn(),
      userInvitations: { data: [], isError: false, isFetching: false },
      userMemberships: { data: [], isError: false, isFetching: false },
    };
  },
  useUser: () => ({
    user: {
      emailAddresses: [],
      primaryEmailAddress: { emailAddress: "ada@example.test" },
    },
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => mocks.pathname,
}));

vi.mock("@/hooks/use-github-authorize-href", () => ({
  useGitHubAuthorizeHref: () => "/github/connect",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useNavOrgSlug: () => "acme",
}));

function renderHost() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <WebGuidedOnboardingDialogHost />
      </AuthAdapterProvider>
    </QueryClientProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}

describe("WebGuidedOnboardingDialogHost on the desktop authorize page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guidedHostMounted = false;
    mocks.githubStatusEnabled = null;
    mocks.pathname = "/acme/dashboard";
  });

  it("renders no takeover on the org-scoped authorize page", () => {
    mocks.pathname = `/acme${DESKTOP_AUTHORIZE_PATHNAME}`;

    const view = renderHost();

    expect(view.queryByTestId("guided-takeover")).toBeNull();
    expect(mocks.guidedHostMounted).toBe(false);
  });

  it("renders no takeover on the bare authorize page", () => {
    mocks.pathname = DESKTOP_AUTHORIZE_PATHNAME;

    const view = renderHost();

    expect(view.queryByTestId("guided-takeover")).toBeNull();
  });

  it("does not read the GitHub integration status it cannot render", () => {
    mocks.pathname = `/acme${DESKTOP_AUTHORIZE_PATHNAME}`;

    renderHost();

    expect(mocks.githubStatusEnabled).toBe(false);
  });

  /**
   * The membership and invitation lists feed only the Choose organization step,
   * which cannot render on a route this host returns `null` for. Asserted on
   * the REQUEST rather than on the lists, because the hook is called either way
   * — what must not happen is asking Clerk for two pages nobody reads.
   */
  it("does not request the organization lists it cannot render", () => {
    mocks.pathname = `/acme${DESKTOP_AUTHORIZE_PATHNAME}`;

    renderHost();

    expect(mocks.organizationListRequest).toHaveBeenCalled();
    for (const [request] of mocks.organizationListRequest.mock.calls) {
      expect(request).toBeUndefined();
    }
  });

  /**
   * The counterfactual. Suppressing on EVERY path would also pass the three
   * cases above, and would silently delete the web wizard; this is the case
   * that fails if the predicate is widened.
   */
  it("still renders the takeover on an ordinary authenticated page", () => {
    mocks.pathname = "/acme/dashboard";

    const view = renderHost();

    expect(view.queryByTestId("guided-takeover")).not.toBeNull();
    expect(mocks.githubStatusEnabled).toBe(true);
    // The other half of the suppression above: off the consent page the lists
    // ARE requested, so widening the predicate to every route fails here
    // instead of quietly deleting the Choose organization step's inputs.
    expect(mocks.organizationListRequest).toHaveBeenCalledWith({
      userInvitations: true,
      userMemberships: true,
    });
  });
});
