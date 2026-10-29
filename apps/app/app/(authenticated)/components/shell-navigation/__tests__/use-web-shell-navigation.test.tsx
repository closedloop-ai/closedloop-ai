import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import {
  NavigationActorStanding,
  NavigationProjectionStatus,
  type NavigationViewModel,
  pendingNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { FEATURE_FLAG_SETTLE_TIMEOUT_MS } from "@repo/app/shared/components/feature-flag-pending";
import {
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LOST_WORK_NAV_FEATURE_FLAG_KEY,
  TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  ShellNavigationItemId,
  ShellNavigationSurface,
  shellNavigationGateKeys,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The web adapter's two contracts with the shared shell (PLN-2016 D4/D6): WHICH
 * destinations it asks the projection about, and WHICH gate keys it reads.
 *
 * Driven through `renderHook` rather than a rendered sidebar on purpose — the
 * control and footer slots are nodes the hook builds but does not render, so
 * every `useFeatureFlag` call captured here is one the ADAPTER made, not one a
 * control made for its own reasons.
 */

type ViewModelRead = { readonly ids: string[]; readonly enabled: boolean };

const readFlagKeys: string[] = [];
const enabledFlags = new Set<string>();
const viewModelReads: ViewModelRead[] = [];
let postHogFlagsLoaded = false;
let postHogDistinctId: string | undefined;

vi.mock("@repo/analytics/client", () => ({
  // A live PostHog client, so the adapter's hold is exercised rather than
  // short-circuited by the no-key build that resolves flags from a fixture.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) => {
    readFlagKeys.push(flag);
    return {
      enabled: enabledFlags.has(flag),
      key: flag,
      payload: undefined,
      variant: undefined,
    };
  },
  useFeatureFlagsLoaded: () => postHogFlagsLoaded,
  usePostHogDistinctId: () => postHogDistinctId,
}));

vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", () => ({
  useNavigationViewModel: (
    destinationIds: readonly string[],
    options?: { readonly enabled?: boolean }
  ) => {
    viewModelReads.push({
      enabled: options?.enabled ?? true,
      ids: [...destinationIds],
    });
    return READY_VIEW_MODEL;
  },
}));

vi.mock("@repo/app/agents/hooks/use-agents-nav-activity", async (original) => ({
  ...(await original<
    typeof import("@repo/app/agents/hooks/use-agents-nav-activity")
  >()),
  useAgentsNavActivity: () => ({
    count: undefined,
    label: "0 recently finished sessions",
    markVisited: vi.fn(),
  }),
}));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({ isSignedIn: true }),
  useOrganization: () => ({
    isLoaded: true,
    membership: { role: "org:member" },
    organization: { id: "org-123", slug: "test-org" },
  }),
  useUser: () => ({ isLoaded: true, user: { id: SIGNED_IN_USER_ID } }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "test-org" }),
  usePathname: () => "/test-org/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../search", () => ({ Search: () => null }));
vi.mock("../../sidebar-teams", () => ({ SidebarTeams: () => null }));
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
}));
vi.mock("@repo/app/shared/feature-flags/dev-mode/dev-mode-provider", () => ({
  useDevMode: () => ({
    isDevModeAvailable: true,
    isDevModeEnabled: true,
    setDevModeEnabled: vi.fn(),
  }),
}));

import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { useWebShellNavigation } from "../use-web-shell-navigation";

const READY_VIEW_MODEL: NavigationViewModel = {
  destinations: {},
  organizationId: "org-123",
  projectionStatus: NavigationProjectionStatus.Ready,
  standing: NavigationActorStanding.Member,
};

const SIGNED_IN_USER_ID = "user-123";

function renderAdapter() {
  return renderHook(
    () =>
      useWebShellNavigation({
        envBadge: null,
        inboxCount: pendingNavigationCount(),
      }),
    { wrapper: WebFeatureFlagProvider }
  );
}

/**
 * PostHog answering for the signed-in user with these gate keys on — the
 * unresolved→resolved transition every gate in this adapter is derived from.
 * Before it, the client serves the anonymous set, where every gate reads closed.
 */
/**
 * Every key this adapter reads: the contract's declared web gates, plus the one
 * key that is deliberately NOT a contract gate.
 *
 * `enable-labs-nav-section` mounts the Labs SECTION and nothing else. Declaring
 * it on the Labs group would also close the CONTAINER, and a closed container
 * re-homes Inbox, My Tasks, Agents and Search back
 * into the nav — the opposite of what a menu-only gate is for. So the adapter
 * applies it to the built sections instead, and the one key that is not derived
 * from the contract is named here rather than hidden inside a derivation.
 */
const WEB_SHELL_ADAPTER_FLAG_KEYS: readonly string[] = [
  ...shellNavigationGateKeys(ShellNavigationSurface.Web),
  ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY,
];

function settleFlags(enabledKeys: readonly string[]): void {
  for (const key of enabledKeys) {
    enabledFlags.add(key);
  }
  postHogFlagsLoaded = true;
  postHogDistinctId = SIGNED_IN_USER_ID;
}

/** The ids of the last read the adapter actually ISSUED, held ones excluded. */
function lastIssuedIds(): string[] {
  const read = viewModelReads.filter((candidate) => candidate.enabled).at(-1);
  if (read === undefined) {
    throw new Error("The adapter never asked for a navigation view model");
  }
  return read.ids;
}

function issuedReadIdSets(): string[] {
  return [
    ...new Set(
      viewModelReads
        .filter((read) => read.enabled)
        .map((read) => read.ids.join(","))
    ),
  ];
}

beforeEach(() => {
  readFlagKeys.length = 0;
  viewModelReads.length = 0;
  enabledFlags.clear();
  postHogFlagsLoaded = false;
  postHogDistinctId = undefined;
  globalThis.localStorage.clear();
});

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

describe("useWebShellNavigation — what it asks the projection about", () => {
  test("asks for every offered route destination, in contract order, and for no control", () => {
    settleFlags(WEB_SHELL_ADAPTER_FLAG_KEYS);

    renderAdapter();

    // The offered set, hierarchy order. Every web-routeless destination
    // (My Issues, Approvals, Requests, Plans, Help) is absent, and so
    // is every control — the projection has nothing to say about a host control,
    // so asking about one would be a read nobody can answer.
    expect(lastIssuedIds()).toEqual(SETTLED_DESTINATION_IDS);
  });

  test("issues nothing before mount, even when the flags settled first", () => {
    // The settled signal can already be true on the very first render: a build
    // with no PostHog key resolves flags from a fixture and reports settled from
    // the start. That render is still the PRE-MOUNT one, where every gate reads
    // closed — so the mount guard, not the settled signal, is what keeps that
    // narrow set off the wire.
    settleFlags(WEB_SHELL_ADAPTER_FLAG_KEYS);

    renderAdapter();

    expect(issuedReadIdSets()).toEqual([SETTLED_DESTINATION_IDS.join(",")]);
  });

  test("issues nothing until PostHog has answered for the signed-in user", () => {
    const { rerender } = renderAdapter();

    // The anonymous bootstrap reads every gate closed, and the requested ids are
    // derived from the gates — so this window's set describes a tree nothing
    // will render. A different id list is a different query key, so letting it
    // through buys a read the settled set can never reuse.
    expect(viewModelReads.length).toBeGreaterThan(0);
    expect(viewModelReads.some((read) => read.enabled)).toBe(false);

    settleFlags(WEB_SHELL_ADAPTER_FLAG_KEYS);
    rerender();

    // Across the whole transition exactly one distinct set reaches the
    // projection, and it is the settled one.
    expect(issuedReadIdSets()).toEqual([SETTLED_DESTINATION_IDS.join(",")]);
  });

  test("stops holding the read once the settle deadline elapses", () => {
    vi.useFakeTimers();
    // PostHog never answers for this user — a failed `/flags` leaves the settled
    // signal false forever (ISS-4566). A held read reports PENDING, which renders
    // every row non-navigable, so the hold has to end on its own.
    for (const key of WEB_SHELL_ADAPTER_FLAG_KEYS) {
      enabledFlags.add(key);
    }

    renderAdapter();

    expect(viewModelReads.some((read) => read.enabled)).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
    });

    expect(lastIssuedIds()).toEqual(SETTLED_DESTINATION_IDS);
  });

  test("asks about the Labs destinations in their pre-move homes when Labs is absent", () => {
    settleFlags([]);

    renderAdapter();

    // ISS-9734 AC2. The Labs CONTAINER answers where these render, never
    // whether: `labs-nav-section` is outside `DEV_MODE_EXEMPT_FLAG_KEYS`, so the
    // customer view closes it for every viewer, and taking the subtree with it
    // would leave Dashboard, Sessions and Branches. This is the same fallback
    // the legacy arm picks with `CURRENT_SIDEBAR_SHAPE`. Documents and Issues
    // are absent because their own keys are closed.
    expect(lastIssuedIds()).toEqual([
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Inbox,
      ShellNavigationItemId.MyTasks,
      ShellNavigationItemId.Sessions,
      ShellNavigationItemId.Branches,
    ]);
  });

  test("keeps each re-homed destination answering to its own gate", () => {
    settleFlags(
      [...shellNavigationGateKeys(ShellNavigationSurface.Web)].filter(
        (key) => key !== LABS_NAV_SECTION_FEATURE_FLAG_KEY
      )
    );

    renderAdapter();

    // Every web gate but the container is ON, so Agents comes back with the
    // rest — the container's absence subtracts nothing. On the same render
    // Insights, Packs, Lost work, TokenOps waste and Judges stay
    // gone with their own gates open, because each declares the container key
    // as one of ITS gates too.
    expect(lastIssuedIds()).toEqual([
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Inbox,
      ShellNavigationItemId.MyTasks,
      ShellNavigationItemId.Documents,
      ShellNavigationItemId.Issues,
      ShellNavigationItemId.Sessions,
      ShellNavigationItemId.Branches,
      ShellNavigationItemId.Agents,
    ]);
  });

  test("drops only Help when the Labs container is open and Help's own key is not", () => {
    // ISS-10006. Help is the one web row behind TWO keys, and the pair above
    // only exercises the CONTAINER being shut — which 404s the whole section and
    // would leave Help's own gate proven by nothing. This is the other
    // permutation: container open, inner key shut.
    settleFlags(
      WEB_SHELL_ADAPTER_FLAG_KEYS.filter(
        (key) => key !== HELP_COMPLETE_SURFACE_FLAG_KEY
      )
    );

    renderAdapter();

    const issued = lastIssuedIds();
    expect(issued).not.toContain(ShellNavigationItemId.Help);
    // The positive half, on the same render: the sibling Labs rows are still
    // here, so Help's absence is its own gate rather than a shut container or an
    // empty projection.
    expect(issued).toContain(ShellNavigationItemId.Packs);
    expect(issued).toContain(ShellNavigationItemId.Judges);
  });

  test.each([
    {
      shutKey: LOST_WORK_NAV_FEATURE_FLAG_KEY,
      dropped: ShellNavigationItemId.LostWork,
      kept: ShellNavigationItemId.TokenOpsWaste,
    },
    {
      shutKey: TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
      dropped: ShellNavigationItemId.TokenOpsWaste,
      kept: ShellNavigationItemId.LostWork,
    },
  ])(
    "drops only $dropped when the Labs container is open and $shutKey is not",
    ({ shutKey, dropped, kept }) => {
      // Container open, own key shut, sibling's key open: a swap of the two
      // rows' gate reads keeps the shut row and drops its sibling.
      settleFlags(WEB_SHELL_ADAPTER_FLAG_KEYS.filter((key) => key !== shutKey));

      renderAdapter();

      const issued = lastIssuedIds();
      expect(issued).not.toContain(dropped);
      expect(issued).toContain(kept);
      expect(issued).toContain(ShellNavigationItemId.Packs);
    }
  );

  test("re-arms the settle bound for a window that opens after the first elapsed", () => {
    vi.useFakeTimers();
    for (const key of WEB_SHELL_ADAPTER_FLAG_KEYS) {
      enabledFlags.add(key);
    }

    const { rerender } = renderAdapter();

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
    });
    expect(viewModelReads.at(-1)?.enabled).toBe(true);

    settleFlags([]);
    rerender();
    expect(viewModelReads.at(-1)?.enabled).toBe(true);

    // A mid-session `identify()` flag reload reopens the window this adapter
    // outlives. A deadline epoched on the adapter's own mount has already
    // expired, so it waves this one straight through and reads the provisional
    // gates (ISS-4566); a per-window bound holds again.
    postHogFlagsLoaded = false;
    rerender();
    expect(viewModelReads.at(-1)?.enabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
    });
    expect(viewModelReads.at(-1)?.enabled).toBe(true);
  });
});

describe("useWebShellNavigation — which gates it reads", () => {
  test("reads exactly the contract's web gate keys plus the Labs menu mount", () => {
    renderAdapter();

    // Still derived from the contract — a gate added there fails this until the
    // adapter reads it, instead of silently evaluating closed and dropping a
    // destination nobody decided to drop. The single addition is spelled out in
    // `WEB_SHELL_ADAPTER_FLAG_KEYS`, which carries why the menu mount cannot be
    // a contract gate; anything else the adapter starts reading still reddens
    // this.
    expect([...new Set(readFlagKeys)].sort()).toEqual(
      [...WEB_SHELL_ADAPTER_FLAG_KEYS].sort()
    );
  });

  /**
   * The menu mount is a different question from the container, so closing it
   * must not move a single row. This is the v2 half of the #8156 split: with the
   * shape open and the menu shut, the moved destinations stay OUT of the nav
   * rather than falling back to their pre-move homes. The Labs rows do leave
   * the request with their section — what is pinned is that none of them is
   * re-homed into the nav.
   */
  test("re-homes no destination when only the Labs menu mount is closed", () => {
    settleFlags(
      WEB_SHELL_ADAPTER_FLAG_KEYS.filter(
        (key) => key !== ENABLE_LABS_NAV_SECTION_FEATURE_FLAG_KEY
      )
    );

    renderAdapter();

    const issued = lastIssuedIds();
    // The Labs rows are gone with their section, and NOT re-homed: a container
    // close would have put Inbox and My Tasks back in the nav, which is exactly
    // what `asks about the Labs destinations in their pre-move homes` above
    // pins for the other gate.
    expect(issued).toEqual([
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Documents,
      ShellNavigationItemId.Issues,
      ShellNavigationItemId.Sessions,
      ShellNavigationItemId.Branches,
    ]);
  });

  test("never reads the rollout key that chose this tree", () => {
    enabledFlags.add(SHELL_SIDEBAR_V2_FLAG_KEY);
    enabledFlags.add(LABS_NAV_SECTION_FEATURE_FLAG_KEY);

    renderAdapter();

    // PLN-2016 D6, standing in for the deleted `no-descendant-experience-flag-read`
    // source gate: the mount site above owns that read and publishes the choice
    // as a whole tree. A descendant re-reading it is what lets half a screen
    // disagree with the other half.
    expect(readFlagKeys).not.toContain(SHELL_SIDEBAR_V2_FLAG_KEY);
    // A positive sibling on the same render, so the absence above is about the
    // rollout key and not about a hook that never ran.
    expect(readFlagKeys).toContain(AGENTS_NAV_FLAG_KEY);
  });
});

/** Every offered web route destination, in hierarchy order. */
const SETTLED_DESTINATION_IDS: readonly string[] = [
  ShellNavigationItemId.Dashboard,
  ShellNavigationItemId.Documents,
  ShellNavigationItemId.Issues,
  ShellNavigationItemId.Sessions,
  ShellNavigationItemId.Branches,
  ShellNavigationItemId.Inbox,
  ShellNavigationItemId.Insights,
  ShellNavigationItemId.MyTasks,
  ShellNavigationItemId.Packs,
  ShellNavigationItemId.LostWork,
  ShellNavigationItemId.TokenOpsWaste,
  ShellNavigationItemId.Judges,
  // ISS-10006 — Help became a reachable web Labs row. Its position is the
  // CONTRACT's, not this list's: it sits between Judges and Agents because
  // that is where `SHELL_NAVIGATION_ITEMS` puts it.
  ShellNavigationItemId.Help,
  ShellNavigationItemId.Agents,
];
