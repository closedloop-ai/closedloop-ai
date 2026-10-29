import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactDetailShell } from "../artifact-detail-shell";
import {
  ARTIFACT_DETAIL_PANEL_READY_REQUIRED,
  useArtifactDetailTabRoute,
} from "../use-artifact-detail-tab-route";

const TABS = [ArtifactDetailTab.Artifact, ArtifactDetailTab.Details] as const;

describe("useArtifactDetailTabRoute", () => {
  it("reports missing panel-ready wiring before navigation instead of losing a reveal", () => {
    const initial = "/sessions/s-1?file=main&from=session";
    const navigation = createMemoryNavigation({ initialPath: initial });
    const onError = vi.fn();
    const onReveal = vi.fn();
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <BindingErrorBoundary onError={onError}>
          <Harness omitReadyBinding onReveal={onReveal} />
        </BindingErrorBoundary>
      </NavigationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal details" }));

    expect(screen.getByText("Fixture binding error")).toBeVisible();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: ARTIFACT_DETAIL_PANEL_READY_REQUIRED })
    );
    expect(navigation.getCurrentHref()).toBe(initial);
    expect(navigation.getHistory()).toEqual([initial]);
    expect(onReveal).not.toHaveBeenCalled();
  });
  it("selects the holding tab before revealing a comment target", () => {
    const navigation = createMemoryNavigation({ initialPath: "/sessions/s-1" });
    const observations: { href: string; target: string | null }[] = [];
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Harness
          onReveal={() =>
            observations.push({
              href: navigation.getCurrentHref(),
              target: screen.queryByText("Details target")?.textContent ?? null,
            })
          }
        />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal details" }));

    expect(screen.getByRole("tabpanel", { name: "Details" })).toBeVisible();
    expect(observations).toEqual([
      {
        href: "/sessions/s-1?tab=details",
        target: "Details target",
      },
    ]);
    expect(navigation.getHistory()).toHaveLength(2);
  });

  it("reveals immediately without a duplicate entry when the tab is active", () => {
    const navigation = createMemoryNavigation({
      initialPath: "/sessions/s-1?tab=details",
    });
    const onReveal = vi.fn();
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Harness onReveal={onReveal} />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal details" }));

    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(navigation.getHistory()).toEqual(["/sessions/s-1?tab=details"]);
  });

  for (const nextHref of [
    "/sessions/s-2?tab=details",
    "/sessions/s-1?tab=activity",
  ]) {
    it(`cancels a delayed reveal superseded by ${nextHref}`, () => {
      const navigation = createMemoryNavigation({
        initialPath: "/sessions/s-1",
      });
      const readActions = navigation.adapter.useNavigationActions;
      const request = vi.fn();
      const delayedActions = { ...readActions(), navigate: request };
      const adapter = {
        ...navigation.adapter,
        useNavigationActions: () => delayedActions,
      };
      const onReveal = vi.fn();
      render(
        <NavigationProvider adapter={adapter}>
          <Harness onReveal={onReveal} />
        </NavigationProvider>
      );
      fireEvent.click(screen.getByRole("button", { name: "Reveal details" }));
      expect(request).toHaveBeenCalledWith("/sessions/s-1?tab=details", {
        scroll: false,
      });
      expect(onReveal).not.toHaveBeenCalled();
      act(() => navigation.navigate(nextHref));
      act(() => navigation.navigate(`${nextHref.split("?")[0]}?tab=details`));
      expect(onReveal).not.toHaveBeenCalled();
    });
  }

  it("ignores a reveal target outside the configured inventory", () => {
    const navigation = createMemoryNavigation({ initialPath: "/sessions/s-1" });
    const onReveal = vi.fn();
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Harness onReveal={onReveal} />
      </NavigationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal hidden" }));
    expect(navigation.getCurrentHref()).toBe("/sessions/s-1");
    expect(onReveal).not.toHaveBeenCalled();
  });
});

function Harness({
  onReveal,
  omitReadyBinding = false,
}: {
  onReveal: () => void;
  omitReadyBinding?: boolean;
}) {
  const { activeTab, setActiveTab, selectTabThenReveal, onActivePanelReady } =
    useArtifactDetailTabRoute<ArtifactDetailTab>({
      tabs: [...TABS, ArtifactDetailTab.Activity],
    });
  return (
    <div>
      <ArtifactDetailShell
        activeTab={activeTab}
        onActivePanelReady={omitReadyBinding ? undefined : onActivePanelReady}
        onActiveTabChange={setActiveTab}
        panels={{
          [ArtifactDetailTab.Artifact]: <p>Artifact target</p>,
          [ArtifactDetailTab.Details]: <p>Details target</p>,
          [ArtifactDetailTab.Activity]: <p>Activity target</p>,
        }}
        tabs={[...TABS, ArtifactDetailTab.Activity]}
      />
      <button
        onClick={() => selectTabThenReveal(ArtifactDetailTab.Details, onReveal)}
        type="button"
      >
        Reveal details
      </button>
      <button
        onClick={() =>
          selectTabThenReveal(ArtifactDetailTab.Sessions, onReveal)
        }
        type="button"
      >
        Reveal hidden
      </button>
    </div>
  );
}

class BindingErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.error ? (
      <p>Fixture binding error</p>
    ) : (
      this.props.children
    );
  }
}
