import {
  SidebarInset,
  SidebarProvider,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import {
  NavigationActorStanding,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
} from "@repo/api/src/types/navigation-view-model";
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
import { guidedOnboardingKeys } from "@repo/app/onboarding/hooks/use-guided-onboarding";
import type { SessionLimits } from "@repo/app/session-limits/types";
import { SHELL_NAVIGATION_ITEMS } from "@repo/app/shared/lib/shell-navigation-contract";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { type ReactNode, useEffect, useRef } from "react";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../../shared/desktop-docs-help-flag";
import { DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags";
import {
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
} from "../../../../shared/feature-flags-labs-detail";
import { DesktopFeatureFlagProvider } from "../../../feature-flags/desktop-feature-flag-provider";
import { hrefForNavId, NavId } from "../../../navigation/route-table";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { assertTextAbsent, waitForText } from "../../story-text-assertions";
import { DesktopShellSidebar } from "./desktop-shell-sidebar";

/**
 * ISS-9734 (PLN-2016 M3): the desktop mount of the shared v2 `ShellSidebar`, on
 * the tree that ships behind the `shell-sidebar-v2` rollout key.
 *
 * The hierarchy is NOT decided here. The shared contract orders and groups the
 * rows, the desktop adapter answers four narrow questions (which surface, what a
 * route resolves to, whether a gate is open, whether a control is offered), and
 * the cloud navigation projection says what the actor may reach. So the states
 * worth seeing are the ones those inputs produce: which gates are open, what the
 * projection said, and who is signed in.
 *
 * Everything arrives through the real providers over a stubbed preload bridge,
 * because a story cannot `vi.mock`. The desktop flag assignment comes through
 * `getDesktopFeatureFlags` (the only flag source since ISS-8753), the navigation
 * projection through the shared story API transport, and identity and auth
 * through their own bridge members. The bridge is installed during render and
 * RESTORED on unmount, for the reason `sidebar-account-footer.stories.tsx`
 * documents: the Storybook sweep shares one jsdom across every story.
 *
 * `layout: "fullscreen"` because `Sidebar` pins itself to the viewport's left
 * edge; a centered canvas would make it float over nothing.
 *
 * The component takes two props, `activeNav` and `hiddenNavIds`, and both are
 * live controls. Both pick from every `NavId`, which is the closed set the
 * route table defines, so no option can be an id the sidebar does not know.
 * Settings and Diagnostics have no sidebar row, so choosing either lights nothing;
 * a row inside Labs lights only while its gate is open (see `LabsOpen`).
 *
 * No controls: the projection state, flag assignment, sign-in and session limits
 * are stage fixtures on a stubbed bridge, not props, so each is a named story.
 *
 * No `@storybook/*` import and no `fn()`: `apps/desktop` does not depend on the
 * Storybook packages (`apps/storybook/AGENTS.md`), and plain `args` and
 * `argTypes` objects need neither.
 */
const meta = {
  title: "Composites v1.0/Desktop Shell/Desktop Shell Sidebar",
  tags: ["deprecated"],
  component: DesktopShellSidebar,
  parameters: { layout: "fullscreen" },
  args: { activeNav: NavId.Dashboard, hiddenNavIds: [] },
  argTypes: {
    activeNav: { control: "select", options: Object.values(NavId) },
    hiddenNavIds: {
      control: "multi-select",
      options: Object.values(NavId),
      // Docgen resolves `readonly NavId[]` to `other`, and Storybook refuses to
      // read an `other` arg out of the URL, so a deep link to a hidden row would
      // be dropped without a word. Stating the array type is what lets it in.
      type: { name: "array", value: { name: "string" } },
    },
  },
};

export default meta;

/** What the Controls panel edits, and what every story below hands the sidebar. */
type SidebarArgs = {
  activeNav: NavId;
  hiddenNavIds: readonly NavId[];
};

type PlayContext = { args: SidebarArgs; canvasElement: HTMLElement };

/**
 * No controls for `activeNav` on the two projection stories: while the read is
 * unsettled every row is an inert button, so no row can light. `hiddenNavIds`
 * still applies, since a hidden row is absent either way.
 */
const ACTIVE_NAV_INERT = { controls: { exclude: ["activeNav"] } };

// Declared before the stories on purpose: each story's `parameters` is computed
// while this module evaluates, so anything `stageParameters()` reads has to
// exist by then.
const ORG_NAME = "Northwind Engineering";
const GUEST_LABEL = "Guest";
const LABS_LABEL = "Labs";
const STORY_ORG_ID = "org_test";
const STORY_USER_ID = "user_test";
const POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 25;

/** The container gate plus every per-item gate the Labs section holds. */
const LABS_FLAGS: readonly string[] = [
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY,
];

/** The rows that live outside Labs, which the default desktop shape shows. */
const PRIMARY_ROWS: readonly NavId[] = [
  NavId.Dashboard,
  NavId.Sessions,
  NavId.Branches,
];

/** The two rows Labs holds behind its per-item gates. */
const LABS_ROWS: readonly NavId[] = [NavId.Agents, NavId.Help];

const Projection = {
  Loading: "loading",
  Ready: "ready",
  Refused: "refused",
} as const;
type Projection = (typeof Projection)[keyof typeof Projection];

/**
 * Labs ships closed, so the default desktop shape is the three rows that live
 * outside it: Branches, Dashboard and Sessions. Agents and Help
 * both sit inside Labs and are absent, along with the Labs section itself.
 */
export const Default = {
  parameters: stageParameters(),
  render: (args: SidebarArgs) => stage(args),
  play: async ({ args, canvasElement }: PlayContext) => {
    await waitForText(canvasElement, ORG_NAME);
    await expectRows(canvasElement, PRIMARY_ROWS, args.hiddenNavIds);
    assertNoNavLink(canvasElement, NavId.Agents);
    assertTextAbsent(canvasElement, LABS_LABEL);
  },
};

/**
 * The open route lights its row. `activeNav` is the CANONICAL nav id, so a
 * session detail and a route-table alias light the row they light today rather
 * than whichever raw hash the URL happens to hold.
 */
export const ActiveSessions = {
  args: { activeNav: NavId.Sessions },
  parameters: stageParameters(),
  render: (args: SidebarArgs) => stage(args),
  play: async ({ args, canvasElement }: PlayContext) => {
    // Settled first: the primary rows only become links once the projection
    // answers, and an absence checked before that would pass on nothing.
    await expectRows(canvasElement, PRIMARY_ROWS, args.hiddenNavIds);
    assertActiveRow(canvasElement, args.activeNav);
  },
};

/**
 * Every Labs gate open: the container and the per-item flags for Agents and
 * Help. Labs is one collapsible section, so the play
 * opens it. It reads the section's CURRENT state first because open state is
 * persisted (PLN-2016 D9): a section an earlier story left open would be closed
 * by a blind click.
 */
export const LabsOpen = {
  parameters: stageParameters(),
  render: (args: SidebarArgs) => stage({ ...args, openFlags: LABS_FLAGS }),
  play: async ({ args, canvasElement }: PlayContext) => {
    await waitForText(canvasElement, LABS_LABEL);
    await ensureLabsExpanded(canvasElement);
    await expectRows(canvasElement, LABS_ROWS, args.hiddenNavIds);
  },
};

/**
 * `hiddenNavIds` is `App.tsx`'s already-resolved list, and it wins over an open
 * gate: a row whose nav id is hidden is not offered at all, so it is neither
 * rendered nor requested from the projection. Here Help is hidden inside an
 * otherwise fully open Labs.
 */
export const LabsWithHiddenRows = {
  args: { hiddenNavIds: [NavId.Help] },
  parameters: stageParameters(),
  render: (args: SidebarArgs) => stage({ ...args, openFlags: LABS_FLAGS }),
  play: async ({ args, canvasElement }: PlayContext) => {
    await waitForText(canvasElement, LABS_LABEL);
    await ensureLabsExpanded(canvasElement);
    await expectRows(canvasElement, LABS_ROWS, args.hiddenNavIds);
  },
};

/**
 * The projection read is still in flight. Every row is offered but not yet
 * navigable, and says so in words: a `Loading` state word rather than a greyed
 * row, because a colour or opacity change alone reads identically to
 * "unavailable" for anyone who cannot compare two shades (WCAG 1.4.1).
 */
export const ProjectionLoading = {
  parameters: {
    ...stageParameters({ projection: Projection.Loading }),
    ...ACTIVE_NAV_INERT,
  },
  render: (args: SidebarArgs) => stage(args),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForRowState(canvasElement, NavId.Dashboard, "Loading");
    assertNoNavLink(canvasElement, NavId.Dashboard);
  },
};

/**
 * The cloud refused the read, as an API that predates the route or an outage
 * does. ISS-8377's accepted contract: a failed read never GRANTS a destination
 * and never removes one either. The rows stay, announced as `Unavailable` and
 * inert (`aria-disabled`, still focusable), so the user can find them and knows
 * why they do nothing.
 */
export const ProjectionUnavailable = {
  parameters: {
    ...stageParameters({ projection: Projection.Refused }),
    ...ACTIVE_NAV_INERT,
  },
  render: (args: SidebarArgs) => stage(args),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // `waitForRowState` only matches an `aria-disabled` row, so finding the
    // Dashboard row this way IS the assertion that the row stayed inert.
    await waitForRowState(canvasElement, NavId.Dashboard, "Unavailable");
    assertNoNavLink(canvasElement, NavId.Dashboard);
  },
};

/**
 * A signed-out guest. No account means no PostHog assignment, so every gate
 * settles CLOSED and Labs never appears; the workspace header reads as a guest
 * rather than naming an organization. The footer's invite entry is the guest
 * variant, which asks for an account instead of opening the invite dialog.
 */
export const Guest = {
  parameters: stageParameters(),
  render: (args: SidebarArgs) => stage({ ...args, signedIn: false }),
  play: async ({ args, canvasElement }: PlayContext) => {
    await expectRows(canvasElement, PRIMARY_ROWS, args.hiddenNavIds);
    // The header says so in a word, not just by omission: the same absence
    // would pass on a header that failed to render at all.
    await waitForText(canvasElement, GUEST_LABEL);
    assertTextAbsent(canvasElement, ORG_NAME);
    assertTextAbsent(canvasElement, LABS_LABEL);
  },
};

/**
 * Realistic use: the sidebar in a macOS window, with everything a busy account
 * shows at once. The stoplights macOS overlays on the top-left are drawn by the
 * story so the reserved drag strip is legible; Labs is open; the session-limits
 * summary, the guided-onboarding card and the invite entry stack in the footer.
 */
export const InDesktopWindow = {
  args: { activeNav: NavId.Sessions },
  parameters: stageParameters({ onboardingPending: true }),
  render: (args: SidebarArgs) =>
    stage({
      ...args,
      openFlags: [
        ...LABS_FLAGS,
        DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY,
      ],
      sessionLimits: usageSnapshot(),
      windowContent: true,
    }),
  play: async ({ args, canvasElement }: PlayContext) => {
    await waitForText(canvasElement, ORG_NAME);
    await waitForText(canvasElement, "Current session");
    await waitForText(canvasElement, "Invite teammates");
    await ensureLabsExpanded(canvasElement);
    await expectRows(canvasElement, [NavId.Agents], args.hiddenNavIds);
  },
};

type Fixture = {
  /** Flag keys the account's PostHog assignment turns on. */
  openFlags?: readonly string[];
  sessionLimits?: SessionLimits | null;
  signedIn: boolean;
};

/**
 * What the cloud answers for the destinations the host offered: every one Ready,
 * for a member. The set comes from the request, not from this file, so it moves
 * with the shared contract and the gates rather than being restated here.
 */
function readyProjection(destinationIds: readonly string[]) {
  return {
    destinations: Object.fromEntries(
      destinationIds.map((id) => [
        id,
        { status: NavigationDestinationStatus.Ready },
      ])
    ),
    organizationId: STORY_ORG_ID,
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
  };
}

function projectionRoute(projection: Projection): FixtureRoute {
  const base = { method: "GET", path: "/navigation/view-model" };
  switch (projection) {
    case Projection.Loading:
      // Never settles: the row states are read off a query that stays pending.
      return { ...base, respond: () => new Promise(() => undefined) };
    case Projection.Refused:
      return {
        ...base,
        error: "Service unavailable",
        respond: () => null,
        status: 503,
      };
    default:
      return {
        ...base,
        respond: ({ searchParams }) =>
          readyProjection(searchParams.getAll("destinations")),
      };
  }
}

function stageParameters({
  onboardingPending = false,
  projection = Projection.Ready,
}: {
  onboardingPending?: boolean;
  projection?: Projection;
} = {}) {
  return {
    appCore: {
      apiRoutes: [projectionRoute(projection)],
      queryData: onboardingCache(
        onboardingPending ? { teamInvited: false } : {}
      ),
    },
    layout: "fullscreen",
  };
}

/**
 * A finished guided run unless a step is left pending, so the footer's recovery
 * card renders nothing in a story that is not about it. Seeded into the cache
 * under the key the card reads, the way the card's own stories feed it.
 */
function onboardingCache(
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
) {
  const snapshot: GuidedOnboardingSnapshot = {
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
  return [
    [
      guidedOnboardingKeys.snapshot(
        OnboardingHost.Desktop,
        STORY_ORG_ID,
        STORY_USER_ID
      ),
      snapshot,
    ],
  ] as const;
}

/** A usage snapshot from a minute ago, with resets measured from now. */
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
 * `platform` is always `darwin`: the v2 sidebar is mounted with the mac drag
 * strip as its `leading` slot, and the strip is what a Mac window needs. Left to
 * the user-agent fallback the same story would differ between a Mac and CI.
 */
function installBridge({
  openFlags = [],
  sessionLimits,
  signedIn,
}: Fixture): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      platform: "darwin",
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
      getDesktopIdentity: () =>
        Promise.resolve(
          signedIn
            ? {
                email: "ada@northwind.dev",
                name: "Ada Lovelace",
                organizationName: ORG_NAME,
              }
            : null
        ),
      getDesktopFeatureFlags: () =>
        Promise.resolve({
          flags: Object.fromEntries(openFlags.map((key) => [key, true])),
          resolved: true,
          userId: STORY_USER_ID,
        }),
      ...(sessionLimits === undefined
        ? {}
        : { getSessionLimits: () => Promise.resolve(sessionLimits) }),
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
 * Both halves are load-bearing: it installs during render because
 * `DesktopFeatureFlagProvider` and the auth provider read the bridge in their own
 * mount effects, which run before a parent's; and it restores because the sweep
 * shares one jsdom, where a partial `window.desktopApi` left behind changes what
 * shared code does in an unrelated story.
 */
function SidebarStage({
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
  // ports come from the ONE `AppCoreStoryProviders` the preview mounts.
  // `DesktopAppCoreProvider` must not be reintroduced — it caches its
  // QueryClients module-globally, so they would outlive the story.
  return (
    <DesktopAuthProvider>
      <DesktopFeatureFlagProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}

function stage({
  activeNav,
  hiddenNavIds,
  openFlags,
  sessionLimits,
  signedIn = true,
  windowContent = false,
}: SidebarArgs & {
  openFlags?: readonly string[];
  sessionLimits?: SessionLimits | null;
  signedIn?: boolean;
  windowContent?: boolean;
}): ReactNode {
  return (
    <SidebarStage fixture={{ openFlags, sessionLimits, signedIn }}>
      <DesktopShellSidebar activeNav={activeNav} hiddenNavIds={hiddenNavIds} />
      {windowContent ? <WindowContent /> : null}
    </SidebarStage>
  );
}

/**
 * The page the sidebar sits beside, plus the stoplights macOS draws over the
 * window's top-left. Neither belongs to the component; they are here so the
 * inset card, the reserved drag strip and the first nav row can be judged
 * against what they really share the window with.
 */
function WindowContent() {
  return (
    <>
      <div aria-hidden="true" className="fixed top-3 left-4 z-50 flex gap-2">
        <span className="size-3 rounded-full bg-red-500" />
        <span className="size-3 rounded-full bg-yellow-500" />
        <span className="size-3 rounded-full bg-green-500" />
      </div>
      <SidebarInset>
        <div className="flex flex-col gap-3 p-6">
          <h1 className="font-semibold text-xl">Sessions</h1>
          <ul className="flex flex-col gap-2 text-sm">
            <li>Refactor auth middleware, finished 12 minutes ago</li>
            <li>
              Migrate billing webhooks to the queue, running for 41 minutes
            </li>
            <li>Fix flaky checkout e2e spec, waiting on you</li>
          </ul>
        </div>
      </SidebarInset>
    </>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findNavLink(root: HTMLElement, navId: NavId): HTMLElement | null {
  return root.querySelector<HTMLElement>(`a[href="${hrefForNavId(navId)}"]`);
}

/**
 * Wait for a row to be a real link, which is what tells a settled projection
 * from the pending and refused ones: those rows exist too, but as inert buttons.
 */
async function waitForNavLink(root: HTMLElement, navId: NavId): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (findNavLink(root, navId)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`no link to ${hrefForNavId(navId)} ever rendered`);
}

function assertNoNavLink(root: HTMLElement, navId: NavId): void {
  if (findNavLink(root, navId)) {
    throw new Error(`${hrefForNavId(navId)} must not be a link in this state`);
  }
}

/**
 * The plays read `hiddenNavIds` from args, so they stay true when the Controls
 * panel or a deep link changes it: a hidden id must not be a link, any other id
 * in the set must become one.
 */
async function expectRows(
  root: HTMLElement,
  navIds: readonly NavId[],
  hidden: readonly NavId[]
): Promise<void> {
  for (const navId of navIds) {
    if (hidden.includes(navId)) {
      assertNoNavLink(root, navId);
    } else {
      await waitForNavLink(root, navId);
    }
  }
}

/**
 * The open route lights exactly its own row, and only when that row is offered.
 * A hidden id, or one inside a closed Labs, has no row, so nothing lights.
 */
function assertActiveRow(root: HTMLElement, activeNav: NavId): void {
  const active = root.querySelectorAll('[data-active="true"]');
  if (!findNavLink(root, activeNav)) {
    if (active.length !== 0) {
      throw new Error(
        `${hrefForNavId(activeNav)} has no row, yet ${active.length} row(s) read as active`
      );
    }
    return;
  }
  if (active.length !== 1) {
    throw new Error(`expected exactly one active row, found ${active.length}`);
  }
  const href = hrefForNavId(activeNav);
  if (!active[0]?.matches(`a[href="${href}"]`)) {
    throw new Error(`the active row must be the ${href} link`);
  }
}

/** Opens the Labs section only when it is closed; see {@link LabsOpen}. */
async function ensureLabsExpanded(root: HTMLElement): Promise<void> {
  const trigger = Array.from(
    root.querySelectorAll<HTMLElement>("button[aria-expanded]")
  ).find((element) => element.textContent?.trim() === LABS_LABEL);
  if (!trigger) {
    throw new Error("the Labs section trigger never rendered");
  }
  if (trigger.getAttribute("aria-expanded") !== "true") {
    trigger.click();
  }
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (trigger.getAttribute("aria-expanded") === "true") {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("the Labs section did not open");
}

/**
 * Wait for THIS row to read `word`.
 *
 * Scoped to the row, the way the active-row check is scoped by href (#7680,
 * marisolashgrove). A substring scan of the whole canvas passes on any skeleton or
 * card that later picks up the same word, and the real assertion beside it is an
 * absence — so the day something else says "Loading", the absence check starts
 * passing trivially and nothing goes red.
 *
 * Matching an `aria-disabled` row is also what makes this the inert branch
 * rather than a link that happens to contain the word.
 */
async function waitForRowState(
  root: HTMLElement,
  navId: NavId,
  word: string
): Promise<void> {
  const label = navRowLabel(navId);
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const row = findInertRow(root, label);
    if (row?.textContent?.includes(word)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`the ${label} row never read "${word}"`);
}

function findInertRow(root: HTMLElement, label: string): HTMLElement | null {
  return (
    Array.from(
      root.querySelectorAll<HTMLElement>('button[aria-disabled="true"]')
    ).find((element) => element.textContent?.startsWith(label) ?? false) ?? null
  );
}

/**
 * The row's visible label, read from the shared manifest rather than restated
 * here, so a renamed destination cannot leave this file asserting a word the
 * sidebar no longer renders.
 */
function navRowLabel(navId: NavId): string {
  const item = SHELL_NAVIGATION_ITEMS.find((entry) => entry.id === navId);
  if (!item) {
    throw new Error(`no shell navigation item is named "${navId}"`);
  }
  return item.label;
}
