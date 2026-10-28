// @vitest-environment jsdom

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { AuthMethods } from "../auth-methods";
import { ConnectGitHubPrompt } from "../connect-github-prompt";
import { GuidedGettingStartedCard } from "../guided-getting-started-card";

/**
 * The two marks are told apart by what makes one a logo and the other a glyph,
 * not by a class name a refactor could rename: the Invertocat is one filled
 * path, lucide's outline is two stroked ones on a transparent body.
 */
function markShape(svg: SVGSVGElement | null) {
  return {
    fill: svg?.getAttribute("fill"),
    paths: svg?.querySelectorAll("path").length,
  };
}

const FILLED = { fill: "currentColor", paths: 1 };
const OUTLINE = { fill: "none", paths: 2 };

/** Server-rendered markup carries the class lucide stamps; the filled mark does not. */
const OUTLINE_IN_MARKUP = /lucide-github/;
const FILLED_IN_MARKUP = /fill="currentColor"/;

function withFlag(enabled: boolean, ui: ReactNode) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled
          ? [GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

describe("the GitHub mark on the shared onboarding surface", () => {
  // `packages/app/onboarding` is mounted by BOTH shells — `apps/app` and the
  // desktop renderer's guided-onboarding dialog host — so this is the one
  // assertion that covers the desktop surface at all: no desktop file names
  // this component, it arrives through the shared render tree.
  it("renders the outline glyph while the flag is closed", () => {
    const { container } = withFlag(
      false,
      <ConnectGitHubPrompt
        action={GitHubConnectAction.Connect}
        onConnect={vi.fn()}
      />
    );

    expect(markShape(container.querySelector("svg.size-6"))).toEqual(OUTLINE);
  });

  it("renders the filled Invertocat mark at the same size once the flag opens", () => {
    const { container } = withFlag(
      true,
      <ConnectGitHubPrompt
        action={GitHubConnectAction.Connect}
        onConnect={vi.fn()}
      />
    );

    // Queried BY the sizing class, so the size the surface asked for surviving
    // the swap is part of what passing means.
    expect(markShape(container.querySelector("svg.size-6"))).toEqual(FILLED);
  });

  // Mounted ONLY by the desktop shell — its sign-in step and the signed-out
  // Settings account tab. Nothing on web renders it, so if the gate were wired
  // wrong here no web test could catch it.
  it("gates the desktop sign-in button's mark", () => {
    const { container } = withFlag(true, <AuthMethods onSelect={vi.fn()} />);

    expect(markShape(container.querySelector("svg"))).toEqual(FILLED);
  });

  // The mounted guard is why the closed state is byte-identical on a surface
  // that server-renders: the flag can answer from bootstrapped local state on
  // the first client render. `render` flushes effects, so only a SERVER render
  // can observe the guard at all — drop `mounted &&` and this is the case that
  // reddens.
  it("still server-renders the outline when the flag is open", () => {
    const html = renderToStaticMarkup(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY],
        })}
      >
        <ConnectGitHubPrompt
          action={GitHubConnectAction.Connect}
          onConnect={vi.fn()}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(html).toMatch(OUTLINE_IN_MARKUP);
    expect(html).not.toMatch(FILLED_IN_MARKUP);
  });
});

const mockGuidedHooks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockGuidedHooks.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition: mockGuidedHooks.useGuidedOnboardingTransition,
}));

function pendingGitHubSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 3,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [OnboardingPhase.DashboardAvailable],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGuidedHooks.useGuidedOnboardingSnapshot.mockReturnValue({
    data: pendingGitHubSnapshot(),
    isLoading: false,
  });
  mockGuidedHooks.useGuidedOnboardingTransition.mockReturnValue({
    isPending: false,
    mutate: mockGuidedHooks.mutate,
  });
});

describe("the GitHub mark reached through the getting-started step record", () => {
  // `GETTING_STARTED_STEP_CONTENT` stores a component REFERENCE rather than
  // rendering the mark inline, so a find-and-replace over JSX call sites walks
  // straight past it. This renders the card the desktop and web sidebars mount
  // and asserts the icon the record actually yielded.
  it("carries the gated logo into the rendered step icon", () => {
    const navigation = createMemoryNavigation({ initialPath: "/dashboard" });
    const { container } = withFlag(
      true,
      <NavigationProvider adapter={navigation.adapter}>
        <GuidedGettingStartedCard
          analysisStarted={true}
          host={OnboardingHost.Desktop}
        />
      </NavigationProvider>
    );

    const stepIcons = [...container.querySelectorAll("svg")].map(markShape);

    expect(stepIcons).toContainEqual(FILLED);
  });
});
