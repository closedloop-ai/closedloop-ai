import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../components/settings-page";
import { SettingsTab } from "../settings-tabs";

/**
 * wongk, PR #4501 (ISS-5011): the `/organization` forward lands on
 * `/settings?tab=organization`. When Settings is ALREADY mounted, that is a soft
 * navigation that changes only the search params, so the App Router re-renders
 * this component in place with a new `initialTab` instead of remounting it.
 * `Tabs` is uncontrolled — `defaultValue` is read once, at mount — so before the
 * fix the user kept staring at Profile while the URL said `tab=organization`.
 *
 * These drive the real `SettingsPage` and the real design-system `Tabs`; only
 * the leaf panels and the Clerk/PostHog/navigation seams are stubbed, so the
 * assertions are about the tab state the component actually renders.
 */

const RE_PROFILE_TAB = /^Profile$/;
const RE_ORGANIZATION_TAB = /^Organization$/;
const ARIA_SELECTED = "aria-selected";
// The settled identify handshake: PostHog keyed on the signed-in user, so the
// flag values it serves describe that user. Nothing here is about the flag
// window, so this is the steady state throughout.
const CLERK_USER_ID = "user_settings_soft_nav";

vi.mock("@repo/auth/client", () => ({
  OrganizationProfile: () => <div data-testid="clerk-organization-profile" />,
  UserProfile: () => <div data-testid="clerk-user-profile" />,
  Show: ({ children }: { children: ReactNode }) => children,
  useUser: () => ({ isLoaded: true, user: { id: CLERK_USER_ID } }),
}));

vi.mock("@repo/auth/components/appearance", () => ({
  embeddedOrganizationProfileAppearance: {},
  embeddedProfileAppearance: {},
}));

vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: () => ({ enabled: true }),
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => CLERK_USER_ID,
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));

vi.mock("@repo/app/agents/components/agent-compliance-settings-tab", () => ({
  AgentComplianceSettingsTab: () => null,
}));

vi.mock(
  "@repo/app/custom-fields/components/custom-fields-settings-tab",
  () => ({ CustomFieldsSettingsTab: () => null })
);

vi.mock("@repo/app/tags/components/tags-settings-tab", () => ({
  TagsSettingsTab: () => null,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
  useUpdateUser: () => ({ mutate: vi.fn() }),
}));

vi.mock("../components/organization-slug-settings", () => ({
  OrganizationSlugSettings: () => null,
}));

vi.mock("../components/transcript-search-card", () => ({
  TranscriptSearchCard: () => null,
}));

vi.mock("../components/session-sync-policy-card", () => ({
  SessionSyncPolicyCard: () => null,
}));

vi.mock("../components/session-frustration-card", () => ({
  SessionFrustrationCard: () => null,
}));

vi.mock("../components/api-keys-settings-panel", () => ({
  ApiKeysSettingsPanel: () => null,
}));

vi.mock("../components/anthropic-api-key-card", () => ({
  AnthropicApiKeyCard: () => null,
}));

vi.mock("../components/cloud-compute-mode-card", () => ({
  CloudComputeModeCard: () => null,
}));

vi.mock("../components/local-compute-targets-card", () => ({
  LocalComputeTargetsCard: () => null,
}));

vi.mock("../components/github-integration-card", () => ({
  GitHubIntegrationCard: () => null,
}));

vi.mock("../components/google-integration-card", () => ({
  GoogleIntegrationCard: () => null,
}));

vi.mock("../components/linear-integration-card", () => ({
  LinearIntegrationCard: () => null,
}));

function renderSettings(initialTab: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage initialTab={initialTab} isAdmin={false} />
    </QueryClientProvider>
  );

  return {
    ...view,
    rerenderWithTab: (nextTab: string) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <SettingsPage initialTab={nextTab} isAdmin={false} />
        </QueryClientProvider>
      ),
  };
}

describe("SettingsPage — tab selection across a search-params-only navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects the tab the initial props ask for", () => {
    renderSettings(SettingsTab.Profile);

    expect(screen.getByRole("tab", { name: RE_PROFILE_TAB })).toHaveAttribute(
      ARIA_SELECTED,
      "true"
    );
  });

  it("moves to the new tab when only the URL's tab changes (soft navigation)", () => {
    const { rerenderWithTab } = renderSettings(SettingsTab.Profile);

    // The `/organization` forward, arriving at an already-mounted Settings page.
    rerenderWithTab(SettingsTab.Organization);

    expect(
      screen.getByRole("tab", { name: RE_ORGANIZATION_TAB })
    ).toHaveAttribute(ARIA_SELECTED, "true");
    expect(screen.getByRole("tab", { name: RE_PROFILE_TAB })).toHaveAttribute(
      ARIA_SELECTED,
      "false"
    );
  });

  it("leaves a user's own tab choice alone when the requested tab has not changed", async () => {
    // The remount must be keyed to the REQUESTED tab, not fired on every
    // re-render: clicking a trigger does not change the URL, so an unrelated
    // parent re-render must not yank the user back to the deep-linked tab.
    const { rerenderWithTab } = renderSettings(SettingsTab.Profile);

    await userEvent.click(
      screen.getByRole("tab", { name: RE_ORGANIZATION_TAB })
    );
    rerenderWithTab(SettingsTab.Profile);

    expect(
      screen.getByRole("tab", { name: RE_ORGANIZATION_TAB })
    ).toHaveAttribute(ARIA_SELECTED, "true");
  });
});
