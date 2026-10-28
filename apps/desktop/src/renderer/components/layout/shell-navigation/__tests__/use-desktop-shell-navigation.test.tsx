import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import {
  NavigationActorStanding,
  NavigationProjectionStatus,
  type NavigationViewModel,
  pendingNavigationCount,
  toNavigationCount,
  unavailableNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { FEATURE_FLAG_SETTLE_TIMEOUT_MS } from "@repo/app/shared/components/feature-flag-pending";
import {
  SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  ShellNavigationItemId,
  ShellNavigationSurface,
  shellNavigationGateKeys,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NavId } from "../../../../navigation/route-table";

/**
 * The desktop adapter's contracts with the shared shell (PLN-2016 D4–D6): WHICH
 * destinations it asks the projection about, WHEN it asks, which gate keys it
 * reads, and what never leaves it.
 *
 * Driven through `renderHook` rather than a rendered sidebar on purpose — the
 * control and footer slots are nodes the hook builds but does not render, so
 * every flag read captured here is one the ADAPTER made, not one a control made
 * for its own reasons.
 */

type ViewModelRead = { readonly ids: string[]; readonly enabled: boolean };

const readFlagKeys: string[] = [];
const enabledFlags = new Set<string>();
const viewModelReads: ViewModelRead[] = [];
const agentsActivity = vi.hoisted(() => ({
  count: undefined as unknown,
  label: "0 recently finished sessions",
}));
const flagsResolved = vi.hoisted(() => ({ value: false }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => {
    readFlagKeys.push(key);
    return enabledFlags.has(key);
  },
}));

vi.mock("../../../../feature-flags/desktop-feature-flag-provider", () => ({
  useDesktopFeatureFlagsResolved: () => flagsResolved.value,
}));

vi.mock("@repo/app/shell/v2/hooks/use-navigation-view-model", async () => {
  const { NavigationDestinationStatus } = await vi.importActual<
    typeof import("@repo/api/src/types/navigation-view-model")
  >("@repo/api/src/types/navigation-view-model");
  return {
    useNavigationViewModel: (
      destinationIds: readonly string[],
      options?: { readonly enabled?: boolean }
    ) => {
      viewModelReads.push({
        enabled: options?.enabled ?? true,
        ids: [...destinationIds],
      });
      // Every requested destination GRANTED, so the rows are navigable and a
      // badge assertion is about the count rather than about a row the fold has
      // already suppressed for an unreadable capability.
      const destinations: Record<string, { status: string }> = {};
      for (const id of destinationIds) {
        destinations[id] = { status: NavigationDestinationStatus.Ready };
      }
      return { ...READY_VIEW_MODEL, destinations };
    },
  };
});

vi.mock("@repo/app/agents/hooks/use-agents-nav-activity", async (original) => ({
  ...(await original<
    typeof import("@repo/app/agents/hooks/use-agents-nav-activity")
  >()),
  useAgentsNavActivity: () => ({
    count: agentsActivity.count,
    label: agentsActivity.label,
    markVisited: vi.fn(),
  }),
}));

import { useDesktopShellNavigation } from "../use-desktop-shell-navigation";

const READY_VIEW_MODEL: NavigationViewModel = {
  destinations: {},
  organizationId: "org-123",
  projectionStatus: NavigationProjectionStatus.Ready,
  standing: NavigationActorStanding.Member,
};

/** Every desktop gate key the contract declares, so nothing is closed by omission. */
function openEveryContractGate(): void {
  for (const key of shellNavigationGateKeys(ShellNavigationSurface.Desktop)) {
    enabledFlags.add(key);
  }
}

function renderAdapter({
  activeNav = NavId.Dashboard,
  hiddenNavIds = [],
  initialPath = "/dashboard",
}: {
  activeNav?: NavId;
  hiddenNavIds?: readonly NavId[];
  initialPath?: string;
} = {}) {
  const memoryNav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={memoryNav.adapter}>
      {children}
    </NavigationProvider>
  );
  return renderHook(
    () => useDesktopShellNavigation({ activeNav, hiddenNavIds }),
    { wrapper }
  );
}

/** The ids of the last read the adapter actually ISSUED, held ones excluded. */
function lastIssuedIds(): string[] {
  const read = viewModelReads.filter((candidate) => candidate.enabled).at(-1);
  if (read === undefined) {
    throw new Error("The adapter never asked for a navigation view model");
  }
  return read.ids;
}

beforeEach(() => {
  readFlagKeys.length = 0;
  viewModelReads.length = 0;
  enabledFlags.clear();
  agentsActivity.count = undefined;
  agentsActivity.label = "0 recently finished sessions";
  flagsResolved.value = true;
});

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

describe("useDesktopShellNavigation — what it asks the projection about", () => {
  test("asks for every offered desktop route destination, in contract order, and for no control", () => {
    openEveryContractGate();

    renderAdapter();

    // The offered set, hierarchy order. Every desktop-routeless destination
    // (Inbox, My Issues, My Tasks, Lost work, TokenOps waste, Judges) is
    // absent, and so is every control — the projection has nothing to say about
    // a host control, so asking about one would be a read nobody can answer.
    expect(lastIssuedIds()).toEqual(OFFERED_DESTINATION_IDS);
  });

  test("drops a destination App.tsx has already hidden", () => {
    openEveryContractGate();

    renderAdapter({ hiddenNavIds: [NavId.Plans, NavId.Packs] });

    expect(lastIssuedIds()).toEqual(
      OFFERED_DESTINATION_IDS.filter(
        (id) =>
          id !== ShellNavigationItemId.Plans &&
          id !== ShellNavigationItemId.Packs
      )
    );
  });

  test("keeps the Labs subtree gone when the container gate is closed, rather than re-homing it", () => {
    // Every PER-ITEM gate open, only the container closed. The shared
    // container-absent table re-homes Agents onto Artifacts and
    // Search above the primary rows — the WEB answer. On desktop both queues
    // declare the container as one of their OWN gates and Search is offered only
    // while the container is open, so the desktop tree is Dashboard and the
    // Artifacts rows, exactly what the legacy arm renders with Labs off.
    for (const key of shellNavigationGateKeys(ShellNavigationSurface.Desktop)) {
      enabledFlags.add(key);
    }
    enabledFlags.delete(SHELL_DESKTOP_LABS_NAV_GATE_KEY);

    const { result } = renderAdapter();

    expect(lastIssuedIds()).toEqual([
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Documents,
      ShellNavigationItemId.Issues,
      ShellNavigationItemId.Sessions,
      ShellNavigationItemId.Branches,
    ]);
    expect(
      result.current.sections.flatMap((section) => [
        ...section.leadingControlIds,
        ...section.trailingControlIds,
      ])
    ).toEqual([]);
  });

  test("offers Search only while the Labs container is open", () => {
    openEveryContractGate();

    const { result } = renderAdapter();

    expect(
      result.current.sections.flatMap((section) => collectControlIds(section))
    ).toContain(ShellNavigationItemId.Search);
  });

  test("issues nothing until the desktop flag assignment has arrived", () => {
    flagsResolved.value = false;
    openEveryContractGate();

    renderAdapter();

    // Before the assignment lands every gate reads closed, and the requested ids
    // are derived from the gates — so this window's set describes a tree nothing
    // will render. A different id list is a different query key, so letting it
    // through buys a read the settled set can never reuse.
    expect(viewModelReads.length).toBeGreaterThan(0);
    expect(viewModelReads.some((read) => read.enabled)).toBe(false);
  });

  test("stops holding the read once the settle deadline elapses", () => {
    vi.useFakeTimers();
    flagsResolved.value = false;
    openEveryContractGate();

    renderAdapter();

    expect(viewModelReads.some((read) => read.enabled)).toBe(false);

    // A PostHog assignment that never arrives would otherwise leave every row
    // non-navigable forever, which is a worse answer than a read against the
    // closed-default tree.
    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
    });

    expect(lastIssuedIds()).toEqual(OFFERED_DESTINATION_IDS);
  });
});

describe("useDesktopShellNavigation — which gates it reads", () => {
  test("reads every desktop gate key the contract declares", () => {
    renderAdapter();

    // Derived from the contract, never listed again here: a gate added to the
    // contract fails this until the desktop evaluator reads it, instead of
    // silently evaluating closed and dropping a destination nobody decided to
    // drop. A superset rather than an equality, because `useDesktopNavGates`
    // also owns the route-withdrawal outcome key, which gates what a CLOSED
    // destination renders rather than whether the nav offers it.
    for (const key of shellNavigationGateKeys(ShellNavigationSurface.Desktop)) {
      expect(readFlagKeys).toContain(key);
    }
  });

  test("never reads the rollout key that chose this tree", () => {
    enabledFlags.add(SHELL_SIDEBAR_V2_FLAG_KEY);
    openEveryContractGate();

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

describe("useDesktopShellNavigation — the icon each row draws", () => {
  test("gives every row this shell can offer an icon", () => {
    openEveryContractGate();

    const { result } = renderAdapter();

    // The exhaustive record in `desktop-shell-destination-icons.ts` pins that
    // every item has a DECISION; it compiles fine when that decision RESOLVES to
    // null, and the row then ships with a hole where every sibling has an icon.
    // This is the half that catches it.
    const withoutIcon = lastIssuedIds().filter(
      (id) => result.current.renderIcon(id) === null
    );
    expect(withoutIcon).toEqual([]);
  });
});

describe("useDesktopShellNavigation — the Agents count", () => {
  test("carries the cap and the noun the counting hook exports onto the Agents row", () => {
    openEveryContractGate();
    agentsActivity.count = toNavigationCount(3);

    const { result } = renderAdapter();

    const agents = findEntry(
      result.current.sections,
      ShellNavigationItemId.Agents
    );
    expect(agents?.badgeMax).toBe(9);
    expect(agents?.countNoun).toEqual({
      one: "recently finished session",
      other: "recently finished sessions",
    });
  });

  test.each([
    ["pending", () => pendingNavigationCount()],
    ["unavailable", () => unavailableNavigationCount()],
  ])(
    "renders no badge for a %s count, on a row that is otherwise navigable (PR #7266 review constraint)",
    (_name, makeCount) => {
      openEveryContractGate();
      agentsActivity.count = makeCount();

      const { result } = renderAdapter();

      // The hook folds a pending or unavailable read to `label: "0 recently
      // finished sessions"`. Only the count OBJECT may cross over; the fold then
      // renders no badge at all, because a read still in flight has no number to
      // announce — and the row beside it is a live link, so this is the count
      // being withheld rather than the row being suppressed.
      const agents = findEntry(
        result.current.sections,
        ShellNavigationItemId.Agents
      );
      expect(agents?.navigable).toBe(true);
      expect(agents?.badgeCount).toBeNull();
    }
  );
});

function collectControlIds(section: {
  leadingControlIds: readonly string[];
  trailingControlIds: readonly string[];
  sections: readonly {
    leadingControlIds: readonly string[];
    trailingControlIds: readonly string[];
    sections: readonly unknown[];
  }[];
}): string[] {
  return [
    ...section.leadingControlIds,
    ...section.trailingControlIds,
    ...section.sections.flatMap((child) =>
      collectControlIds(child as Parameters<typeof collectControlIds>[0])
    ),
  ];
}

type ShellSections = ReturnType<typeof useDesktopShellNavigation>["sections"];
type ShellEntry = ShellSections[number]["entries"][number];

function findEntry(
  sections: ShellSections,
  id: string
): ShellEntry | undefined {
  for (const section of sections) {
    const entry = section.entries.find((candidate) => candidate.id === id);
    if (entry !== undefined) {
      return entry;
    }
    const nested = findEntry(section.sections, id);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/** Every offered desktop route destination, in hierarchy order. */
const OFFERED_DESTINATION_IDS: readonly string[] = [
  ShellNavigationItemId.Dashboard,
  ShellNavigationItemId.Documents,
  ShellNavigationItemId.Issues,
  ShellNavigationItemId.Sessions,
  ShellNavigationItemId.Branches,
  ShellNavigationItemId.Insights,
  ShellNavigationItemId.Approvals,
  ShellNavigationItemId.Requests,
  ShellNavigationItemId.Packs,
  ShellNavigationItemId.Plans,
  ShellNavigationItemId.Help,
  ShellNavigationItemId.Agents,
];
