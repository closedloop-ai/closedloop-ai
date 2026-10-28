/**
 * @file sidebar-guided-run-relay.test.tsx
 * @description ISS-11251 — the run the modal is rendering reaches the sidebar's
 * checklist card, at the real mount site.
 *
 * `DesktopGuidedOnboardingDialogHost` and the checklist card sit in different
 * component trees (siblings under `Sidebar`, the card several levels down), so
 * the run is relayed through `guided-onboarding-run-override-store`. Before that
 * relay the card read the SERVER run beside a modal rendering an override: it
 * counted a run the reader was not in, and its press posted a transition that
 * modal never watched, so the CTA did nothing at all — silently, because a failed
 * guided transition is deliberately not toasted.
 *
 * Asserted here rather than only in the shared package's integration suite,
 * because that suite hands both mounts one run directly and so cannot see the
 * relay being dropped.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import type { GuidedOnboardingRun } from "@repo/app/onboarding/lib/guided-onboarding-run";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import {
  getGuidedOnboardingRunOverride,
  setGuidedOnboardingRunOverride,
  useGuidedOnboardingRunOverride,
} from "../../onboarding/guided-onboarding-run-override-store";
import { Sidebar } from "../Sidebar";

const hostRunSources = vi.hoisted(() => ({
  guestRun: undefined as unknown,
  handoffRun: undefined as unknown,
}));

/** Rendered by the card stub only when it was handed a run. */
const RELAYED_TEST_ID = "guided-card-holds-relayed-run";
/** Rendered by the card stub when it was handed none — the server-run default. */
const SERVER_TEST_ID = "guided-card-holds-server-run";

vi.mock(
  "../../../shared-agent-sessions/desktop-auth-provider",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../shared-agent-sessions/desktop-auth-provider")
      >();
    return {
      ...actual,
      useDesktopAuth: () => ({
        signIn: () => Promise.resolve(),
        signOut: () => Promise.resolve(),
        state: { status: "authenticated", userId: "user_1" },
      }),
    };
  }
);
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({ identity: null, isResolved: false }),
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: () => null,
}));
/**
 * The stub reports only WHETHER a run arrived, which is the whole contract the
 * relay owes. Reading the run's contents here would pin this suite to the card's
 * internals instead.
 */
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: ({ run }: { run?: GuidedOnboardingRun }) => (
    <div data-testid={run ? RELAYED_TEST_ID : SERVER_TEST_ID} />
  ),
}));
/**
 * The SHARED modal is stubbed, not the desktop wrapper: the wrapper is the only
 * production writer of the relay, so mocking IT away would leave this suite
 * pinning only the read half — green even with the publish deleted.
 */
vi.mock(
  "@repo/app/onboarding/components/guided-onboarding-dialog-host",
  () => ({
    GuidedOnboardingDialogHost: () => null,
  })
);
/**
 * The two run sources the wrapper folds into the one run it publishes. Mocked
 * because a guest record and a lost-write handoff are not reproducible here; the
 * wrapper's own fold and its publish effect are NOT mocked, which is the point.
 */
vi.mock("../../onboarding/use-guest-guided-onboarding-run", () => ({
  useGuestGuidedOnboardingRun: () => hostRunSources.guestRun,
}));
vi.mock("../../onboarding/use-guest-guided-onboarding-handoff", () => ({
  useGuestGuidedOnboardingHandoff: () => hostRunSources.handoffRun,
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  hostRunSources.guestRun = undefined;
  hostRunSources.handoffRun = undefined;
  stubLocalStorage();
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  setGuidedOnboardingRunOverride(undefined);
});

afterEach(() => {
  cleanup();
  setGuidedOnboardingRunOverride(undefined);
});

describe("the sidebar checklist card's run source", () => {
  it("is the server run while no override owns the modal", () => {
    renderSidebar();

    expect(screen.getByTestId(SERVER_TEST_ID)).toBeDefined();
  });

  it("becomes the relayed run once a host publishes one", () => {
    renderSidebar();

    act(() => setGuidedOnboardingRunOverride(stubRun()));

    expect(screen.getByTestId(RELAYED_TEST_ID)).toBeDefined();
  });

  it("returns to the server run when the override is released", () => {
    renderSidebar();
    act(() => setGuidedOnboardingRunOverride(stubRun()));

    act(() => setGuidedOnboardingRunOverride(undefined));

    expect(screen.getByTestId(SERVER_TEST_ID)).toBeDefined();
  });
});

/**
 * The PUBLISH half, which the cases above cannot see because each one writes the
 * store from the test body. Deleting the wrapper's publish effect leaves every
 * one of them green and puts the inert CTA back.
 */
describe("the desktop modal wrapper's publish into the relay", () => {
  it("hands the card the run the wrapper resolved, with nothing driving the store by hand", () => {
    const run = stubRun();
    hostRunSources.handoffRun = run;

    renderSidebar();

    expect(screen.getByTestId(RELAYED_TEST_ID)).toBeDefined();
    expect(getGuidedOnboardingRunOverride()).toBe(run);
  });

  it("leaves the card on the server run when the wrapper resolved none", () => {
    renderSidebar();

    expect(screen.getByTestId(SERVER_TEST_ID)).toBeDefined();
    expect(getGuidedOnboardingRunOverride()).toBeUndefined();
  });
});

describe("useGuidedOnboardingRunOverride", () => {
  it("publishes the run identity the host set, not a copy of it", () => {
    const run = stubRun();
    let seen: GuidedOnboardingRun | undefined;
    function Reader() {
      seen = useGuidedOnboardingRunOverride();
      return null;
    }
    render(<Reader />);

    act(() => setGuidedOnboardingRunOverride(run));

    expect(seen).toBe(run);
  });
});

function stubRun(): GuidedOnboardingRun {
  return {
    isLoading: false,
    postTransition: () => undefined,
    snapshot: null,
  };
}

function renderSidebar() {
  const memoryNav = createMemoryNavigation({ initialPath: "/dashboard" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <SidebarProvider>
            <Sidebar activeNav={NavId.Dashboard} />
          </SidebarProvider>
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}
