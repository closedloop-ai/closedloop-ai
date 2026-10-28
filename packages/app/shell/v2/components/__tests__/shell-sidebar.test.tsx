import {
  NavigationActorStanding,
  NavigationCountStatus,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  toNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNavigationSectionModel,
  NavigationControlPlacement,
  type NavigationSectionInput,
} from "../../lib/navigation-section-model";
import { ShellSidebar, type ShellSidebarProps } from "../shell-sidebar";

afterEach(cleanup);

const DASHBOARD_NAME = /Dashboard/;
const SESSIONS_NAME = /Sessions/;
const BRANCHES_NAME = /Branches/;
const LABS_NAME = /Labs/;
const INBOX_NAME = /Inbox/;
const DOCUMENTS_NAME = /Documents/;
const BRANCHES_ARCHIVE_NAME = /Branches Archive/;
const BRANCHES_EXACT_NAME = /^Branches$/;
const WORKSPACE_NAME = /Acme workspace/;

const HIERARCHY: readonly NavigationSectionInput[] = [
  {
    id: "primary",
    label: "Primary",
    collapsible: false,
    defaultOpen: true,
    destinations: [
      {
        id: "dashboard",
        label: "Dashboard",
        href: "/dashboard",
        offeredOnHost: true,
      },
    ],
  },
  {
    id: "artifacts",
    label: "Artifacts",
    collapsible: true,
    defaultOpen: true,
    destinations: [
      {
        id: "sessions",
        label: "Sessions",
        href: "/sessions",
        offeredOnHost: true,
      },
      {
        id: "branches",
        label: "Branches",
        href: "/branches",
        offeredOnHost: true,
      },
    ],
  },
  {
    id: "labs",
    label: "Labs",
    collapsible: true,
    defaultOpen: false,
    destinations: [
      { id: "inbox", label: "Inbox", href: "/inbox", offeredOnHost: true },
    ],
    sections: [
      {
        id: "labs-artifacts",
        label: "Documents",
        collapsible: true,
        defaultOpen: true,
        destinations: [
          {
            id: "documents",
            label: "Documents",
            href: "/documents",
            offeredOnHost: true,
          },
        ],
      },
    ],
  },
];

function readyModel(
  overrides: Partial<NavigationViewModel> = {}
): NavigationViewModel {
  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
    organizationId: "org_1",
    destinations: {
      dashboard: { status: NavigationDestinationStatus.Ready },
      sessions: {
        status: NavigationDestinationStatus.Ready,
        count: toNavigationCount(3),
      },
      branches: { status: NavigationDestinationStatus.Ready },
      inbox: { status: NavigationDestinationStatus.Ready },
      documents: { status: NavigationDestinationStatus.Ready },
    },
    ...overrides,
  };
}

function renderSidebar(
  viewModel: NavigationViewModel,
  persistencePrefix: string,
  activePath = "/dashboard"
): void {
  const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
  render(
    <NavigationProvider adapter={nav.adapter}>
      <SidebarProvider>
        <ShellSidebar
          activePath={activePath}
          sectionPersistenceKeyPrefix={persistencePrefix}
          sections={buildNavigationSectionModel(HIERARCHY, viewModel)}
        />
      </SidebarProvider>
    </NavigationProvider>
  );
}

function visibleNavNames(): string[] {
  return screen
    .getAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "");
}

describe("ShellSidebar", () => {
  it("renders Dashboard primary and Sessions/Branches as launch artifacts", () => {
    renderSidebar(readyModel(), "web");

    expect(screen.getByRole("link", { name: DASHBOARD_NAME })).toHaveAttribute(
      "href",
      expect.stringContaining("/dashboard")
    );
    expect(
      screen.getByRole("link", { name: SESSIONS_NAME })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: BRANCHES_NAME })
    ).toBeInTheDocument();
  });

  it("collapses Labs by default and keeps its destinations reachable from the keyboard", async () => {
    const user = userEvent.setup();
    renderSidebar(readyModel(), "web");

    const labsTrigger = screen.getByRole("button", { name: LABS_NAME });
    expect(labsTrigger).toHaveAttribute("aria-expanded", "false");
    // Closed is the default, so Inbox is not reachable yet. The positive half of
    // this assertion is below — without it, a sidebar that never renders Inbox
    // at all would pass just as happily.
    expect(
      screen.queryByRole("link", { name: INBOX_NAME })
    ).not.toBeInTheDocument();

    labsTrigger.focus();
    await user.keyboard("{Enter}");

    expect(labsTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: INBOX_NAME })).toBeInTheDocument();
    // The nested Labs group survives the move rather than being flattened away.
    expect(
      screen.getByRole("link", { name: DOCUMENTS_NAME })
    ).toBeInTheDocument();
  });

  it("renders a badge only for a settled non-zero count", () => {
    renderSidebar(readyModel(), "web");

    const sessions = screen.getByRole("link", { name: SESSIONS_NAME });
    expect(within(sessions).getByText("3")).toBeInTheDocument();

    cleanup();
    renderSidebar(
      readyModel({
        destinations: {
          sessions: {
            status: NavigationDestinationStatus.Ready,
            count: { status: NavigationCountStatus.Pending },
          },
          dashboard: { status: NavigationDestinationStatus.Ready },
          branches: { status: NavigationDestinationStatus.Ready },
        },
      }),
      "web"
    );

    // The counterfactual: same row, same locator, opposite state. A count that
    // has not landed renders no badge rather than a "0" that reads as measured.
    const pendingSessions = screen.getByRole("link", { name: SESSIONS_NAME });
    expect(within(pendingSessions).queryByText("0")).not.toBeInTheDocument();
    expect(within(pendingSessions).queryByText("3")).not.toBeInTheDocument();
  });

  it("states an unresolved destination in words, not by styling alone", () => {
    renderSidebar(
      readyModel({ projectionStatus: NavigationProjectionStatus.Error }),
      "web"
    );

    const dashboard = screen.getByRole("button", { name: DASHBOARD_NAME });
    // WCAG 1.4.1: the state has to survive for a reader who cannot compare two
    // shades, so it is text inside the row's accessible name.
    expect(dashboard).toHaveAccessibleName(
      expect.stringContaining("Unavailable")
    );
    expect(dashboard).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("link", { name: DASHBOARD_NAME })
    ).not.toBeInTheDocument();
  });

  it("distinguishes a loading destination from an unavailable one", () => {
    renderSidebar(
      readyModel({ projectionStatus: NavigationProjectionStatus.Pending }),
      "web"
    );

    expect(
      screen.getByRole("button", { name: DASHBOARD_NAME })
    ).toHaveAccessibleName(expect.stringContaining("Loading"));
  });

  it("renders no badge on the row the user is already on", () => {
    // Same model, same settled count of 3 the first badge case asserts — only
    // the open route differs. A navigation count says what is NEW since the last
    // visit, and arriving is what drains it, so a number on the open route is
    // stale in the frame it renders.
    renderSidebar(readyModel(), "web", "/sessions");

    const sessions = screen.getByRole("link", { name: SESSIONS_NAME });
    expect(sessions).toHaveAttribute("data-active", "true");
    expect(within(sessions).queryByText("3")).not.toBeInTheDocument();
    // The row is untouched otherwise: suppressing the badge must not cost the
    // destination.
    expect(sessions).toHaveAttribute(
      "href",
      expect.stringContaining("/sessions")
    );
  });

  it("renders no badge for a settled count of zero", () => {
    renderSidebar(
      readyModel({
        destinations: {
          dashboard: { status: NavigationDestinationStatus.Ready },
          sessions: {
            status: NavigationDestinationStatus.Ready,
            count: toNavigationCount(0),
          },
          branches: { status: NavigationDestinationStatus.Ready },
        },
      }),
      "web"
    );

    // A measured zero is real data, but an empty badge is noise — and rendering
    // one here would make "nothing new" indistinguishable from "we do not know".
    const sessions = screen.getByRole("link", { name: SESSIONS_NAME });
    expect(within(sessions).queryByText("0")).not.toBeInTheDocument();
  });

  it("marks only the open destination active, not a sibling it prefixes", () => {
    const hierarchy: readonly NavigationSectionInput[] = [
      {
        id: "primary",
        label: "Primary",
        collapsible: false,
        defaultOpen: true,
        destinations: [
          {
            id: "branches",
            label: "Branches",
            href: "/branches",
            offeredOnHost: true,
          },
          {
            id: "branches-archive",
            label: "Branches Archive",
            href: "/branches-archive",
            offeredOnHost: true,
          },
        ],
      },
    ];
    const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <SidebarProvider>
          <ShellSidebar
            activePath="/branches-archive"
            sections={buildNavigationSectionModel(
              hierarchy,
              readyModel({
                destinations: {
                  branches: { status: NavigationDestinationStatus.Ready },
                  "branches-archive": {
                    status: NavigationDestinationStatus.Ready,
                  },
                },
              })
            )}
          />
        </SidebarProvider>
      </NavigationProvider>
    );

    // A bare `startsWith` lights both. The active row must be the one actually
    // open, or the sidebar reports two current locations at once.
    expect(
      screen.getByRole("link", { name: BRANCHES_ARCHIVE_NAME })
    ).toHaveAttribute("data-active", "true");
    expect(
      screen.getByRole("link", { name: BRANCHES_EXACT_NAME })
    ).toHaveAttribute("data-active", "false");
  });

  it("keeps an unresolved destination focusable so a keyboard user can still find it", () => {
    renderSidebar(
      readyModel({ projectionStatus: NavigationProjectionStatus.Error }),
      "web"
    );

    const dashboard = screen.getByRole("button", { name: DASHBOARD_NAME });
    // `aria-disabled` marks it inert; the NATIVE `disabled` attribute would also
    // drop it out of the tab order, making the rows this branch exists to keep
    // visible the ones a keyboard user cannot reach.
    expect(dashboard).not.toBeDisabled();
    dashboard.focus();
    expect(dashboard).toHaveFocus();
  });

  it("names each destination once", () => {
    renderSidebar(readyModel(), "web");

    // A row that states its label in a visible span AND repeats it in a badge or
    // chip says the same thing twice to a screen reader.
    const dashboard = screen.getByRole("link", { name: DASHBOARD_NAME });
    expect(within(dashboard).getAllByText("Dashboard")).toHaveLength(1);
  });

  it("renders the same hierarchy for two surfaces given the same view model", () => {
    renderSidebar(readyModel(), "web");
    const web = visibleNavNames();

    cleanup();
    // A different persistence namespace is exactly what differs between the two
    // adapters; the hierarchy must not move because of it.
    renderSidebar(readyModel(), "desktop");
    const desktop = visibleNavNames();

    expect(desktop).toEqual(web);
    expect(web).toEqual(["Dashboard", "Sessions3", "Branches"]);
  });
});

describe("ShellSidebar — host slots and controls", () => {
  it("renders the leading slot inside the sidebar root, before the workspace header", () => {
    renderShellSidebar({
      leading: <div data-testid="drag-strip" />,
      sections: [],
      workspaceHeader: <button type="button">Acme workspace</button>,
    });

    const strip = screen.getByTestId("drag-strip");
    const header = screen.getByRole("button", { name: WORKSPACE_NAME });

    expect(strip.closest('[data-sidebar="sidebar"]')).not.toBeNull();
    expect(strip.compareDocumentPosition(header)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("renders host controls where the model places them, in model order", () => {
    renderShellSidebar({
      renderControl: (controlId) => (
        <div data-testid={`control-${controlId}`} />
      ),
      sections: controlledSections(),
    });

    const order = Array.from(
      document.body.querySelectorAll('[data-testid^="control-"], a')
    ).map(
      (element) =>
        element.getAttribute("data-testid") ?? element.textContent?.trim()
    );

    expect(order).toEqual([
      "control-search",
      "Inbox",
      "control-compute",
      "control-dev-mode",
    ]);
  });

  it("renders a nested headless section inline, with no second group inset", () => {
    renderShellSidebar({
      renderControl: (controlId) => (
        <div data-testid={`control-${controlId}`} />
      ),
      sections: controlledSections(),
    });

    expect(groupAncestorCount(screen.getByTestId("control-dev-mode"))).toBe(1);
  });

  it.each([
    [1, "1 recently finished session"],
    [2, "2 recently finished sessions"],
  ])(
    "names a count of %i with the matching form of its noun",
    (count, name) => {
      renderShellSidebar({
        sections: buildNavigationSectionModel(
          [
            {
              id: "labs",
              label: "Labs",
              collapsible: false,
              defaultOpen: true,
              destinations: [
                {
                  id: "agents",
                  label: "Agents",
                  href: "/agents",
                  offeredOnHost: true,
                  countNoun: {
                    one: "recently finished session",
                    other: "recently finished sessions",
                  },
                },
              ],
            },
          ],
          readyModel({
            destinations: {
              agents: {
                status: NavigationDestinationStatus.Ready,
                count: toNavigationCount(count),
              },
            },
          })
        ),
      });

      expect(screen.getByRole("status")).toHaveAccessibleName(name);
    }
  );
});

function renderShellSidebar(props: ShellSidebarProps): void {
  const nav = createMemoryNavigation({ initialPath: "/", orgSlug: "acme" });
  render(
    <NavigationProvider adapter={nav.adapter}>
      <SidebarProvider>
        <ShellSidebar {...props} />
      </SidebarProvider>
    </NavigationProvider>
  );
}

/**
 * A non-collapsible Labs holding a leading control, one row, a trailing control,
 * and a nested headless footer group whose only content is a control.
 */
function controlledSections() {
  return buildNavigationSectionModel(
    [
      {
        id: "labs",
        label: "Labs",
        collapsible: false,
        defaultOpen: true,
        destinations: [
          { id: "inbox", label: "Inbox", href: "/inbox", offeredOnHost: true },
        ],
        controls: [
          {
            id: "search",
            offeredOnHost: true,
            placement: NavigationControlPlacement.Leading,
          },
          {
            id: "compute",
            offeredOnHost: true,
            placement: NavigationControlPlacement.Trailing,
          },
        ],
        sections: [
          {
            id: "labs-footer",
            label: "Footer",
            collapsible: false,
            defaultOpen: true,
            controls: [{ id: "dev-mode", offeredOnHost: true }],
          },
        ],
      },
    ],
    readyModel()
  );
}

function groupAncestorCount(element: HTMLElement): number {
  let count = 0;
  for (
    let node = element.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    if (node.dataset.sidebar === "group") {
      count += 1;
    }
  }
  return count;
}
