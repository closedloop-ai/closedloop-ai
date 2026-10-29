import {
  ArtifactDetailNoticeTone,
  ArtifactDetailShell,
  type ArtifactDetailShellProps,
  ArtifactDetailTabStateKind,
  resolveArtifactDetailTab,
} from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ARTIFACT_DETAIL_TABS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-10790. Every assertion goes through the accessibility tree or visible
 * text, because the adoption tickets (ISS-10796/10797) depend on what a user
 * and a screen reader get, not on the shell's internals.
 */

const ALL_TABS = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;
/** A type that does not configure the Sessions tab, whatever else it has. */
const TABS_WITHOUT_SESSIONS = [
  ArtifactDetailTab.Artifact,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;
/** Session's own set: it hides Artifact and keeps Sessions (ISS-12167). */
const SESSION_TABS = [
  ArtifactDetailTab.Sessions,
  ArtifactDetailTab.Details,
  ArtifactDetailTab.Activity,
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bodiesFor<Tab extends ArtifactDetailTab>(tabs: readonly Tab[]) {
  return Object.fromEntries(
    tabs.map((tab) => [tab, <p key={tab}>{`${tab} body`}</p>])
  ) as Record<Tab, React.ReactNode>;
}

function Harness<Tab extends ArtifactDetailTab>(
  props: Partial<ArtifactDetailShellProps<Tab>> & {
    initialTab?: ArtifactDetailTab;
    tabs: readonly Tab[];
  }
) {
  const { initialTab, onActiveTabChange, tabs, ...rest } = props;
  const [activeTab, setActiveTab] = useState<ArtifactDetailTab>(
    initialTab ?? tabs[0] ?? ArtifactDetailTab.Artifact
  );
  return (
    <ArtifactDetailShell
      activeTab={activeTab}
      onActiveTabChange={(tab) => {
        setActiveTab(tab);
        onActiveTabChange?.(tab);
      }}
      panels={bodiesFor(tabs)}
      tabs={tabs}
      {...rest}
    />
  );
}

describe("tab constants", () => {
  it("orders every tab key exactly once, each with a label", () => {
    expect([...ARTIFACT_DETAIL_TABS].sort()).toEqual(
      Object.values(ArtifactDetailTab).sort()
    );
    expect(Object.keys(ARTIFACT_DETAIL_TAB_LABELS).sort()).toEqual(
      Object.values(ArtifactDetailTab).sort()
    );
  });
});

describe("resolveArtifactDetailTab", () => {
  it("keeps a configured tab", () => {
    expect(
      resolveArtifactDetailTab(
        ArtifactDetailTab.Activity,
        TABS_WITHOUT_SESSIONS
      )
    ).toBe(ArtifactDetailTab.Activity);
  });

  it("falls back to the first configured tab for one the type lacks", () => {
    expect(
      resolveArtifactDetailTab(
        ArtifactDetailTab.Sessions,
        TABS_WITHOUT_SESSIONS
      )
    ).toBe(ArtifactDetailTab.Artifact);
  });
});

describe("ArtifactDetailShell", () => {
  it("renders the four tabs in order under a named tab list", () => {
    render(<Harness tabs={ALL_TABS} />);

    const list = screen.getByRole("tablist", {
      name: "Artifact detail sections",
    });
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Artifact",
      "Sessions",
      "Details",
      "Activity",
    ]);
  });

  it("prefers a host's own wording for a tab, keeping its key", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initialTab={ArtifactDetailTab.Sessions}
        tabLabels={{ [ArtifactDetailTab.Sessions]: "Session" }}
        tabs={SESSION_TABS}
      />
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Session",
      "Details",
      "Activity",
    ]);
    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.click(screen.getByRole("tab", { name: "Session" }));

    expect(screen.getByRole("tabpanel", { name: "Session" })).toHaveTextContent(
      "sessions body"
    );
  });

  it("renders nothing for a tab the type does not have", () => {
    render(<Harness tabs={TABS_WITHOUT_SESSIONS} />);

    expect(
      screen.queryByRole("tab", { name: "Sessions" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("sessions body")).not.toBeInTheDocument();
  });

  it("shows the selected tab's body in a labelled tab panel", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onActiveTabChange={onChange} tabs={ALL_TABS} />);

    await user.click(screen.getByRole("tab", { name: "Details" }));

    expect(onChange).toHaveBeenCalledWith(ArtifactDetailTab.Details);
    const panel = screen.getByRole("tabpanel", { name: "Details" });
    expect(panel).toHaveTextContent("details body");
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("never reveals a tab the type lacks when activeTab names one", () => {
    render(
      <Harness
        initialTab={ArtifactDetailTab.Sessions}
        tabs={TABS_WITHOUT_SESSIONS}
      />
    );

    expect(screen.getByRole("tab", { name: "Artifact" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("artifact body")).toBeVisible();
  });

  it("does not report the fallback as a tab change", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initialTab={ArtifactDetailTab.Sessions}
        onActiveTabChange={onChange}
        tabs={TABS_WITHOUT_SESSIONS}
      />
    );

    expect(onChange).not.toHaveBeenCalled();
  });

  it("falls back when the host removes the active tab while mounted", () => {
    const panels = bodiesFor(ALL_TABS);
    const onChange = vi.fn();
    const { rerender } = render(
      <ArtifactDetailShell
        activeTab={ArtifactDetailTab.Sessions}
        onActiveTabChange={onChange}
        panels={panels}
        tabs={ALL_TABS}
      />
    );
    expect(screen.getByText("sessions body")).toBeVisible();

    rerender(
      <ArtifactDetailShell
        activeTab={ArtifactDetailTab.Sessions}
        onActiveTabChange={onChange}
        panels={bodiesFor(TABS_WITHOUT_SESSIONS)}
        tabs={TABS_WITHOUT_SESSIONS}
      />
    );

    expect(
      screen.queryByRole("tab", { name: "Sessions" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Artifact" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("artifact body")).toBeVisible();
  });

  it("does not mount a tab until it is first opened", () => {
    render(<Harness tabs={ALL_TABS} />);

    expect(screen.queryByText("activity body")).not.toBeInTheDocument();
  });

  it("unmounts an inactive tab by default", async () => {
    const user = userEvent.setup();
    render(<Harness tabs={ALL_TABS} />);

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    await user.click(screen.getByRole("tab", { name: "Details" }));

    // Matches today's Session and Branch pages: a tab the user left does not
    // keep its subtree (and its queries) alive.
    expect(screen.queryByText("sessions body")).not.toBeInTheDocument();
    expect(screen.getByText("details body")).toBeVisible();
  });

  it("keeps a tab the host opts in mounted, hidden, when another is selected", async () => {
    const user = userEvent.setup();
    render(
      <Harness keepMountedTabs={[ArtifactDetailTab.Sessions]} tabs={ALL_TABS} />
    );

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    await user.click(screen.getByRole("tab", { name: "Details" }));

    const sessionsBody = screen.getByText("sessions body");
    expect(sessionsBody).toBeInTheDocument();
    expect(sessionsBody).not.toBeVisible();
    expect(screen.getByText("details body")).toBeVisible();
  });

  it("keeps the component state of a tab across a switch", async () => {
    const user = userEvent.setup();
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button onClick={() => setCount(count + 1)} type="button">
          {`Clicked ${count}`}
        </button>
      );
    }
    render(
      <Harness
        keepMountedTabs={[ArtifactDetailTab.Artifact]}
        panels={{
          artifact: <Counter />,
          details: <p>details body</p>,
          sessions: <p>sessions body</p>,
          activity: <p>activity body</p>,
        }}
        tabs={ALL_TABS}
      />
    );

    await user.click(screen.getByRole("button", { name: "Clicked 0" }));
    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.click(screen.getByRole("tab", { name: "Artifact" }));

    expect(screen.getByRole("button", { name: "Clicked 1" })).toBeVisible();
  });

  it("replaces an unsupported tab's body with a state distinct from empty", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        tabStates={{
          activity: {
            description: "host description",
            kind: ArtifactDetailTabStateKind.Unsupported,
            title: "host title",
          },
        }}
        tabs={ALL_TABS}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Activity" }));

    // The shell renders only the host's wording; it ships none of its own.
    expect(screen.getByText("host title")).toBeVisible();
    expect(screen.getByText("host description")).toBeVisible();
    expect(screen.queryByText("activity body")).not.toBeInTheDocument();
    // The tab itself stays in the bar -- unsupported is never hidden.
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument();
  });

  it("keeps a stale tab's body under a notice with its action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <Harness
        initialTab={ArtifactDetailTab.Details}
        tabStates={{
          details: {
            action: { label: "Retry", onSelect: onRetry },
            kind: ArtifactDetailTabStateKind.Stale,
            title: "Latest details unavailable",
            tone: ArtifactDetailNoticeTone.Warning,
          },
        }}
        tabs={ALL_TABS}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Latest details unavailable"
    );
    expect(screen.getByText("details body")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the notice at the severity the host chooses", () => {
    render(
      <Harness
        tabStates={{
          artifact: {
            kind: ArtifactDetailTabStateKind.Partial,
            title: "host error notice",
            tone: ArtifactDetailNoticeTone.Error,
          },
        }}
        tabs={ALL_TABS}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("host error notice");
    // The shell passes the host's tone straight to the Alert variant rather
    // than downgrading every notice to a warning.
    expect(alert.className).toContain("bg-destructive/12");
    expect(alert.className).not.toContain("bg-warning/12");
  });

  it("shows header actions only on the tabs the host names", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        headerActions={<button type="button">Refresh</button>}
        headerActionsTabs={[
          ArtifactDetailTab.Artifact,
          ArtifactDetailTab.Activity,
        ]}
        headerEnd={<span>3 collaborators</span>}
        tabs={ALL_TABS}
      />
    );

    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(
      screen.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("3 collaborators")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  it("defaults header actions to the Artifact tab", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        headerActions={<button type="button">Refresh</button>}
        tabs={ALL_TABS}
      />
    );

    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(
      screen.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
  });

  it("mounts whatever the host passes as comments beside the panels", () => {
    render(
      <Harness
        comments={<aside aria-label="Comments">rail</aside>}
        tabs={ALL_TABS}
      />
    );

    expect(
      screen.getByRole("complementary", { name: "Comments" })
    ).toBeVisible();
  });

  it("moves between tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<Harness tabs={ALL_TABS} />);

    act(() => screen.getByRole("tab", { name: "Artifact" }).focus());
    await user.keyboard("{ArrowRight}");

    const sessions = screen.getByRole("tab", { name: "Sessions" });
    expect(sessions).toHaveFocus();
    expect(sessions).toHaveAttribute("aria-selected", "true");
  });

  it("skips the absent Sessions tab during keyboard navigation", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initialTab={ArtifactDetailTab.Details}
        tabs={TABS_WITHOUT_SESSIONS}
      />
    );

    act(() => screen.getByRole("tab", { name: "Details" }).focus());
    await user.keyboard("{ArrowRight}");

    const activity = screen.getByRole("tab", { name: "Activity" });
    expect(activity).toHaveFocus();
    expect(activity).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Sessions" })).toBeNull();
  });

  it("restores focus to the selected trigger after a controlled tab change", () => {
    const panels = bodiesFor(ALL_TABS);
    const onChange = vi.fn();
    const { rerender } = render(
      <ArtifactDetailShell
        activeTab={ArtifactDetailTab.Artifact}
        onActiveTabChange={onChange}
        panels={panels}
        tabs={ALL_TABS}
      />
    );
    const details = screen.getByRole("tab", { name: "Details" });

    rerender(
      <ArtifactDetailShell
        activeTab={ArtifactDetailTab.Details}
        onActiveTabChange={onChange}
        panels={panels}
        tabs={ALL_TABS}
      />
    );

    expect(details).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Details" })).toHaveTextContent(
      "details body"
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reveals a cold selected tab by scrolling only its horizontal viewport", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(
      function (this: Element) {
        return this.getAttribute("data-slot") ===
          "artifact-detail-tabs-viewport"
          ? 100
          : 0;
      }
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (
          this.getAttribute("data-slot") === "artifact-detail-tabs-viewport"
        ) {
          return new DOMRect(10, 1000, 100, 48);
        }
        if (
          this.getAttribute("role") === "tab" &&
          this.textContent === "Activity"
        ) {
          const viewport = this.closest<HTMLDivElement>(
            '[data-slot="artifact-detail-tabs-viewport"]'
          );
          return new DOMRect(160 - (viewport?.scrollLeft ?? 0), 1000, 40, 40);
        }
        return new DOMRect(10, 1000, 200, 48);
      }
    );
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<Harness initialTab={ArtifactDetailTab.Activity} tabs={ALL_TABS} />);
    const activity = screen.getByRole("tab", { name: "Activity" });
    const viewport = activity.closest<HTMLDivElement>(
      '[data-slot="artifact-detail-tabs-viewport"]'
    );

    expect(viewport?.scrollLeft).toBe(90);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(activity).not.toHaveFocus();
  });

  it("does not take focus on a cold deep link", () => {
    const external = globalThis.document.createElement("button");
    globalThis.document.body.append(external);
    external.focus();
    try {
      render(
        <Harness initialTab={ArtifactDetailTab.Activity} tabs={ALL_TABS} />
      );
      expect(external).toHaveFocus();
      expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    } finally {
      external.remove();
    }
  });

  it("keeps the tab list inside a horizontal overflow viewport", () => {
    render(<Harness tabs={ALL_TABS} />);

    const viewport = screen
      .getByRole("tablist", { name: "Artifact detail sections" })
      .closest('[data-slot="artifact-detail-tabs-viewport"]');
    expect(viewport).toHaveClass("overflow-x-auto");
    expect(viewport).toContainElement(
      screen.getByRole("tab", { name: "Activity" })
    );
  });

  it("reports panel readiness for selection without refiring on header updates", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn();
    const { rerender } = render(
      <Harness
        headerEnd={<span>Header fixture</span>}
        onActivePanelReady={onReady}
        tabs={ALL_TABS}
      />
    );
    expect(onReady.mock.calls).toEqual([[ArtifactDetailTab.Artifact]]);
    rerender(
      <Harness
        headerEnd={<span>Changed header fixture</span>}
        onActivePanelReady={onReady}
        tabs={ALL_TABS}
      />
    );
    expect(onReady.mock.calls).toEqual([[ArtifactDetailTab.Artifact]]);
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(onReady.mock.calls).toEqual([
      [ArtifactDetailTab.Artifact],
      [ArtifactDetailTab.Details],
    ]);
  });
});
