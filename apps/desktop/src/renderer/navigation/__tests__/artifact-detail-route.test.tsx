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
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../desktop-adapter";
import { createFakeHashHost } from "./hash-host-fixture";

describe("artifact detail routing under the desktop adapter", () => {
  for (const testCase of [
    { kind: "branch" as const, tab: ArtifactDetailTab.Artifact },
    { kind: "branch" as const, tab: ArtifactDetailTab.Details },
    { kind: "branch" as const, tab: ArtifactDetailTab.Sessions },
    { kind: "branch" as const, tab: ArtifactDetailTab.Activity },
    { kind: "session" as const, tab: ArtifactDetailTab.Sessions },
    { kind: "session" as const, tab: ArtifactDetailTab.Details },
    { kind: "session" as const, tab: ArtifactDetailTab.Activity },
  ]) {
    it(`opens the ${testCase.kind} ${testCase.tab} hash deep link`, () => {
      const base =
        testCase.kind === "branch" ? "/branches/b-1" : "/sessions/s-1";
      const host = createFakeHashHost(`#${base}?tab=${testCase.tab}`);
      const navigation = createDesktopNavigation(host);
      render(
        <NavigationProvider adapter={navigation.adapter}>
          <RoutedArtifactShell kind={testCase.kind} />
        </NavigationProvider>
      );

      const label = labelFor(testCase.kind, testCase.tab);
      expect(
        screen.getByRole("tab", { name: label }).getAttribute("aria-selected")
      ).toBe("true");
      expect(
        screen.getByRole("tabpanel", { name: label }).getAttribute("data-state")
      ).toBe("active");
    });
  }

  // An alias resolves to the tab it names, including the `artifact` key
  // ISS-12167 retired for a Session; anything unroutable lands on the type's
  // first tab. Both are that type's canvas here.
  for (const testCase of [
    { kind: "branch" as const, raw: BranchDetailTabParam.BranchDetails },
    { kind: "session" as const, raw: SessionDetailTab.Overview },
    { kind: "session" as const, raw: SessionDetailTab.Trace },
    { kind: "session" as const, raw: ArtifactDetailTab.Artifact },
    { kind: "branch" as const, raw: "unknown" },
    { kind: "session" as const, raw: "unknown" },
  ]) {
    it(`opens the ${testCase.kind} canvas from hash ${testCase.raw}`, () => {
      const base =
        testCase.kind === "branch" ? "/branches/b-1" : "/sessions/s-1";
      const navigation = createDesktopNavigation(
        createFakeHashHost(`#${base}?tab=${testCase.raw}`)
      );
      render(
        <NavigationProvider adapter={navigation.adapter}>
          <RoutedArtifactShell kind={testCase.kind} />
        </NavigationProvider>
      );

      const label = labelFor(testCase.kind, CANVAS_TAB_BY_KIND[testCase.kind]);
      expect(
        screen.getByRole("tab", { name: label }).getAttribute("aria-selected")
      ).toBe("true");
      expect(
        screen.getByRole("tabpanel", { name: label }).getAttribute("data-state")
      ).toBe("active");
    });
  }

  it("restores Branch tabs through renderer back and forward", () => {
    const host = createFakeHashHost(
      "#/branches/b-1?tab=sessions-timeline&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    const navigation = createDesktopNavigation(host);
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <RoutedArtifactShell kind="branch" />
      </NavigationProvider>
    );
    const { result } = renderHook(() => useNavigation(), {
      wrapper: navigationWrapper(navigation),
    });

    expect(
      screen
        .getByRole("tab", { name: "Sessions" })
        .getAttribute("aria-selected")
    ).toBe("true");
    selectTab("Details");
    expect(host.getHash()).toBe(
      "#/branches/b-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(navigation.getHistory()).toHaveLength(2);

    act(() => result.current.back());
    expect(host.getHash()).toBe(
      "#/branches/b-1?tab=sessions-timeline&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(
      screen
        .getByRole("tab", { name: "Sessions" })
        .getAttribute("aria-selected")
    ).toBe("true");
    expect(globalThis.document.activeElement).toBe(
      screen.getByRole("tab", { name: "Sessions" })
    );
    act(() =>
      result.current.replace(
        "/branches/b-1?tab=sessions&file=main&invocationAnchor=row-1&from=session&extra=kept"
      )
    );
    expect(host.getHash()).toBe(
      "#/branches/b-1?tab=sessions&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    act(() => result.current.forward());
    expect(host.getHash()).toBe(
      "#/branches/b-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    expect(screen.getByRole("tabpanel", { name: "Details" }).textContent).toBe(
      "Details panel"
    );
    expect(navigation.getHistory()).toHaveLength(3);
  });

  it("maps a Session Trace permalink to a stable Artifact canvas", () => {
    const host = createFakeHashHost(
      "#/sessions/s-1?tab=trace&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    const navigation = createDesktopNavigation(host);
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <RoutedArtifactShell kind="session" />
      </NavigationProvider>
    );
    const { result } = renderHook(() => useNavigation(), {
      wrapper: navigationWrapper(navigation),
    });

    // ISS-12167: a Session hides the generic Artifact tab; its canvas is the
    // Sessions tab's body, labelled "Session".
    expect(screen.queryByRole("tab", { name: "Artifact" })).toBeNull();
    const canvas = screen.getByRole("button", { name: "Canvas count 0" });
    fireEvent.click(canvas);
    selectTab("Details");
    expect(host.getHash()).toBe(
      "#/sessions/s-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    act(() => result.current.back());
    expect(screen.getByRole("button", { name: "Canvas count 1" })).toBe(canvas);
    expect(host.getHash()).toBe(
      "#/sessions/s-1?tab=trace&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    act(() => result.current.forward());
    expect(host.getHash()).toBe(
      "#/sessions/s-1?tab=details&file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
  });

  it("resets the routed canvas when the host changes Session identity", () => {
    const host = createFakeHashHost("#/sessions/s-1");
    const navigation = createDesktopNavigation(host);
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <RoutedArtifactShell kind="session" />
      </NavigationProvider>
    );
    const { result } = renderHook(() => useNavigation(), {
      wrapper: navigationWrapper(navigation),
    });

    fireEvent.click(screen.getByRole("button", { name: "Canvas count 0" }));
    expect(
      screen.getByRole("button", { name: "Canvas count 1" })
    ).toBeDefined();
    act(() => result.current.navigate("/sessions/s-2"));
    expect(
      screen.getByRole("button", { name: "Canvas count 0" })
    ).toBeDefined();
  });

  it("reveals the mounted Details target once and preserves query context", () => {
    const host = createFakeHashHost(
      "#/sessions/s-1?file=main&invocationAnchor=row-1&from=session&extra=kept"
    );
    const navigation = createDesktopNavigation(host);
    const targets: { hash: string; text: string | null }[] = [];
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <RoutedArtifactShell
          kind="session"
          onReveal={() => {
            const target = screen.getByText("Details panel");
            targets.push({ hash: host.getHash(), text: target.textContent });
            target.focus();
          }}
        />
      </NavigationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal details" }));
    expect(targets).toEqual([
      {
        hash: "#/sessions/s-1?file=main&invocationAnchor=row-1&from=session&extra=kept&tab=details",
        text: "Details panel",
      },
    ]);
    expect(globalThis.document.activeElement).toBe(
      screen.getByText("Details panel")
    );
  });

  it("leaves focus on a revealed target in the kept Artifact canvas", () => {
    const navigation = createDesktopNavigation(
      createFakeHashHost("#/sessions/s-1")
    );
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <RoutedArtifactShell
          kind="session"
          onReveal={() =>
            screen.getByRole("button", { name: "Canvas count 0" }).focus()
          }
          revealTab={ArtifactDetailTab.Sessions}
        />
      </NavigationProvider>
    );
    selectTab("Details");
    fireEvent.click(screen.getByRole("button", { name: "Reveal sessions" }));
    expect(globalThis.document.activeElement).toBe(
      screen.getByRole("button", { name: "Canvas count 0" })
    );
  });
});

function RoutedArtifactShell({
  kind,
  onReveal,
  revealTab = ArtifactDetailTab.Details,
}: {
  kind: "branch" | "session";
  onReveal?: () => void;
  revealTab?: ArtifactDetailTab;
}) {
  const config =
    kind === "branch"
      ? BRANCH_ARTIFACT_ROUTE_CONFIG
      : SESSION_ARTIFACT_ROUTE_CONFIG;
  const { activeTab, setActiveTab, onActivePanelReady, selectTabThenReveal } =
    useArtifactDetailTabRoute<ArtifactDetailTab>(config);
  const path = usePath();
  const canvasTab = CANVAS_TAB_BY_KIND[kind];
  return (
    <ArtifactDetailShell
      activeTab={activeTab}
      headerEnd={
        onReveal && (
          <button
            onClick={() => selectTabThenReveal(revealTab, onReveal)}
            type="button"
          >{`Reveal ${ARTIFACT_DETAIL_TAB_LABELS[revealTab].toLowerCase()}`}</button>
        )
      }
      keepMountedTabs={[canvasTab]}
      key={path}
      onActivePanelReady={onActivePanelReady}
      onActiveTabChange={setActiveTab}
      panels={{
        [ArtifactDetailTab.Artifact]:
          canvasTab === ArtifactDetailTab.Artifact ? (
            <CanvasCounter />
          ) : (
            <p>Artifact panel</p>
          ),
        [ArtifactDetailTab.Details]: <p tabIndex={-1}>Details panel</p>,
        [ArtifactDetailTab.Sessions]:
          canvasTab === ArtifactDetailTab.Sessions ? (
            <CanvasCounter />
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

function CanvasCounter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount((current) => current + 1)} type="button">
      {`Canvas count ${count}`}
    </button>
  );
}

function selectTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

function navigationWrapper(navigation: DesktopNavigation) {
  return ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
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

function labelFor(kind: "branch" | "session", tab: ArtifactDetailTab): string {
  if (kind === "session") {
    return sessionArtifactTabLabel(tab);
  }
  return ARTIFACT_DETAIL_TAB_LABELS[tab];
}
