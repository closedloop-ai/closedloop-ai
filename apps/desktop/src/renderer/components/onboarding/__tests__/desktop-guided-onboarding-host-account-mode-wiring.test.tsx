/**
 * ISS-10913 production wiring: `account_mode` is folded at THIS host, the one
 * renderer boundary that reads the main-process auth state, and handed to both
 * desktop paths that can complete the Account step — the shared dialog host's
 * own completion and the converting guest's handoff. Dropping either prop
 * would leave the property missing from a live funnel event while every other
 * suite stayed green.
 */

import {
  OnboardingAccountMode,
  OnboardingAccountOutcome,
} from "@repo/api/src/types/onboarding-analytics";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingSessionDiscoveryRead } from "../../../hooks/use-onboarding-session-discovery";
import { DesktopGuidedOnboardingDialogHost } from "../desktop-guided-onboarding-dialog-host";

const stubs = vi.hoisted(() => ({
  authState: {
    accountOutcome: undefined as string | undefined,
    organizationId: "org_acme",
    status: "authenticated",
    userId: "user_1",
  },
  handoffArgs: [] as Record<string, unknown>[],
  hostProps: [] as Record<string, unknown>[],
}));

vi.mock("../../../startup-readiness/use-startup-readiness", () => ({
  useStartupReadiness: () => ({
    active: false,
    analyzed: null,
    found: null,
    percent: null,
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/",
}));

vi.mock(
  "@repo/app/onboarding/components/guided-onboarding-dialog-host",
  () => ({
    GuidedOnboardingDialogHost: (props: Record<string, unknown>) => {
      stubs.hostProps.push(props);
      return <div />;
    },
  })
);

vi.mock("../use-guest-guided-onboarding-handoff", () => ({
  useGuestGuidedOnboardingHandoff: (args: Record<string, unknown>) => {
    stubs.handoffArgs.push(args);
    return;
  },
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: vi.fn(() => Promise.resolve({ ok: true })),
    signOut: vi.fn(() => Promise.resolve()),
    state: stubs.authState,
  }),
}));

vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({ identity: null }),
}));

vi.mock("../../../shared-branches/desktop-github-integration-status", () => ({
  useDesktopGitHubIntegrationStatus: () => null,
}));

vi.mock("../../branches/use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../branches/use-desktop-github-connect")
    >();
  return {
    ...actual,
    useDesktopGitHubConnect: () => ({
      connectGitHub: vi.fn(),
      connectState: actual.DesktopGitHubConnectState.Idle,
    }),
  };
});

vi.mock("../../../hooks/use-onboarding-session-discovery", () => ({
  useOnboardingSessionDiscovery: (): OnboardingSessionDiscoveryRead => ({
    discovery: { status: "unknown" },
    progress: { status: "unknown" },
    settled: false,
    started: false,
  }),
}));

vi.mock("../use-sync-consent-record", () => ({
  useDeviceSyncConsentRecord: () => ({
    record: { bound: true, organizationId: null, tier: "full" },
    refresh: vi.fn(),
  }),
}));

beforeEach(() => {
  stubs.handoffArgs = [];
  stubs.hostProps = [];
  stubs.authState.accountOutcome = undefined;
});

describe("DesktopGuidedOnboardingDialogHost account_mode wiring", () => {
  it("folds a created-and-authenticated outcome and hands it to both completion paths", () => {
    stubs.authState.accountOutcome = OnboardingAccountOutcome.CreatedSignedIn;

    render(<DesktopGuidedOnboardingDialogHost />);

    const expected = [
      OnboardingAccountMode.Created,
      OnboardingAccountMode.SignedIn,
    ];
    expect(stubs.hostProps.at(-1)?.accountMode).toEqual(expected);
    expect(stubs.handoffArgs.at(-1)?.accountMode).toEqual(expected);
  });

  it("folds an existing-account sign-in to signed_in alone", () => {
    stubs.authState.accountOutcome = OnboardingAccountOutcome.SignedIn;

    render(<DesktopGuidedOnboardingDialogHost />);

    expect(stubs.hostProps.at(-1)?.accountMode).toEqual([
      OnboardingAccountMode.SignedIn,
    ]);
  });

  it("folds an ABSENT outcome — an older gateway's payload — to unknown, never to nothing", () => {
    // The whole reason the property is a set with an explicit unknown: a
    // version-skewed gateway must still produce a non-empty `account_mode`.
    render(<DesktopGuidedOnboardingDialogHost />);

    expect(stubs.hostProps.at(-1)?.accountMode).toEqual([
      OnboardingAccountMode.Unknown,
    ]);
    expect(stubs.handoffArgs.at(-1)?.accountMode).toEqual([
      OnboardingAccountMode.Unknown,
    ]);
  });
});
