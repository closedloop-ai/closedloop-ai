import type {
  OnboardingAnalysisProgress,
  OnboardingSessionDiscovery,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import {
  OnboardingAnalysisEstimateStatus,
  OnboardingAnalysisProgressStatus,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncObservabilityTier } from "../../../../shared/contracts";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import type { OnboardingSessionDiscoveryRead } from "../../../hooks/use-onboarding-session-discovery";
import { useBlockingOnboardingModalOpen } from "../blocking-onboarding-modal-store";
import { DesktopGuidedOnboardingDialogHost } from "../desktop-guided-onboarding-dialog-host";

type CapturedGuidedHostProps = {
  brand?: ReactNode;
  analysisBannerOverride?: { active: boolean; label?: string | null };
  onAnalysisAgreed?: () => void;
  analysisSettled: boolean;
  analysisStarted: boolean;
  onAnalysisBannerHeightChange?: (height: number) => void;
  onOpenChange?: (open: boolean) => void;
  discovery: OnboardingSessionDiscovery;
  progress: OnboardingAnalysisProgress;
};

const stubs = vi.hoisted(() => ({
  connectGitHub: vi.fn(() => Promise.resolve()),
  guidedHostProps: [] as CapturedGuidedHostProps[],
  navigate: vi.fn(),
  onboardingDiscovery: null as OnboardingSessionDiscoveryRead | null,
  authenticatedStatus: "authenticated",
  organizationId: "org_acme",
  startupArgs: [] as { syncElected: boolean }[],
  consentRecord: null as SyncConsentRecord | null,
  userId: "user_1",
}));

vi.mock("../../../startup-readiness/use-startup-readiness", () => ({
  useStartupReadiness: (args: { syncElected: boolean }) => {
    stubs.startupArgs.push(args);
    return {
      active: true,
      analyzed: 2,
      found: 5,
      percent: 40,
      label: "Processing agent history",
      counterUnit: "source files",
      progressLabel: "Agent history source files processed",
    };
  },
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: stubs.navigate }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/",
}));

vi.mock(
  "@repo/app/onboarding/components/guided-onboarding-dialog-host",
  () => ({
    GuidedOnboardingDialogHost: (props: CapturedGuidedHostProps) => {
      stubs.guidedHostProps.push(props);
      return <div data-testid="guided-onboarding-host" />;
    },
  })
);

// The guest handoff calls these directly, so they are in THIS host's module
// graph rather than behind the mocked shared host. Unmocked they reach
// `useApiClient` -> `useAuthSnapshot`, which throws without an
// `AuthAdapterProvider` ancestor this suite has no reason to mount: its subject
// is discovery gating, not the handoff. An absent snapshot keeps the handoff
// inert, which is the state every case here runs in.
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: () => ({ data: undefined, isLoading: false }),
  useGuidedOnboardingTransition: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: vi.fn(() => Promise.resolve({ ok: true })),
    signOut: vi.fn(() => Promise.resolve()),
    state: {
      organizationId: stubs.organizationId,
      status: stubs.authenticatedStatus,
      userId: stubs.userId,
    },
  }),
}));

vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    identity: {
      email: "ada@example.com",
      organizationId: stubs.organizationId,
      organizationName: "Acme Engineering",
      organizationSlug: "acme",
      userId: stubs.userId,
    },
  }),
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
      connectGitHub: stubs.connectGitHub,
      connectState: actual.DesktopGitHubConnectState.Idle,
    }),
  };
});

vi.mock("../../../hooks/use-onboarding-session-discovery", () => ({
  useOnboardingSessionDiscovery: () => {
    if (stubs.onboardingDiscovery === null) {
      throw new Error("onboarding discovery fixture was not installed");
    }
    return stubs.onboardingDiscovery;
  },
}));

vi.mock("../use-sync-consent-record", () => ({
  useDeviceSyncConsentRecord: () => ({
    record: stubs.consentRecord ?? {
      bound: false,
      organizationId: null,
      tier: null,
    },
  }),
}));

const UNKNOWN_DISCOVERY: OnboardingSessionDiscovery = { status: "unknown" };
const UNKNOWN_PROGRESS: OnboardingAnalysisProgress = {
  status: OnboardingAnalysisProgressStatus.Unknown,
};

function Wrapper({ children }: { children: ReactNode }) {
  // The guest handoff reads the shared snapshot cache on its failure path
  // (ISS-10340), so this mount needs a client even though every case here
  // leaves the handoff inert. The renderer root supplies one in production.
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  stubs.connectGitHub.mockClear();
  stubs.guidedHostProps = [];
  stubs.navigate.mockClear();
  stubs.startupArgs = [];
  stubs.consentRecord = null;
  setDiscoveryRead({ progress: UNKNOWN_PROGRESS, settled: false });
});

describe("DesktopGuidedOnboardingDialogHost discovery gating", () => {
  it("does not mark analysis started while unsettled progress is unknown", () => {
    setDiscoveryRead({ progress: UNKNOWN_PROGRESS, settled: false });

    renderHost();

    expect(lastGuidedHostProps().analysisStarted).toBe(false);
  });

  it("marks analysis started at measured zero progress", () => {
    setDiscoveryRead({
      progress: measuredProgress(0),
      settled: false,
      started: true,
    });

    renderHost();

    expect(lastGuidedHostProps().analysisStarted).toBe(true);
  });

  it("preserves a begun pass with measured inventory and unknown progress", () => {
    setDiscoveryRead({
      discovery: measuredDiscovery(),
      progress: UNKNOWN_PROGRESS,
      settled: false,
      started: true,
    });

    renderHost();

    expect(lastGuidedHostProps().analysisStarted).toBe(true);
  });

  it("does not mistake measured inventory for a begun pass", () => {
    setDiscoveryRead({
      discovery: measuredDiscovery(),
      progress: UNKNOWN_PROGRESS,
      settled: false,
      started: false,
    });
    renderHost();
    expect(lastGuidedHostProps().analysisStarted).toBe(false);
  });

  it("does not use a measured denominator as proof the import began", () => {
    setDiscoveryRead({
      progress: measuredProgress(0),
      settled: false,
      started: false,
    });
    renderHost();
    expect(lastGuidedHostProps().analysisStarted).toBe(false);
  });

  /**
   * The gate PRD-689 asked for, and the one this fix must not open. A stalled
   * analyzer reports nothing, which folds to an `unknown` inventory AND an
   * unknown progress, and that pair still refuses the transition.
   */
  it("still gates a stalled analyzer that reports no inventory at all", () => {
    setDiscoveryRead({
      discovery: UNKNOWN_DISCOVERY,
      progress: UNKNOWN_PROGRESS,
      settled: false,
    });

    renderHost();

    expect(lastGuidedHostProps().analysisStarted).toBe(false);
  });

  it("marks analysis started after measured progress moves above zero", () => {
    setDiscoveryRead({
      progress: measuredProgress(4),
      settled: false,
    });

    renderHost();

    expect(lastGuidedHostProps().analysisStarted).toBe(true);
  });

  it("marks analysis started once the import settles even without progress", () => {
    setDiscoveryRead({ progress: UNKNOWN_PROGRESS, settled: true });

    renderHost();

    expect(lastGuidedHostProps().analysisStarted).toBe(true);
  });
});

/**
 * ISS-10492 — the two inputs the ambient analysis bar needs from THIS adapter.
 *
 * `analysisSettled` is its own axis, not a restatement of `analysisStarted`: a
 * pass that quarantines sources settles below 100%, and only `settled` says so.
 * The height reporter is what mounts the bar at all, and it comes from the shell
 * context rather than this component, so a mount with no provider must hand the
 * shared host `undefined` and leave the bar unmounted.
 */
describe("DesktopGuidedOnboardingDialogHost analysis-bar inputs", () => {
  it("forwards the startup pass independently of the onboarding run", () => {
    renderHost();
    expect(lastGuidedHostProps().analysisBannerOverride).toMatchObject({
      active: true,
      analyzed: 2,
      found: 5,
      label: "Processing agent history",
      percent: 40,
      counterUnit: "source files",
      progressLabel: "Agent history source files processed",
    });
  });

  /**
   * ISS-11668: the startup pass waits on the sync election before any cloud
   * phase. Only a tier that lets data leave this Mac, recorded for this org,
   * counts; Local starts no sync.
   */
  it("hands the startup pass the sync election only for a tier that syncs this org", () => {
    const cases: [SyncConsentRecord | null, boolean][] = [
      [null, false],
      [{ bound: true, organizationId: "org_acme", tier: null }, false],
      [
        {
          bound: true,
          organizationId: "org_acme",
          tier: SyncObservabilityTier.Full,
        },
        true,
      ],
      [
        {
          bound: true,
          organizationId: "org_acme",
          tier: SyncObservabilityTier.Metadata,
        },
        true,
      ],
      [
        {
          bound: true,
          organizationId: "org_acme",
          tier: SyncObservabilityTier.Local,
        },
        false,
      ],
      [
        {
          bound: true,
          organizationId: "org_other",
          tier: SyncObservabilityTier.Full,
        },
        false,
      ],
    ];
    for (const [record, elected] of cases) {
      stubs.consentRecord = record;
      stubs.startupArgs = [];
      const view = renderHost();
      expect(stubs.startupArgs.at(-1)?.syncElected).toBe(elected);
      view.unmount();
    }
  });

  it("forwards the host's own settled flag, not its started flag", () => {
    setDiscoveryRead({ progress: measuredProgress(40), settled: false });
    renderHost();
    expect(lastGuidedHostProps()).toMatchObject({
      analysisSettled: false,
      analysisStarted: true,
    });

    stubs.guidedHostProps = [];
    setDiscoveryRead({ progress: measuredProgress(40), settled: true });
    renderHost();
    expect(lastGuidedHostProps().analysisSettled).toBe(true);
  });

  // ISS-10570: the desktop wrapper is the only thing that joins the shared
  // host's report to the store the dashboard reads. Driven through the captured
  // prop rather than asserted to be defined, because a wrapper that passed some
  // other function would satisfy a defined-ness check and move the store
  // nowhere. Both directions, so a setter stuck on one of them fails here.
  it("relays the takeover's open state into the store the dashboard tour reads", () => {
    setDiscoveryRead({ progress: measuredProgress(40), settled: false });
    renderHost();
    const report = lastGuidedHostProps().onOpenChange;
    if (!report) {
      throw new Error("the wrapper passed no onOpenChange");
    }

    act(() => report(true));
    expect(readBlockingOnboardingModalOpen()).toBe(true);

    act(() => report(false));
    expect(readBlockingOnboardingModalOpen()).toBe(false);
  });

  it("reports no height sink with no shell reserving space for the bar", () => {
    setDiscoveryRead({ progress: measuredProgress(40), settled: false });
    renderHost();
    expect(lastGuidedHostProps().onAnalysisBannerHeightChange).toBeUndefined();
  });
});

/**
 * ISS-10890: Welcome's Start is this device's agreement to local analysis, and
 * the wrapper is the only thing joining the shared host's report of it to the
 * main-process write that releases the boot gate. Driven through the captured
 * prop, so a wrapper that passed some other function fails here.
 */
describe("DesktopGuidedOnboardingDialogHost analysis agreement", () => {
  const originalDesktopApi = Object.getOwnPropertyDescriptor(
    window,
    "desktopApi"
  );

  afterEach(() => {
    if (originalDesktopApi) {
      Object.defineProperty(window, "desktopApi", originalDesktopApi);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
  });

  it("records the agreement in main when the shared host reports Start", () => {
    const recordSessionAnalysisAgreement = vi.fn(() =>
      Promise.resolve({ ok: true })
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { recordSessionAnalysisAgreement },
      writable: true,
    });
    renderHost();
    const agree = lastGuidedHostProps().onAnalysisAgreed;
    if (!agree) {
      throw new Error("the wrapper passed no onAnalysisAgreed");
    }
    expect(recordSessionAnalysisAgreement).not.toHaveBeenCalled();

    agree();

    expect(recordSessionAnalysisAgreement).toHaveBeenCalledTimes(1);
  });
});

// ISS-11470. The defect was this host's own `brand` argument, not the lockup:
// desktop passed a bare mark (no wordmark) while web passed a bare `<span>`
// (no mark), so each shell shipped a different HALF of the same lockup. A unit
// test of `ClosedloopBrandLockup` cannot see that — it stays green with either
// host still passing its old half — so the assertion has to start at the host
// and read what it actually handed down.
describe("DesktopGuidedOnboardingDialogHost brand slot", () => {
  it("hands the wizard the full brand lockup: one mark then one wordmark", () => {
    renderHost();

    // Wrapped so the slot's own root element is what `parts` reads: the
    // lockup is the wrapper's only child, and its children are the two halves.
    const { container } = render(<div>{lastGuidedHostProps().brand}</div>);
    const lockup = container.firstElementChild?.firstElementChild;
    const parts = [...(lockup?.children ?? [])];

    // Exactly two children in exactly this order pins BOTH halves and the count
    // at once: a host back on its old half fails on length, not on a `queryBy`
    // that would pass just as happily against a lockup that rendered nothing.
    expect(parts.map((part) => part.tagName.toLowerCase())).toEqual([
      "svg",
      "span",
    ]);
    expect(parts[1]?.textContent).toBe("Closedloop.ai");
    // One accessible name for the brand, carried by the wordmark: the mark must
    // stay hidden so the pair is announced once rather than twice.
    expect(parts[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });
});

function renderHost() {
  return render(
    <Wrapper>
      <DesktopGuidedOnboardingDialogHost />
    </Wrapper>
  );
}

function setDiscoveryRead({
  discovery = UNKNOWN_DISCOVERY,
  progress,
  settled,
  started = settled ||
    progress.status === OnboardingAnalysisProgressStatus.Measured,
}: {
  discovery?: OnboardingSessionDiscovery;
  progress: OnboardingAnalysisProgress;
  settled: boolean;
  started?: boolean;
}): void {
  stubs.onboardingDiscovery = {
    discovery,
    progress,
    settled,
    started,
  };
}

/** The reported machine: sessions enumerated, none analyzed yet. */
function measuredDiscovery(): OnboardingSessionDiscovery {
  return {
    estimate: { status: OnboardingAnalysisEstimateStatus.Unknown },
    logBytes: null,
    sessionsAnalyzed: null,
    sessionsFound: 1086,
    sources: [],
    status: "measured",
  };
}

function measuredProgress(percent: number): OnboardingAnalysisProgress {
  return {
    percent,
    status: OnboardingAnalysisProgressStatus.Measured,
  };
}

function lastGuidedHostProps(): CapturedGuidedHostProps {
  const props = stubs.guidedHostProps.at(-1);
  if (!props) {
    throw new Error("GuidedOnboardingDialogHost did not render");
  }
  return props;
}

/**
 * The store read exactly as the dashboard reads it — through its hook, not a
 * module-private variable — so this cannot pass against a store whose subscribe
 * or snapshot is broken.
 */
function readBlockingOnboardingModalOpen(): boolean {
  let seen = false;
  function Probe() {
    seen = useBlockingOnboardingModalOpen();
    return null;
  }
  render(<Probe />);
  return seen;
}
