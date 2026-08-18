/**
 * Feature-flag gating tests for SettingsPage.
 *
 * The existing settings-page.test.tsx mocks FeatureFlagged to always render
 * children (flag always-ON), so it cannot catch regressions where a gated
 * section leaks through a removed gate or stays hidden when the flag is on.
 * This file controls the flag per-test to assert both directions.
 *
 * Gates covered:
 *   "artifact-tags"  — Tags tab trigger + Tags tab content
 *   "the-one-flag"   — CloudComputeModeCard in Integrations tab
 *   "google-drive"   — GoogleIntegrationCard in Integrations tab
 */

import { FEATURE_FLAG_SETTLE_TIMEOUT_MS } from "@repo/app/shared/components/feature-flag-pending";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_TAB_PARAM, SettingsTab } from "../../settings-tabs";
import { SettingsPage, TAGS_PENDING_LABEL } from "../settings-page";

// Flag state is controlled per-test via mockEnabledFlags. Both the
// `FeatureFlagged` wrapper and the `useFeatureFlag` hook (used by SettingsPage
// to pick the effective default tab) read from the same set so they stay
// consistent within a test.
const mockEnabledFlags = new Set<string>();

// Flags PostHog has not answered for yet. `useFeatureFlag` returns `undefined`
// for these — NOT `{ enabled: false }` — which is a distinct third state and
// the one ISS-4566 lives in. Without it every test here starts from an
// already-resolved flag and the bug is unreachable.
const mockUnresolvedFlags = new Set<string>();

const ARTIFACT_TAGS_FLAG = "artifact-tags";

// The identify handshake, as PostHog actually exposes it. Flags bootstrap
// against the ANONYMOUS cookie distinct id, and only once `identify()` lands
// does PostHog re-request them keyed on the signed-in user. Until the distinct
// id matches the Clerk user id, a `false` is the anonymous answer and not a
// decision about this user (ISS-4566). Tests start SETTLED, so a test that does
// not care about the handshake reads as the steady state.
const CLERK_USER_ID = "user_settings_page";
const ANONYMOUS_DISTINCT_ID = "anon_cookie_id";
let mockDistinctId: string | undefined = CLERK_USER_ID;

// The real `FeatureFlagged` renders NEITHER branch until its own mount effect
// has run — a hydration guard, so it returns `null` while `!mounted` no matter
// what the flag says. A mock without that gate makes the first committed client
// render unreachable from a test, which is the one frame where a `?tab=tags`
// deep link can have a selected tab with no trigger. Held false for a test that
// wants that frame; true everywhere else, which is the state React Testing
// Library's effect flush produces anyway.
let mockFeatureFlaggedMounted = true;

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    flag,
    children,
    fallback = null,
  }: {
    flag: string;
    children: ReactNode;
    fallback?: ReactNode;
  }) => {
    if (!mockFeatureFlaggedMounted) {
      return null;
    }
    return mockEnabledFlags.has(flag) ? children : fallback;
  },
}));

vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) =>
    mockUnresolvedFlags.has(flag)
      ? undefined
      : {
          key: flag,
          enabled: mockEnabledFlags.has(flag),
          variant: undefined,
          payload: undefined,
        },
  // PostHog has delivered a flag response for whichever distinct id it is
  // currently keyed on — true through the anonymous bootstrap too, which is
  // exactly why it is not on its own proof the answer describes this user.
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => mockDistinctId,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  // Derived from the live jsdom URL rather than always-empty. The page reads
  // `?tab=` to notice when the query names a tab it is not rendering, and an
  // always-empty snapshot makes that repair unreachable from a test.
  useSearchParams: () => new URLSearchParams(globalThis.location.search),
}));

const mockHasRole = vi.fn();

type ShowProps = {
  children: ReactNode;
  fallback?: ReactNode;
  when: (
    has: (params: { role: string } | { permission: string }) => boolean
  ) => boolean;
};

vi.mock("@repo/auth/client", () => ({
  OrganizationProfile: () => null,
  OrganizationSwitcher: () => null,
  Show: ({ children, fallback, when }: ShowProps) =>
    when(mockHasRole) ? children : fallback,
  // Given a testid so "the fallback tab rendered its CONTENT" is assertable,
  // not just "the fallback trigger is selected".
  UserProfile: () => <div data-testid="clerk-user-profile" />,
  useUser: () => ({ isLoaded: true, user: { id: CLERK_USER_ID } }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock(
  "@repo/app/custom-fields/components/custom-fields-settings-tab",
  () => ({
    CustomFieldsSettingsTab: () => null,
  })
);

vi.mock("@repo/app/agents/components/agent-compliance-settings-tab", () => ({
  AgentComplianceSettingsTab: () => null,
}));

vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: () => null,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
  useUpdateUser: () => ({ mutate: vi.fn() }),
}));

vi.mock("../anthropic-api-key-card", () => ({
  AnthropicApiKeyCard: () => null,
}));

vi.mock("../api-keys-settings-panel", () => ({
  ApiKeysSettingsPanel: () => null,
}));

vi.mock("../cloud-compute-mode-card", () => ({
  CloudComputeModeCard: () => <div data-testid="cloud-compute-mode-card" />,
}));

vi.mock("../github-integration-card", () => ({
  GitHubIntegrationCard: () => null,
}));

vi.mock("../google-integration-card", () => ({
  GoogleIntegrationCard: () => <div data-testid="google-integration-card" />,
}));

vi.mock("../linear-integration-card", () => ({
  LinearIntegrationCard: () => null,
}));

vi.mock("../local-compute-targets-card", () => ({
  LocalComputeTargetsCard: () => null,
}));

vi.mock("../organization-slug-settings", () => ({
  OrganizationSlugSettings: () => null,
}));

vi.mock("../session-frustration-card", () => ({
  SessionFrustrationCard: () => null,
}));

vi.mock("../transcript-search-card", () => ({
  TranscriptSearchCard: () => null,
}));

vi.mock("../session-sync-policy-card", () => ({
  SessionSyncPolicyCard: () => null,
}));

vi.mock("@repo/app/tags/components/tags-settings-tab", () => ({
  TagsSettingsTab: () => <div data-testid="tags-settings-tab" />,
}));

// The panel-scoped failed-read surface (`TagsFlagUnavailable`) is rendered for
// real, not mocked: its whole point is that it says something different from the
// whole-route `FeatureFlagUnavailable` it replaced, and a seam mock cannot tell
// the two apart.
const TAGS_UNAVAILABLE_TITLE = "Couldn't load Tags";
// The URL every test starts from, so one test's deep link cannot leak into the
// next through the shared jsdom `location`.
const SETTINGS_URL = "/settings";

function renderSettings(initialTab: string, isAdmin: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderTree = (tab: string) => (
    <QueryClientProvider client={queryClient}>
      <SettingsPage initialTab={tab} isAdmin={isAdmin} />
    </QueryClientProvider>
  );
  const view = render(renderTree(initialTab));

  return {
    ...view,
    // A resolving PostHog flag re-renders this component in place: same mount,
    // same props, new flag state. It does NOT remount the page.
    rerenderInPlace: () => view.rerender(renderTree(initialTab)),
    // A search-params-only soft navigation: same mount, new `initialTab`.
    rerenderWithTab: (nextTab: string) => view.rerender(renderTree(nextTab)),
  };
}

function grantAdminRole() {
  mockHasRole.mockImplementation(
    (params: { role: string } | { permission: string }) =>
      "role" in params &&
      (params.role === "org:admin" || params.role === "org:owner")
  );
}

// One reset for the whole file. Every describe below needs exactly this, and
// five copies of it meant adding one line to the fixture was five edits.
beforeEach(() => {
  vi.clearAllMocks();
  mockEnabledFlags.clear();
  mockUnresolvedFlags.clear();
  mockFeatureFlaggedMounted = true;
  mockDistinctId = CLERK_USER_ID;
  grantAdminRole();
  globalThis.history.replaceState({}, "", SETTINGS_URL);
});

describe("SettingsPage artifact-tags flag gate", () => {
  it("hides the Tags tab trigger when artifact-tags is OFF", () => {
    // Flag is NOT in the set — opposite branch must fail this assertion.
    renderSettings(SettingsTab.Profile, true);
    expect(screen.queryByRole("tab", { name: "Tags" })).not.toBeInTheDocument();
  });

  it("shows the Tags tab trigger when artifact-tags is ON", () => {
    // The mock would NOT produce this result if the flag were off.
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    renderSettings(SettingsTab.Profile, true);
    expect(screen.getByRole("tab", { name: "Tags" })).toBeInTheDocument();
  });

  it("renders the TagsSettingsTab content when artifact-tags is ON and the Tags tab is active", () => {
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    renderSettings(SettingsTab.Tags, true);
    expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();
  });

  it("does not render the TagsSettingsTab content when artifact-tags is OFF", () => {
    // Flag OFF — content must be absent even if the tab param is present.
    renderSettings(SettingsTab.Tags, true);
    expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
  });

  it("falls back to the Profile tab when ?tab=tags but artifact-tags is OFF", () => {
    // A deep link to the Tags tab while the flag is off must NOT strand the
    // user on a blank page (no trigger, no content). The effective default tab
    // falls back to Profile, whose panel content is visible.
    renderSettings(SettingsTab.Tags, true);
    // Tags is unavailable: neither its trigger nor its content render.
    expect(screen.queryByRole("tab", { name: "Tags" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
    // The Profile tab is the active fallback.
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // Resolved OFF is a decision, so it commits at once. The pending panel is
    // for the unresolved state only and must not appear here.
    expect(
      screen.queryByRole("status", { name: TAGS_PENDING_LABEL })
    ).not.toBeInTheDocument();
  });

  it("keeps the Tags tab active when ?tab=tags and artifact-tags is ON", () => {
    // The flag-on deep link must not be bounced off its tab.
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    renderSettings(SettingsTab.Tags, true);
    expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});

/**
 * ISS-4566. Every test above starts from an ALREADY-RESOLVED flag, which misses
 * the reported bug: the state that strands the user is the UNRESOLVED one.
 * `useFeatureFlag` returns `undefined`, `<FeatureFlagged>` renders its fallback
 * exactly as it would for a disabled flag, and `?tab=tags` therefore selects a
 * tab with no trigger and no content. If the flag never resolves at all
 * (posthog-js blocked, `/flags` failing) that state is permanent.
 *
 * Three flag states, three different answers, all pinned here:
 *   - resolved OFF: fall back to the default tab, silently.
 *   - still unresolved: hold on Tags behind a pending panel, so a genuine
 *     flag-ON user is not shown Profile and then snapped over to Tags.
 *   - never resolved: past a bounded wait, commit to the failed-read surface
 *     rather than pend forever or claim the tab is off.
 */
describe("SettingsPage — artifact-tags unresolved on first render (ISS-4566)", () => {
  it("holds a ?tab=tags deep link on a pending panel while the flag is unresolved", () => {
    // The reported bug, at the moment it happens: PostHog has not answered, so
    // `artifactTags` is `undefined`. The panel must be neither blank (the bug)
    // nor a committed Profile (which snaps a flag-ON user over a beat later).
    mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
    renderSettings(SettingsTab.Tags, true);

    expect(
      screen.getByRole("status", { name: TAGS_PENDING_LABEL })
    ).toBeInTheDocument();
    // Not committed to the fallback, and not leaking the gated content either.
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
    // The strip holds on Tags with the panel. Without a trigger no tab reads as
    // selected at all, and the open panel's `aria-labelledby` dangles.
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tabpanel", { name: "Tags" })).toBeInTheDocument();
  });

  it("commits to the failed-read surface when the flag NEVER resolves", () => {
    // posthog-js blocked by an extension or a corporate proxy: no second render
    // ever arrives to repair anything. A pending panel that waits forever is the
    // same dead end as the blank one it replaced, so the wait has to be bounded.
    vi.useFakeTimers();
    try {
      mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
      renderSettings(SettingsTab.Tags, true);

      expect(
        screen.getByRole("status", { name: TAGS_PENDING_LABEL })
      ).toBeInTheDocument();

      // One tick SHORT of the real deadline, still pending. Without this step
      // the test passes for any positive timeout — a `setTimeout` never fires
      // before the clock moves, so asserting the panel at t=0 and again past a
      // hardcoded 60s holds just as well at 1ms as at ten minutes. This is the
      // step a too-early deadline fails.
      act(() => {
        vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS - 1);
      });
      expect(
        screen.getByRole("status", { name: TAGS_PENDING_LABEL })
      ).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      // Panel-scoped, and honest about the scope: it does not claim the page
      // failed to load, and its recovery keeps the user inside Settings.
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(TAGS_UNAVAILABLE_TITLE)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Try again" })
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Couldn't load this page")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Back to dashboard" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("status", { name: TAGS_PENDING_LABEL })
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the bounded wait when the pending state starts, not when the page mounted", () => {
    // The window this panel exists for opens mid-session: a user lands with the
    // flag resolved, reads for a while, and `identify()` then makes PostHog
    // re-request flags so `artifact-tags` goes briefly unresolved. A deadline
    // armed at page mount has long since expired by then, and would show a
    // failed-read surface for a sub-second re-resolution.
    vi.useFakeTimers();
    try {
      mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
      const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);
      expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS * 2);
      });

      mockEnabledFlags.delete(ARTIFACT_TAGS_FLAG);
      mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
      rerenderInPlace();

      expect(
        screen.getByRole("status", { name: TAGS_PENDING_LABEL })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(TAGS_UNAVAILABLE_TITLE)
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a ?tab=tags deep link onto Tags once the flag resolves ENABLED", () => {
    // Both ends of the transition are asserted, so an implementation that simply
    // left the user on Tags from the start cannot satisfy this.
    mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
    const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);

    expect(
      screen.getByRole("status", { name: TAGS_PENDING_LABEL })
    ).toBeInTheDocument();

    mockUnresolvedFlags.delete(ARTIFACT_TAGS_FLAG);
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();
  });

  it("does not yank a user off the tab they clicked when the flag resolves", async () => {
    // A flag resolution that does not change the requested tab must not discard
    // the user's own selection. Clicking first is what makes this observable:
    // without it the assertion is just the mount default and would hold under
    // any implementation.
    mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
    const { rerenderInPlace } = renderSettings(SettingsTab.Integrations, true);

    await userEvent.click(screen.getByRole("tab", { name: "API Keys" }));
    expect(screen.getByRole("tab", { name: "API Keys" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    mockUnresolvedFlags.delete(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByRole("tab", { name: "API Keys" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("does not steal a deep-linked user's own tab when the flag later resolves ENABLED", async () => {
    // The case the previous test misses, because there the resolved tab never
    // moves. Deep link ?tab=tags with the flag unresolved, pick another tab
    // while you wait, and the flag then resolving ENABLED must not drag the
    // screen onto Tags underneath you.
    mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
    const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);

    await userEvent.click(screen.getByRole("tab", { name: "Organization" }));
    expect(screen.getByRole("tab", { name: "Organization" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    mockUnresolvedFlags.delete(ARTIFACT_TAGS_FLAG);
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByRole("tab", { name: "Organization" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // The trigger is back, but the user is not on it.
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("re-selects the requested tab when a soft navigation resolves to the same fallback", async () => {
    // `?tab=tags`-while-unavailable and `?tab=profile` both render Profile, so a
    // remount keyed on the RESOLVED tab cannot tell them apart and a navigation
    // between the two never fires. The user's API Keys click then survives a
    // navigation that asked for Profile, leaving the URL contradicting the
    // screen. Keying on the REQUESTED tab is what separates them.
    const { rerenderWithTab } = renderSettings(SettingsTab.Tags, true);

    await userEvent.click(screen.getByRole("tab", { name: "API Keys" }));
    expect(screen.getByRole("tab", { name: "API Keys" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    rerenderWithTab(SettingsTab.Profile);

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "API Keys" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("keeps the Tags trigger on the first painted frame, before the flag gate mounts", () => {
    // `FeatureFlagged` returns null for BOTH branches until its mount effect
    // runs, so a trigger routed through it is missing from the first committed
    // render — including on the flag-ON path, where nothing is pending at all.
    // With `Tabs value` already on `tags`, that frame is a selected tab with no
    // trigger and a `tabpanel` whose `aria-labelledby` points at nothing: the
    // exact state the strip fallback exists to prevent, painted on every
    // `?tab=tags` load.
    mockFeatureFlaggedMounted = false;
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);

    renderSettings(SettingsTab.Tags, true);

    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tabpanel", { name: "Tags" })).toBeInTheDocument();
  });
});

/**
 * The other half of the identity-reload path, and the one the tests above all
 * miss because every one of them starts from an ON or unresolved flag: a deep
 * link that arrives while the flag reads OFF.
 *
 * `?tab=tags` is server-allowlisted for every member, so this is what a shared
 * or bookmarked Tags URL does for anyone whose flag says no — including,
 * transiently, a user whose anonymous bootstrap answered before `identify()`
 * did. The bounce has to be a decision the screen then STAYS with, and the URL
 * has to stop describing a tab that is not on screen.
 */
describe("SettingsPage — artifact-tags resolved OFF on a ?tab=tags deep link", () => {
  it("rewrites the query to the tab it actually rendered", () => {
    globalThis.history.replaceState(
      {},
      "",
      `${SETTINGS_URL}?${SETTINGS_TAB_PARAM}=${SettingsTab.Tags}`
    );

    renderSettings(SettingsTab.Tags, true);

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // Left alone, the address bar, the bookmark and any shared copy of this URL
    // all keep claiming a tab the user is not on.
    expect(
      new URLSearchParams(globalThis.location.search).get(SETTINGS_TAB_PARAM)
    ).toBe(SettingsTab.Profile);
  });

  it("does not snap the user onto Tags when the flag later reloads ENABLED", () => {
    const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // `identify()` lands and PostHog re-requests flags: `artifact-tags` is on
    // after all. The trigger comes back, but the screen must not move on its
    // own — a bounce that leaves a stale `tags` selection behind jumps the user
    // off the Profile tab they have been reading.
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
  });

  it("does not snap the user onto a pending Tags panel when the flag goes UNRESOLVED", () => {
    const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // The same jump, via the skeleton rather than the content.
    mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.queryByRole("status", { name: TAGS_PENDING_LABEL })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Tags" })).not.toBeInTheDocument();
  });
});

/**
 * The pre-`identify()` FALSE, which is the shape "not answered yet" usually
 * arrives in — not `undefined`. PostHog bootstraps flags against the ANONYMOUS
 * cookie distinct id and only re-requests them once `identify()` lands, so a
 * signed-in user whose flag is ON commonly reads `false` for the first beat.
 *
 * The bounce is ONE-WAY, so committing it on that beat is unrecoverable: the
 * selection moves off Tags, the query repair rewrites the deep link to
 * `?tab=profile`, and the user who genuinely has the flag never reaches Tags —
 * not when `identify()` resolves it ON, and not on a reload, because the URL no
 * longer asks for it. For a deep link to a gated tab, flag-ON is the majority
 * case, so this state must be treated as PENDING and the bounce withheld.
 */
describe("SettingsPage — artifact-tags FALSE before identify() lands (ISS-4566)", () => {
  it("holds a ?tab=tags deep link on Tags through a pre-identify FALSE and lands on Tags once identify resolves it ON", () => {
    globalThis.history.replaceState(
      {},
      "",
      `${SETTINGS_URL}?${SETTINGS_TAB_PARAM}=${SettingsTab.Tags}`
    );
    // PostHog is answering for the anonymous cookie id, not this user, and its
    // answer is `false`. The flag is ON for the identified user.
    mockDistinctId = ANONYMOUS_DISTINCT_ID;

    const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);

    // Withheld, not committed: still on Tags, behind the pending panel.
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.getByRole("status", { name: TAGS_PENDING_LABEL })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    // And the deep link is left alone. Rewriting it here is what removes the
    // reload as a recovery: the URL would stop asking for the tab the user
    // asked for, permanently.
    expect(
      new URLSearchParams(globalThis.location.search).get(SETTINGS_TAB_PARAM)
    ).toBe(SettingsTab.Tags);

    // identify() lands and PostHog re-requests flags for the real user: ON.
    mockDistinctId = CLERK_USER_ID;
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      new URLSearchParams(globalThis.location.search).get(SETTINGS_TAB_PARAM)
    ).toBe(SettingsTab.Tags);
  });

  it("never commits the bounce or rewrites the deep link when identify() never lands", () => {
    // A deadline is a TIMEOUT, not a decision, and the bounce is the one
    // irreversible action on this page: it rewrites the address bar and the
    // history entry, so a handshake that is merely slow would cost a flag-ON
    // user the tab AND the link back to it, on every reload, forever.
    // `FeatureFlagRouteGate` withholds its own one-way `notFound()` at this same
    // deadline for this same reason. Nothing is held open by the refusal: the
    // panel runs its own bounded wait and commits `TagsFlagUnavailable` inside
    // itself, which states the scope of the failure and offers the reload that
    // can actually change the answer.
    vi.useFakeTimers();
    try {
      globalThis.history.replaceState(
        {},
        "",
        `${SETTINGS_URL}?${SETTINGS_TAB_PARAM}=${SettingsTab.Tags}`
      );
      mockDistinctId = ANONYMOUS_DISTINCT_ID;

      renderSettings(SettingsTab.Tags, true);

      act(() => {
        vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS * 2);
      });

      // Still the user's tab, and still the user's URL.
      expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
        "aria-selected",
        "false"
      );
      expect(
        new URLSearchParams(globalThis.location.search).get(SETTINGS_TAB_PARAM)
      ).toBe(SettingsTab.Tags);
      // Terminal and honest, inside the panel rather than across the page.
      expect(screen.getByText(TAGS_UNAVAILABLE_TITLE)).toBeInTheDocument();
      expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still withholds the bounce on a pre-identify FALSE long after the page mounted", () => {
    // The pre-identify window can open at any point in a session, not only at
    // mount: PostHog re-keys and answers `false` again minutes in. Nothing about
    // how long the page has been open converts that `false` into a decision.
    vi.useFakeTimers();
    try {
      // Settled and ON first, so the clock runs out with nothing pending.
      mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
      const { rerenderInPlace } = renderSettings(SettingsTab.Tags, true);
      expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS * 2);
      });

      // PostHog re-keys onto an unidentified id and answers `false` again.
      mockEnabledFlags.delete(ARTIFACT_TAGS_FLAG);
      mockDistinctId = ANONYMOUS_DISTINCT_ID;
      rerenderInPlace();

      expect(screen.getByRole("tab", { name: "Tags" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The identity-reload path. `<AnalyticsProvider bootstrapFeatureFlags>` resolves
 * flags against the ANONYMOUS distinct id first, so a signed-in user's real
 * value often only lands after `identify()` reloads them. A flag that was ON at
 * mount can therefore go false, or go back to unresolved, while the user is
 * sitting on the Tags tab they clicked themselves. Neither may leave them on a
 * tab with no trigger and no content.
 */
describe("SettingsPage — artifact-tags flips after the user selected Tags", () => {
  it("falls back off Tags when the flag reloads to DISABLED", async () => {
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    const { rerenderInPlace } = renderSettings(SettingsTab.Profile, true);

    await userEvent.click(screen.getByRole("tab", { name: "Tags" }));
    expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();

    mockEnabledFlags.delete(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByTestId("clerk-user-profile")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Tags" })).not.toBeInTheDocument();
  });

  it("shows the pending panel when the flag reloads to UNRESOLVED", async () => {
    mockEnabledFlags.add(ARTIFACT_TAGS_FLAG);
    const { rerenderInPlace } = renderSettings(SettingsTab.Profile, true);

    await userEvent.click(screen.getByRole("tab", { name: "Tags" }));
    expect(screen.getByTestId("tags-settings-tab")).toBeInTheDocument();

    mockEnabledFlags.delete(ARTIFACT_TAGS_FLAG);
    mockUnresolvedFlags.add(ARTIFACT_TAGS_FLAG);
    rerenderInPlace();

    // Not blank: the trigger and the content are both gone, so something has to
    // occupy the panel the user is still looking at.
    expect(
      screen.getByRole("status", { name: TAGS_PENDING_LABEL })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("tags-settings-tab")).not.toBeInTheDocument();
  });
});

describe("SettingsPage the-one-flag gate (CloudComputeModeCard)", () => {
  it("hides CloudComputeModeCard when the-one-flag is OFF", () => {
    // Asserting absence with flag OFF ensures a removal of the gate would
    // break this test rather than silently pass.
    renderSettings(SettingsTab.Integrations, false);
    expect(
      screen.queryByTestId("cloud-compute-mode-card")
    ).not.toBeInTheDocument();
  });

  it("shows CloudComputeModeCard when the-one-flag is ON", () => {
    mockEnabledFlags.add("the-one-flag");
    renderSettings(SettingsTab.Integrations, false);
    expect(screen.getByTestId("cloud-compute-mode-card")).toBeInTheDocument();
  });
});

describe("SettingsPage google-drive flag gate (GoogleIntegrationCard)", () => {
  it("hides GoogleIntegrationCard when google-drive is OFF", () => {
    renderSettings(SettingsTab.Integrations, false);
    expect(
      screen.queryByTestId("google-integration-card")
    ).not.toBeInTheDocument();
  });

  it("shows GoogleIntegrationCard when google-drive is ON", () => {
    mockEnabledFlags.add("google-drive");
    renderSettings(SettingsTab.Integrations, false);
    expect(screen.getByTestId("google-integration-card")).toBeInTheDocument();
  });
});
