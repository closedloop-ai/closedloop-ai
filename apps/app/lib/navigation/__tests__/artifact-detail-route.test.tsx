import { BranchDetailTabParam } from "@repo/api/src/types/notification-routes";
import {
  SESSION_ARTIFACT_ROUTE_CONFIG,
  SESSION_ARTIFACT_TAB_LABELS,
  sessionArtifactTabLabel,
} from "@repo/app/agents/components/detail/session-artifact-routing";
import { SessionDetailTab } from "@repo/app/agents/components/detail/session-detail-tabs";
import { BRANCH_ARTIFACT_ROUTE_CONFIG } from "@repo/app/branches/components/branch-artifact-routing";
import {
  ArtifactDetailShell,
  ArtifactDetailTabStateKind,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { useArtifactDetailTabRoute } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import { usePath } from "@repo/navigation/use-path";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNavigationProvider } from "../next-adapter";

vi.unmock("@repo/navigation/use-navigation");
vi.unmock("@repo/navigation/use-path");
vi.unmock("@repo/navigation/use-search-params-value");
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({ organization: null, isLoaded: true }),
  useAuth: () => ({ isSignedIn: true }),
}));
const route = vi.hoisted(() => {
  let entries = ["/current/path?tab=active"];
  let index = 0;
  let delayNextPush = false;
  let pendingHref: string | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    delayPush: () => {
      delayNextPush = true;
    },
    getPendingHref: () => pendingHref,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHref: () => entries[index],
    getEntries: () => [...entries],
    reset: (href: string) => {
      delayNextPush = false;
      pendingHref = null;
      entries = [href];
      index = 0;
      emit();
    },
    actions: {
      push: (href: string) => {
        if (delayNextPush) {
          delayNextPush = false;
          pendingHref = href;
          return;
        }
        entries = [...entries.slice(0, index + 1), href];
        index += 1;
        emit();
      },
      replace: (href: string) => {
        entries[index] = href;
        emit();
      },
      back: () => {
        if (index > 0) {
          index -= 1;
          emit();
        }
      },
      forward: () => {
        if (index < entries.length - 1) {
          index += 1;
          emit();
        }
      },
      refresh: () => undefined,
    },
  };
});

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const useHref = () =>
    useSyncExternalStore(route.subscribe, route.getHref, route.getHref);
  return {
    useRouter: () => route.actions,
    usePathname: () => {
      const href = useHref();
      return href.split("?")[0];
    },
    useParams: () => ({ orgSlug: "acme" }),
    useSearchParams: () => {
      const href = useHref();
      return new URLSearchParams(href.split("?")[1] ?? "");
    },
  };
});

describe("artifact detail routing under the Next adapter", () => {
  afterEach(() => {
    route.reset("/current/path?tab=active");
    vi.clearAllMocks();
  });
  it("routes Branch aliases and restores tabs through real adapter history", async () => {
    const user = userEvent.setup();
    route.reset(
      "/acme/branches/b-1?tab=sessions-timeline&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    render(<RoutedArtifactShell kind="branch" />, { wrapper });

    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(route.getHref()).toBe(
      "/acme/branches/b-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(route.getEntries()).toHaveLength(2);

    act(() => route.actions.back());
    expect(route.getHref()).toBe(
      "/acme/branches/b-1?tab=sessions-timeline&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveFocus();
    await user.click(
      screen.getByRole("button", { name: "Canonicalize fixture" })
    );
    expect(route.getHref()).toBe(
      "/acme/branches/b-1?tab=sessions&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    act(() => route.actions.forward());
    expect(route.getHref()).toBe(
      "/acme/branches/b-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(screen.getByRole("tabpanel", { name: "Details" })).toBeVisible();
    expect(route.getEntries()).toHaveLength(2);
  });

  it("keeps Session's Artifact canvas mounted across a routed tab change", async () => {
    const user = userEvent.setup();
    route.reset(
      "/acme/sessions/s-1?tab=trace&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    render(<RoutedArtifactShell kind="session" />, { wrapper });

    // ISS-12167: a Session hides the generic Artifact tab; its canvas is the
    // Sessions tab's body, labelled "Session".
    expect(screen.queryByRole("tab", { name: "Artifact" })).toBeNull();
    const canvas = screen.getByRole("button", { name: "Canvas count 0" });
    await user.click(canvas);
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(route.getHref()).toBe(
      "/acme/sessions/s-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    act(() => route.actions.back());
    expect(route.getHref()).toBe(
      "/acme/sessions/s-1?tab=trace&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(screen.getByRole("button", { name: "Canvas count 1" })).toBe(canvas);
    expect(
      screen.getByRole("tab", { name: SESSION_CANVAS_LABEL })
    ).toHaveAttribute("aria-selected", "true");
    act(() => route.actions.forward());
    expect(route.getHref()).toBe(
      "/acme/sessions/s-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
  });

  it("pauses a representative kept canvas while hidden and resumes after Back", async () => {
    const user = userEvent.setup();
    const query = vi.fn();
    route.reset("/acme/sessions/s-1");
    render(<RoutedArtifactShell kind="session" onVisibleQuery={query} />, {
      wrapper,
    });
    expect(query).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.click(screen.getByRole("button", { name: "Refresh fixture" }));
    expect(query).toHaveBeenCalledTimes(1);
    act(() => route.actions.back());
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Canvas count 0" })
    ).toBeVisible();
  });

  for (const interruptedHref of [
    "/acme/sessions/s-2?tab=details",
    "/acme/sessions/s-1?tab=activity",
  ]) {
    it(`does not reveal a stale target after ${interruptedHref}`, async () => {
      const user = userEvent.setup();
      const onReveal = vi.fn();
      route.reset("/acme/sessions/s-1");
      render(<RoutedArtifactShell kind="session" onReveal={onReveal} />, {
        wrapper,
      });
      route.delayPush();
      await user.click(screen.getByRole("button", { name: "Reveal details" }));
      expect(route.getPendingHref()).toBe("/acme/sessions/s-1?tab=details");
      expect(onReveal).not.toHaveBeenCalled();
      act(() => route.actions.push(interruptedHref));
      act(() =>
        route.actions.push(`${interruptedHref.split("?")[0]}?tab=details`)
      );
      expect(screen.getByRole("tabpanel", { name: "Details" })).toBeVisible();
      expect(onReveal).not.toHaveBeenCalled();
    });
  }

  it("reveals only after the holding panel mounts through the Next adapter", async () => {
    const user = userEvent.setup();
    const targets: string[] = [];
    route.reset("/acme/sessions/s-1");
    render(
      <RoutedArtifactShell
        kind="session"
        onReveal={() =>
          targets.push(
            screen.getByRole("tabpanel", { name: "Details" }).textContent ?? ""
          )
        }
      />,
      { wrapper }
    );
    await user.click(screen.getByRole("button", { name: "Reveal details" }));
    expect(targets).toEqual(["Details panel"]);
    expect(route.getHref()).toBe("/acme/sessions/s-1?tab=details");
  });

  it("leaves focus on a revealed target in the kept Artifact canvas", async () => {
    const user = userEvent.setup();
    route.reset("/acme/sessions/s-1");
    render(
      <RoutedArtifactShell
        kind="session"
        onReveal={() =>
          screen.getByRole("button", { name: "Canvas count 0" }).focus()
        }
        revealTab={ArtifactDetailTab.Sessions}
      />,
      { wrapper }
    );
    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.click(screen.getByRole("button", { name: "Reveal sessions" }));
    expect(
      screen.getByRole("button", { name: "Canvas count 0" })
    ).toHaveFocus();
  });

  /**
   * ISS-12167 retired `artifact` as a Session tab key and moved the same body
   * onto `sessions`. The retired value stays a compatibility alias, so a link
   * anyone already holds still opens the body it named.
   */
  it("resolves Session's retired artifact tab key onto its canvas", () => {
    route.reset("/acme/sessions/s-1?tab=artifact&from=agent");
    render(<RoutedArtifactShell kind="session" />, { wrapper });

    expect(screen.queryByRole("tab", { name: "Artifact" })).toBeNull();
    expect(
      screen.getByRole("tab", { name: SESSION_CANVAS_LABEL })
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tabpanel", { name: SESSION_CANVAS_LABEL })
    ).toBeVisible();
  });

  for (const testCase of [
    { kind: "branch" as const, tab: ArtifactDetailTab.Artifact },
    { kind: "branch" as const, tab: ArtifactDetailTab.Details },
    { kind: "branch" as const, tab: ArtifactDetailTab.Sessions },
    { kind: "branch" as const, tab: ArtifactDetailTab.Activity },
    { kind: "session" as const, tab: ArtifactDetailTab.Sessions },
    { kind: "session" as const, tab: ArtifactDetailTab.Details },
    { kind: "session" as const, tab: ArtifactDetailTab.Activity },
  ]) {
    it(`opens the ${testCase.kind} ${testCase.tab} deep link`, () => {
      const base =
        testCase.kind === "branch"
          ? "/acme/branches/b-1"
          : "/acme/sessions/s-1";
      route.reset(`${base}?tab=${testCase.tab}`);
      render(<RoutedArtifactShell kind={testCase.kind} />, { wrapper });

      const label = labelFor(testCase.kind, testCase.tab);
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.getByRole("tabpanel", { name: label })).toBeVisible();
    });
  }

  // An alias resolves to the tab it names; anything unroutable lands on the
  // type's first tab. Both are that type's canvas here.
  for (const testCase of [
    { kind: "branch" as const, raw: BranchDetailTabParam.BranchDetails },
    { kind: "session" as const, raw: SessionDetailTab.Overview },
    { kind: "session" as const, raw: SessionDetailTab.Trace },
    { kind: "branch" as const, raw: "unknown" },
    { kind: "session" as const, raw: "unknown" },
  ]) {
    it(`opens the ${testCase.kind} canvas from tab ${testCase.raw}`, () => {
      const base =
        testCase.kind === "branch"
          ? "/acme/branches/b-1"
          : "/acme/sessions/s-1";
      route.reset(`${base}?tab=${testCase.raw}`);
      render(<RoutedArtifactShell kind={testCase.kind} />, { wrapper });

      const label = labelFor(testCase.kind, CANVAS_TAB_BY_KIND[testCase.kind]);
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute(
        "aria-selected",
        "true"
      );
      expect(screen.getByRole("tabpanel", { name: label })).toBeVisible();
    });
  }

  it("resets the routed canvas when the host changes entity identity", async () => {
    const user = userEvent.setup();
    route.reset("/acme/sessions/s-1");
    render(<RoutedArtifactShell kind="session" />, { wrapper });

    await user.click(screen.getByRole("button", { name: "Canvas count 0" }));
    expect(
      screen.getByRole("button", { name: "Canvas count 1" })
    ).toBeVisible();
    act(() => route.actions.push("/acme/sessions/s-2"));
    expect(
      screen.getByRole("button", { name: "Canvas count 0" })
    ).toBeVisible();
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return <AppNavigationProvider>{children}</AppNavigationProvider>;
}

function RoutedArtifactShell({
  kind,
  onReveal,
  onVisibleQuery,
  revealTab = ArtifactDetailTab.Details,
}: {
  kind: "branch" | "session";
  onReveal?: () => void;
  onVisibleQuery?: (refresh: number) => void;
  revealTab?: ArtifactDetailTab;
}) {
  const config =
    kind === "branch"
      ? BRANCH_ARTIFACT_ROUTE_CONFIG
      : SESSION_ARTIFACT_ROUTE_CONFIG;
  const { activeTab, setActiveTab, selectTabThenReveal, onActivePanelReady } =
    useArtifactDetailTabRoute<ArtifactDetailTab>(config);
  const path = usePath();
  const [refresh, setRefresh] = useState(0);
  const canvasTab = CANVAS_TAB_BY_KIND[kind];
  const canvas = (
    <CanvasCounter
      active={activeTab === canvasTab}
      onVisibleQuery={onVisibleQuery}
      refresh={refresh}
    />
  );
  return (
    <ArtifactDetailShell
      activeTab={activeTab}
      headerEnd={
        <div>
          <button onClick={() => setActiveTab(activeTab)} type="button">
            Canonicalize fixture
          </button>
          <button
            onClick={() => setRefresh((value) => value + 1)}
            type="button"
          >
            Refresh fixture
          </button>
          {onReveal && (
            <button
              onClick={() => selectTabThenReveal(revealTab, onReveal)}
              type="button"
            >
              {`Reveal ${ARTIFACT_DETAIL_TAB_LABELS[revealTab].toLowerCase()}`}
            </button>
          )}
        </div>
      }
      keepMountedTabs={[canvasTab]}
      key={path}
      onActivePanelReady={onActivePanelReady}
      onActiveTabChange={setActiveTab}
      panels={{
        [ArtifactDetailTab.Artifact]:
          canvasTab === ArtifactDetailTab.Artifact ? (
            canvas
          ) : (
            <p>Artifact panel</p>
          ),
        [ArtifactDetailTab.Details]: <p>Details panel</p>,
        [ArtifactDetailTab.Sessions]:
          canvasTab === ArtifactDetailTab.Sessions ? (
            canvas
          ) : (
            <p>Sessions panel</p>
          ),
        [ArtifactDetailTab.Activity]: <p>Activity panel</p>,
      }}
      tabLabels={kind === "session" ? SESSION_ARTIFACT_TAB_LABELS : undefined}
      tabStates={{
        [ArtifactDetailTab.Activity]: {
          description: "host fixture description",
          kind: ArtifactDetailTabStateKind.Unsupported,
          title: "host fixture title",
        },
      }}
      tabs={config.tabs}
    />
  );
}

function CanvasCounter({
  active,
  onVisibleQuery,
  refresh,
}: {
  active: boolean;
  onVisibleQuery?: (refresh: number) => void;
  refresh: number;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (active) {
      onVisibleQuery?.(refresh);
    }
  }, [active, onVisibleQuery, refresh]);
  return (
    <button onClick={() => setCount((current) => current + 1)} type="button">
      {`Canvas count ${count}`}
    </button>
  );
}

/**
 * Which tab holds a type's own canvas: the generic Artifact tab for a Branch,
 * and the Sessions tab for a Session, which hides Artifact (ISS-12167).
 */
const CANVAS_TAB_BY_KIND = {
  branch: ArtifactDetailTab.Artifact,
  session: ArtifactDetailTab.Sessions,
} as const;

const SESSION_CANVAS_LABEL = sessionArtifactTabLabel(
  CANVAS_TAB_BY_KIND.session
);

function labelFor(kind: "branch" | "session", tab: ArtifactDetailTab): string {
  if (kind === "session") {
    return sessionArtifactTabLabel(tab);
  }
  return ARTIFACT_DETAIL_TAB_LABELS[tab];
}
