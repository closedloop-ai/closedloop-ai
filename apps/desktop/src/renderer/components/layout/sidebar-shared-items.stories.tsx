import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
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
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { GETTING_STARTED_STEP_CONTENT } from "@repo/app/onboarding/components/getting-started-card-shell";
import { guidedOnboardingKeys } from "@repo/app/onboarding/hooks/use-guided-onboarding";
import type { GuidedOnboardingRun } from "@repo/app/onboarding/lib/guided-onboarding-run";
import type { SessionLimits } from "@repo/app/session-limits/types";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { LayoutDashboardIcon, ListIcon } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import { DesktopFeatureFlagProvider } from "../../feature-flags/desktop-feature-flag-provider";
import { DesktopAuthProvider } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  clearGuidedOnboardingRunOverride,
  setGuidedOnboardingRunOverride,
} from "../onboarding/guided-onboarding-run-override-store";
import { assertTextAbsent, waitForText } from "../story-text-assertions";
import {
  DesktopSidebarFooterItems,
  SidebarMacDragStrip,
  useDesktopSidebarSearch,
} from "./sidebar-shared-items";

/**
 * The v2 arm passes `text-sm` because `SidebarMenuButton` bases at `text-base`,
 * which is one size too large beside the v2 nav rows. The legacy arm passes
 * nothing. Declared above the meta, which reads it while this module evaluates.
 */
const V2_INVITE_CLASS = "text-sm";
/** The control's key for "no class", which `mapping` resolves to `undefined`. */
const LEGACY_INVITE_KEY = "default";

/**
 * ISS-9734 / PLN-2016 D7: the pieces of desktop sidebar chrome that BOTH the
 * legacy tree and the shell-sidebar-v2 tree render, extracted so a rollback
 * stays a flag flip and the two arms cannot drift.
 *
 * Every export here is a small piece of a bigger column, so the canvases put it
 * in the one place it ships: a sidebar-width column on the sidebar's own
 * background. Sidebar chrome that looks balanced at page width can still wrap
 * or clip at 16rem, which is the only width it ever renders at.
 *
 * Auth, platform and the session-limits snapshot all arrive over the preload
 * bridge, so each story installs a stub bridge instead of mocking hooks (a story
 * cannot `vi.mock`). The stub is installed during render and RESTORED on unmount
 * — the Storybook sweep mounts every story into one shared jsdom, and a partial
 * `window.desktopApi` left behind changes what shared code does three packages
 * away (see `sidebar-account-footer.stories.tsx`, which learned this the hard
 * way).
 */
const meta = {
  title: "Composites v1.0/Desktop Shell/Sidebar Shared Items",
  tags: ["deprecated"],
  component: DesktopSidebarFooterItems,
  parameters: { layout: "centered" },
  args: { inviteClassName: V2_INVITE_CLASS },
  argTypes: {
    inviteClassName: {
      control: {
        type: "inline-radio",
        labels: {
          [LEGACY_INVITE_KEY]: "Default (legacy arm)",
          [V2_INVITE_CLASS]: "text-sm (v2 arm)",
        },
      },
      // The only two values a real arm passes. `default` stands for "no class",
      // which is `undefined`, and `undefined` cannot ride a URL.
      options: [LEGACY_INVITE_KEY, V2_INVITE_CLASS],
      mapping: { [LEGACY_INVITE_KEY]: undefined },
    },
  },
};

export default meta;

/** What the Controls panel edits, once `mapping` has swapped the key for the value. */
type FooterArgs = { inviteClassName: string | undefined };

type PlayContext = { args: FooterArgs; canvasElement: HTMLElement };

/**
 * No controls: `SidebarMacDragStrip` takes no props and `useDesktopSidebarSearch`
 * takes no arguments. Their scenario (the bridge platform, the seeded URL) is a
 * named story each, and the panel is off so no footer control implies otherwise.
 */
const NO_CONTROLS = { controls: { disable: true } };

const INVITE_LABEL = "Invite your team";
/** Body copy of the real `InviteTeamDialog`, which only a signed-in press opens. */
const INVITE_DIALOG_BODY = "Invite teammates by email";
/** The pending step a signed-out desktop's Getting started module offers. */
const GUEST_ACCOUNT_STEP =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.CreateAccount].label;
const SESSION_LABEL = "Current session";
const WEEK_LABEL = "Current week";
const INVITE_TEAMMATES_STEP = "Invite teammates";

const STORY_ORG_ID = "org_test";
const STORY_USER_ID = "user_test";

/**
 * The shell as it actually mounts the footer: signed in, with the invite entry
 * at the v2 type size. With the session-limits toggle off and onboarding
 * complete, the invite entry is the whole footer.
 */
export const SignedIn = {
  parameters: { appCore: { queryData: onboardingCache() } },
  render: (args: FooterArgs) =>
    footerStage({ fixture: { signedIn: true }, ...args }),
  play: async ({ args, canvasElement }: PlayContext) => {
    await waitForText(canvasElement, INVITE_LABEL);
    assertInviteSize(canvasElement, args.inviteClassName);
    assertTextAbsent(canvasElement, SESSION_LABEL);
    assertTextAbsent(canvasElement, INVITE_TEAMMATES_STEP);
    // A signed-in press opens the real invite dialog, because there is an
    // organization to invite people into.
    pressButton(canvasElement, INVITE_LABEL);
    await waitForDocumentText(INVITE_DIALOG_BODY);
    await dismissDialog();
  },
};

/**
 * What a GUEST gets in the same footer (ISS-10942). Not the invite entry: a
 * guest has no organization to invite anyone into, so the row that used to
 * stand here was a signup door wearing an invite label. The Getting started
 * module replaced it, carrying `Create account` as its pending step. Its press
 * resumes the guest run at the Account step (ISS-11480); the run is the one the
 * guided-onboarding host publishes, which this stage does not mount, so the
 * story publishes a recording stand-in.
 */
export const Guest = {
  parameters: { appCore: { queryData: onboardingCache() } },
  render: (args: FooterArgs) => (
    <PublishedGuestRun>
      {footerStage({ fixture: { signedIn: false }, ...args })}
    </PublishedGuestRun>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    postedGuestEvents = [];
    await waitForText(canvasElement, GUEST_ACCOUNT_STEP);
    // The invite entry is GONE for a guest, not merely relabelled.
    assertTextAbsent(canvasElement, INVITE_LABEL);
    pressButton(canvasElement, GUEST_ACCOUNT_STEP);
    const posted = postedGuestEvents.at(-1);
    if (
      posted?.type !== OnboardingEvent.ResumePendingStep ||
      posted.step !== PendingOnboardingStep.CreateAccount
    ) {
      throw new Error("the press did not resume the guest run's Account step");
    }
    assertDocumentTextAbsent(INVITE_DIALOG_BODY);
  },
};

/**
 * The legacy arm's footer, with no `inviteClassName`: the invite entry keeps the
 * `SidebarMenuButton` default type size. The off tree stays byte-identical while
 * the rollout key is closed, which is why the class is a parameter rather than a
 * new default.
 */
export const LegacyInviteSize = {
  args: { inviteClassName: LEGACY_INVITE_KEY },
  parameters: { appCore: { queryData: onboardingCache() } },
  render: (args: FooterArgs) =>
    footerStage({ fixture: { signedIn: true }, ...args }),
  play: async ({ args, canvasElement }: PlayContext) => {
    await waitForText(canvasElement, INVITE_LABEL);
    // The arg is the scenario. It starts as "no class", so the v2 size must be
    // absent, and it stays true if the Controls panel or a deep link flips it.
    assertInviteSize(canvasElement, args.inviteClassName);
  },
};

/**
 * Behind the `subscriptionSessionLimits` Labs toggle (PRD-538, closed by
 * default) with a live usage snapshot: the two primary bars sit above the
 * invite entry.
 */
export const SessionLimitsOn = {
  parameters: { appCore: { queryData: onboardingCache() } },
  render: (args: FooterArgs) =>
    footerStage({
      fixture: {
        openFlags: [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY],
        sessionLimits: usageSnapshot(),
        signedIn: true,
      },
      ...args,
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, SESSION_LABEL);
    await waitForText(canvasElement, WEEK_LABEL);
    await waitForText(canvasElement, INVITE_LABEL);
  },
};

/**
 * Toggle on, but the main process has no snapshot to serve. The footer draws
 * nothing rather than a bar, because an empty bar is pixel-identical to a
 * measured 0% and PRD-538 R6 forbids that lie. On a default macOS install this
 * is the expected outcome, not a failure: capture never reads the Keychain, so a
 * Keychain-only Claude sign-in legitimately has no snapshot.
 */
export const SessionLimitsOnWithoutSnapshot = {
  parameters: { appCore: { queryData: onboardingCache() } },
  render: (args: FooterArgs) =>
    footerStage({
      fixture: {
        deferSessionLimits: true,
        openFlags: [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY],
        signedIn: true,
      },
      ...args,
    }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, INVITE_LABEL);
    // The read is held open by the fixture, so the footer is provably still
    // reading: the skeleton is what a PENDING snapshot draws.
    await waitForSnapshotPending(canvasElement);
    await deliverSessionLimits(null);
    // Only now is an absence evidence. The skeleton going is the footer saying
    // the read landed, so nothing here is timed against a guess about how long
    // that takes — a wrongly painted 0% bar cannot slip in after the assertion.
    await waitForSnapshotSettled(canvasElement);
    assertTextAbsent(canvasElement, SESSION_LABEL);
    assertTextAbsent(canvasElement, WEEK_LABEL);
  },
};

/**
 * ISS-8353: the guided-onboarding recovery card sits between the session-limits
 * summary and the invite entry in BOTH footers. Seeded here with a run whose
 * only remaining step is inviting the team, so the card and the invite entry are
 * visible together and their order can be read.
 */
export const GuidedCardPending = {
  parameters: {
    appCore: { queryData: onboardingCache({ teamInvited: false }) },
  },
  render: (args: FooterArgs) =>
    footerStage({ fixture: { signedIn: true }, ...args }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, INVITE_TEAMMATES_STEP);
    await waitForText(canvasElement, INVITE_LABEL);
  },
};

/**
 * Realistic use: every slot filled, in the column it ships in. Nav rows above,
 * then the footer run — session limits, the guided card, the invite entry — in
 * the order the footer states once for both arms.
 */
export const InSidebarColumn = {
  parameters: {
    appCore: { queryData: onboardingCache({ teamInvited: false }) },
  },
  render: (args: FooterArgs) => (
    <Stage
      fixture={{
        openFlags: [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY],
        sessionLimits: usageSnapshot(),
        signedIn: true,
      }}
    >
      <div className="flex h-[40rem] w-64 flex-col justify-between rounded-md bg-sidebar p-2 text-sidebar-foreground">
        <SidebarMenu className="gap-0">
          <NeighborRow icon={<LayoutDashboardIcon />} label="Dashboard" />
          <NeighborRow icon={<ListIcon />} label="Sessions" />
        </SidebarMenu>
        <div className="flex flex-col gap-2">
          <DesktopSidebarFooterItems inviteClassName={args.inviteClassName} />
        </div>
      </div>
    </Stage>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForText(canvasElement, SESSION_LABEL);
    await waitForText(canvasElement, INVITE_TEAMMATES_STEP);
    await waitForText(canvasElement, INVITE_LABEL);
  },
};

/**
 * macOS hides the native title bar, so the stoplight buttons overlay the top-left
 * of the window. The strip reserves a draggable band that clears them off the
 * first nav row and doubles as the window-move handle. It is an empty
 * `aria-hidden` div, so the canvas draws the stoplights it is reserving room for.
 */
export const MacDragStrip = {
  parameters: NO_CONTROLS,
  render: () => windowChromeStage({ platform: "darwin" }),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const strip = canvasElement.querySelector(DRAG_STRIP_SELECTOR);
    if (!strip) {
      throw new Error("the mac drag strip did not render");
    }
    if (strip.getAttribute("aria-hidden") !== "true") {
      throw new Error("the drag strip must be hidden from assistive tech");
    }
  },
};

/**
 * Off macOS there are no overlaid stoplights to clear, so the strip renders
 * nothing and the first nav row sits at the top of the column.
 */
export const NonMacNoDragStrip = {
  parameters: NO_CONTROLS,
  render: () => windowChromeStage({ platform: "linux" }),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => {
    if (canvasElement.querySelector(DRAG_STRIP_SELECTOR)) {
      throw new Error("a non-mac platform must not render the drag strip");
    }
  },
};

/**
 * The Sessions search control with nothing typed: an empty field, and no clear
 * affordance because there is nothing to clear.
 */
export const SearchEmpty = {
  parameters: NO_CONTROLS,
  render: () => searchStage("/sessions"),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForInput(canvasElement);
    if (searchInput(canvasElement)?.value !== "") {
      throw new Error("the search field should start empty");
    }
    assertNoClearButton(canvasElement);
  },
};

/**
 * Arriving on a `?search=` URL: the field is seeded from the query string, and
 * the clear affordance shows because there is a query to clear. This is the
 * state a copied Sessions link lands in.
 */
export const SearchWithQuery = {
  parameters: NO_CONTROLS,
  render: () => searchStage(`/sessions?search=${SEARCH_QUERY_PARAM}`),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForInput(canvasElement);
    if (searchInput(canvasElement)?.value !== SEARCH_QUERY) {
      throw new Error(`the search field should read "${SEARCH_QUERY}"`);
    }
    if (!findButtonByLabel(canvasElement, CLEAR_SEARCH_LABEL)) {
      throw new Error("a seeded query must show the clear affordance");
    }
  },
};

const DRAG_STRIP_SELECTOR = ".app-region-drag";
const CLEAR_SEARCH_LABEL = "Clear search";
const SEARCH_QUERY = "refactor auth middleware";
const SEARCH_QUERY_PARAM = "refactor%20auth%20middleware";
const POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 25;
/** The footer's own "still reading" affordance — `SessionLimitsLoading`. */
const SNAPSHOT_SKELETON = '[data-testid="session-limits-loading"]';

type Fixture = {
  /**
   * Hold the snapshot read open and let the PLAY answer it, instead of handing
   * back an already-settled promise. See {@link deliverSessionLimits}.
   */
  deferSessionLimits?: boolean;
  /** Flag keys the account's PostHog assignment turns on. */
  openFlags?: readonly string[];
  platform?: "darwin" | "linux";
  /** `undefined` keeps the bridge without the method, like an older preload. */
  sessionLimits?: SessionLimits | null;
  signedIn: boolean;
};

/**
 * A usage snapshot captured a minute ago, with reset times measured from now so
 * the relative labels stay meaningful and the stale caveat never fires.
 */
function usageSnapshot(): SessionLimits {
  const now = Date.now();
  const hoursFromNow = (hours: number) =>
    new Date(now + hours * 3_600_000).toISOString();
  return {
    extraUsage: {
      isEnabled: true,
      monthlyLimitUsd: 50,
      usedCreditsUsd: 8.25,
      utilization: 16.5,
    },
    fetchedAt: new Date(now - 60_000).toISOString(),
    fiveHour: { resetsAt: hoursFromNow(3), utilization: 42 },
    sevenDay: { resetsAt: hoursFromNow(72), utilization: 68 },
    sevenDayOpus: { resetsAt: hoursFromNow(72), utilization: 21 },
    sevenDaySonnet: { resetsAt: hoursFromNow(72), utilization: 55 },
    source: "usage_api",
  };
}

/**
 * A finished guided run by default, so the recovery card renders nothing and a
 * story that is not about it is not about it. Pass a context override to leave a
 * step pending. Seeded into the query cache under the same key the card reads,
 * which is how the shared card's own stories feed it.
 */
function onboardingCache(
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
) {
  return [
    [
      guidedOnboardingKeys.snapshot(
        OnboardingHost.Desktop,
        STORY_ORG_ID,
        STORY_USER_ID
      ),
      storyOnboardingSnapshot(context),
    ],
  ] as const;
}

function storyOnboardingSnapshot(
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-story",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
      ...context,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 3,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [
        OnboardingPhase.DashboardAvailable,
        OnboardingPhase.DashboardTour,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
}

/** What the Guest story's stand-in run was asked to do, newest last. */
let postedGuestEvents: OnboardingEventInput[] = [];

/**
 * Publishes a guest run the way `DesktopGuidedOnboardingDialogHost` does, and
 * withdraws it on unmount so it cannot outlive the story in the shared sweep.
 */
function PublishedGuestRun({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const run: GuidedOnboardingRun = {
      isLoading: false,
      postTransition: (_snapshot, event) => {
        postedGuestEvents.push(event);
      },
      snapshot: storyOnboardingSnapshot(),
    };
    setGuidedOnboardingRunOverride(run);
    return () => clearGuidedOnboardingRunOverride(run);
  }, []);
  return children;
}

/**
 * The real providers over a stubbed preload bridge, rather than mocked hooks:
 * `useGuestOnboarding` reads the auth status through the bridge, and
 * `isMacOS()` reads `desktopApi.platform`, so stubbing the bridge exercises the
 * same resolution path the packaged app takes.
 *
 * `platform` is always set, never left to the user-agent fallback: that fallback
 * would make the same story render a strip on a Mac and none on a Linux CI box.
 */
function installBridge({
  deferSessionLimits = false,
  openFlags = [],
  platform = "darwin",
  sessionLimits,
  signedIn,
}: Fixture): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      platform,
      getRuntimeStatus: () => Promise.resolve({ isPackaged: false }),
      getDesktopAuthState: () =>
        Promise.resolve(
          signedIn
            ? {
                status: DesktopAuthStatus.Authenticated,
                userId: STORY_USER_ID,
                organizationId: STORY_ORG_ID,
              }
            : {
                status: DesktopAuthStatus.SignedOut,
                userId: null,
                organizationId: null,
              }
        ),
      getDesktopFeatureFlags: () =>
        Promise.resolve({
          flags: Object.fromEntries(openFlags.map((key) => [key, true])),
          resolved: true,
          userId: STORY_USER_ID,
        }),
      ...sessionLimitsMember({ deferSessionLimits, sessionLimits }),
    },
    writable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, "desktopApi", original);
      return;
    }
    Reflect.deleteProperty(window, "desktopApi");
  };
}

/**
 * Installs the bridge for THIS story only and puts the global back on unmount.
 * Installed during render, not in an effect: a parent's effects run after its
 * children's, and the auth provider reads the bridge in its own mount effect.
 * The restore is load-bearing — see the file comment.
 */
function Stage({
  children,
  fixture,
}: {
  children: ReactNode;
  fixture: Fixture;
}) {
  const restore = useRef<(() => void) | null>(null);
  if (restore.current === null) {
    restore.current = installBridge(fixture);
  }
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    []
  );

  // No app-core wrapper on purpose (ISS-5697): the QueryClient, auth and API
  // ports come from the ONE `AppCoreStoryProviders` the preview mounts, and
  // `DesktopAppCoreProvider` must never be reintroduced here — it caches its
  // QueryClients module-globally, so they would outlive the story.
  //
  // `DesktopFeatureFlagProvider` IS mounted (#7680, whitlockk): the gated footer
  // reads the flag port, and the preview's static adapter would answer for it —
  // so a Desktop assignment that never resolves would still render the enabled
  // state here. Seeding `getDesktopFeatureFlags` on the bridge instead puts the
  // real desktop resolution path under the story.
  return (
    <DesktopAuthProvider>
      <DesktopFeatureFlagProvider>
        <SidebarProvider className="min-h-0 w-auto">{children}</SidebarProvider>
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}

function footerStage({
  fixture,
  inviteClassName,
}: {
  fixture: Fixture;
  inviteClassName?: string;
}): ReactNode {
  return (
    <Stage fixture={fixture}>
      <div className="flex w-64 flex-col gap-2 rounded-md bg-sidebar p-2 text-sidebar-foreground">
        <DesktopSidebarFooterItems inviteClassName={inviteClassName} />
      </div>
    </Stage>
  );
}

function NeighborRow({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton className="text-sm">
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The strip beside what it reserves room for: the stoplights macOS overlays on
 * the window's top-left, and the first nav row they must clear. The lights are
 * drawn by the story, not the component, so the reserved band can be seen.
 */
function windowChromeStage({
  platform,
}: {
  platform: "darwin" | "linux";
}): ReactNode {
  return (
    <Stage fixture={{ platform, signedIn: true }}>
      <div className="relative w-64 rounded-md border border-dashed bg-sidebar p-2 text-sidebar-foreground">
        {platform === "darwin" ? (
          <div
            aria-hidden="true"
            className="absolute top-2.5 left-3 flex gap-2"
          >
            <span className="size-3 rounded-full bg-red-500" />
            <span className="size-3 rounded-full bg-yellow-500" />
            <span className="size-3 rounded-full bg-green-500" />
          </div>
        ) : null}
        <SidebarMacDragStrip />
        <SidebarMenu className="gap-0">
          <NeighborRow icon={<LayoutDashboardIcon />} label="Dashboard" />
          <NeighborRow icon={<ListIcon />} label="Sessions" />
        </SidebarMenu>
      </div>
    </Stage>
  );
}

/**
 * `useDesktopSidebarSearch` is a hook that returns a node, so a story mounts it
 * through a one-line component. Its own memory navigation, nested under the
 * preview's, is what lets each story choose the URL it starts on: the preview's
 * adapter is shared by every story, so seeding a query there would leak.
 */
function SidebarSearchControl() {
  return <>{useDesktopSidebarSearch()}</>;
}

function searchStage(initialPath: string): ReactNode {
  return <SearchStage initialPath={initialPath} />;
}

function SearchStage({ initialPath }: { initialPath: string }) {
  const [navigation] = useState(() => createMemoryNavigation({ initialPath }));
  return (
    <Stage fixture={{ signedIn: true }}>
      <NavigationProvider adapter={navigation.adapter}>
        <div className="w-64 rounded-md bg-sidebar p-2 text-sidebar-foreground">
          <SidebarSearchControl />
        </div>
      </NavigationProvider>
    </Stage>
  );
}

function searchInput(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('input[aria-label="Search"]');
}

/**
 * The invite button carries the v2 type size exactly when `inviteClassName` is
 * that class. Reading the arg keeps the check true when a control flips it, and
 * it fails if the footer stops passing the prop through.
 */
function assertInviteSize(
  root: HTMLElement,
  inviteClassName: string | undefined
): void {
  const button = findButton(root, INVITE_LABEL);
  const carriesV2Size = button?.classList.contains(V2_INVITE_CLASS) ?? false;
  if (carriesV2Size !== (inviteClassName === V2_INVITE_CLASS)) {
    throw new Error(
      `the footer's type size must follow inviteClassName, which is ${inviteClassName ?? "unset"}`
    );
  }
}

function findButton(root: ParentNode, name: string): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>("button")).find(
      (element) => element.textContent?.trim() === name
    ) ?? null
  );
}

function findButtonByLabel(
  root: ParentNode,
  label: string
): HTMLElement | null {
  return root.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
}

function assertNoClearButton(root: HTMLElement): void {
  if (findButtonByLabel(root, CLEAR_SEARCH_LABEL)) {
    throw new Error("an empty search must not offer a clear affordance");
  }
}

function pressButton(root: ParentNode, name: string): void {
  const button = findButton(root, name);
  if (!button) {
    throw new Error(`No button labelled "${name}" in this story canvas`);
  }
  button.click();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForInput(root: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (searchInput(root)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("the search field never rendered");
}

/**
 * Dialogs portal to `document.body`, outside the story canvas, so their copy is
 * read from the document rather than from `canvasElement`.
 */
async function waitForDocumentText(text: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (document.body.textContent?.includes(text)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`"${text}" never appeared in the document`);
}

function assertDocumentTextAbsent(text: string): void {
  if (document.body.textContent?.includes(text)) {
    throw new Error(`"${text}" must not appear in the document`);
  }
}

/**
 * Closes the open Radix dialog in the story rather than leaving it for teardown:
 * a layer still mounted when the next story runs is what the sweep's DOM-cleanup
 * rules exist to prevent.
 */
async function dismissDialog(): Promise<void> {
  const dialog = document.querySelector('[role="dialog"]');
  const close = dialog
    ? Array.from(dialog.querySelectorAll<HTMLElement>("button")).find(
        (element) => DISMISS_LABELS.includes(element.textContent?.trim() ?? "")
      )
    : null;
  if (!close) {
    throw new Error("the open dialog has no Close control");
  }
  close.click();
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (!document.querySelector('[role="dialog"]')) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("the dialog did not close");
}

const DISMISS_LABELS = ["Close"];

/**
 * Which `getSessionLimits` the stubbed bridge carries, if any.
 *
 * `undefined` leaves the member off entirely, like an older preload. A deferred
 * read is held open until {@link deliverSessionLimits} answers it; anything else
 * resolves immediately, which is what a story about a rendered snapshot wants.
 */
function sessionLimitsMember({
  deferSessionLimits,
  sessionLimits,
}: Pick<Fixture, "deferSessionLimits" | "sessionLimits">): {
  getSessionLimits?: () => Promise<SessionLimits | null>;
} {
  if (deferSessionLimits) {
    return { getSessionLimits: openSnapshotRead() };
  }
  if (sessionLimits === undefined) {
    return {};
  }
  return { getSessionLimits: () => Promise.resolve(sessionLimits) };
}

/**
 * The snapshot read a `deferSessionLimits` story is holding open.
 *
 * A module slot rather than a prop: a `play` is handed the canvas and the args,
 * never the fixture, and the bridge install is the only writer — it runs exactly
 * once per mount, from the stage's render, before any play can reach it.
 */
let answerSnapshotRead: ((snapshot: SessionLimits | null) => void) | null =
  null;
let snapshotRead: Promise<SessionLimits | null> | null = null;

/**
 * A `getSessionLimits` that does not answer until the play says so.
 *
 * The story this serves asserts an ABSENCE, and an absence only means anything
 * once the read it depends on has actually happened. Timing that with a fixed
 * wait times it against a guess at how long the read takes, so on a loaded
 * runner the assertion can run first and a footer that wrongly painted a 0% bar
 * for a null snapshot — the PRD-538 R6 lie the story exists to catch — would
 * pass it green. Holding the read open makes the wait causal instead.
 */
function openSnapshotRead(): () => Promise<SessionLimits | null> {
  const pending = new Promise<SessionLimits | null>((resolve) => {
    answerSnapshotRead = resolve;
  });
  snapshotRead = pending;
  return () => pending;
}

/** Answer the held-open read from a play. */
async function deliverSessionLimits(
  snapshot: SessionLimits | null
): Promise<void> {
  if (!(answerSnapshotRead && snapshotRead)) {
    throw new Error("no deferred session-limits read is open");
  }
  answerSnapshotRead(snapshot);
  await snapshotRead;
}

/** Wait until the footer is visibly reading the snapshot. */
async function waitForSnapshotPending(root: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (root.querySelector(SNAPSHOT_SKELETON)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("the session-limits skeleton never rendered");
}

/** Wait until the read has landed and the footer has rendered its answer. */
async function waitForSnapshotSettled(root: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (!root.querySelector(SNAPSHOT_SKELETON)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("the session-limits skeleton never cleared");
}
