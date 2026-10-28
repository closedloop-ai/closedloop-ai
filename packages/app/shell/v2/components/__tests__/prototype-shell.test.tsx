import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { READY_WORKSPACE_MENU_PROJECTION } from "@repo/app/shared/workspace-menu-host/workspace-menu-host-fixtures";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PrototypeShell } from "../prototype-shell";
import {
  PROTOTYPE_SHELL_NAVIGATION_ICONS,
  PROTOTYPE_SHELL_NAVIGATION_SECTIONS,
} from "../prototype-shell-navigation";

afterEach(cleanup);

const SESSIONS_NAME = /^Sessions$/;
const BRANCHES_NAME = /^Branches$/;
const SWITCH_WORKSPACE_NAME = new RegExp(
  `^${WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SwitchWorkspace]}$`
);
// Named from the same fixture the shell's adapter projects, so a renamed
// workspace cannot leave this matching nothing.
const OTHER_WORKSPACE = READY_WORKSPACE_MENU_PROJECTION.workspaces.find(
  (workspace) =>
    workspace.id !== READY_WORKSPACE_MENU_PROJECTION.activeWorkspace.id
);
const OTHER_WORKSPACE_NAME = new RegExp(OTHER_WORKSPACE?.name ?? "");

function navRow(name: RegExp): HTMLElement {
  return screen.getByRole("link", { name });
}

describe("PrototypeShell", () => {
  it("mounts the fixture nav, the breadcrumb trail, and the content", () => {
    render(
      <PrototypeShell
        activePath="/sessions"
        breadcrumbs={[
          { label: "Sessions" },
          { isCurrent: true, label: "Cost" },
        ]}
      >
        <p>Prototype content</p>
      </PrototypeShell>
    );

    expect(screen.getByText("Prototype content")).toBeInTheDocument();
    // The current crumb is a page, not a link — the only crumb that is not
    // navigable.
    expect(screen.getByText("Cost")).toHaveAttribute("aria-current", "page");
    expect(navRow(SESSIONS_NAME)).toHaveAttribute("data-active", "true");
    expect(navRow(BRANCHES_NAME)).toHaveAttribute("data-active", "false");
  });

  it("moves the active row to the one that was clicked", async () => {
    const user = userEvent.setup();
    render(
      <PrototypeShell activePath="/sessions" breadcrumbs={[{ label: "S" }]}>
        <p>Content</p>
      </PrototypeShell>
    );

    await user.click(navRow(BRANCHES_NAME));

    // The memory adapter cancels browser navigation and updates its own path.
    // Reading `activePath` from the prop instead of that store left Sessions
    // highlighted here, so the nav looked interactive without reflecting state.
    expect(navRow(BRANCHES_NAME)).toHaveAttribute("data-active", "true");
    expect(navRow(SESSIONS_NAME)).toHaveAttribute("data-active", "false");
  });

  it("resolves breadcrumbs from the live memory-navigation path", async () => {
    const user = userEvent.setup();
    render(
      <PrototypeShell
        activePath="/sessions"
        breadcrumbs={(currentPath) => [{ isCurrent: true, label: currentPath }]}
      >
        <p>Content</p>
      </PrototypeShell>
    );

    expect(screen.getByText("/sessions")).toHaveAttribute(
      "aria-current",
      "page"
    );

    await user.click(navRow(BRANCHES_NAME));

    expect(screen.getByText("/branches")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("routes linked breadcrumbs through the memory adapter", async () => {
    const user = userEvent.setup();
    render(
      <PrototypeShell
        activePath="/sessions/detail"
        breadcrumbs={(currentPath) =>
          currentPath === "/sessions"
            ? [{ isCurrent: true, label: "Sessions" }]
            : [
                { href: "/sessions", label: "Sessions" },
                { isCurrent: true, label: "Detail" },
              ]
        }
      >
        <p>Content</p>
      </PrototypeShell>
    );

    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    await user.click(
      within(breadcrumb).getByRole("link", { name: "Sessions" })
    );

    expect(within(breadcrumb).getByText("Sessions")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("lets a caller adapt the content region without replacing shell chrome", () => {
    render(
      <PrototypeShell
        breadcrumbs={[{ isCurrent: true, label: "Sessions" }]}
        contentClassName="overflow-hidden p-0"
      >
        <p>Content</p>
      </PrototypeShell>
    );

    expect(screen.getByText("Content").parentElement).toHaveClass(
      "overflow-hidden",
      "p-0"
    );
  });

  it("renders an icon for every destination the fixture declares", () => {
    render(
      <PrototypeShell breadcrumbs={[{ isCurrent: true, label: "Home" }]}>
        <p>Content</p>
      </PrototypeShell>
    );

    const destinationIds = PROTOTYPE_SHELL_NAVIGATION_SECTIONS.flatMap(
      (section) => section.entries.map((entry) => entry.id)
    );
    expect(destinationIds.length).toBeGreaterThan(0);
    for (const id of destinationIds) {
      expect(PROTOTYPE_SHELL_NAVIGATION_ICONS).toHaveProperty(id);
    }
    // Every nav row carries a rendered glyph, so a destination whose icon went
    // missing is visible here as a blank row, not only at `tsc`.
    const labels = PROTOTYPE_SHELL_NAVIGATION_SECTIONS.flatMap((section) =>
      section.entries.map((entry) => entry.label)
    );
    for (const label of labels) {
      const row = screen.getByRole("link", {
        name: new RegExp(`^${label}$`),
      });
      expect(row.querySelector("svg")).not.toBeNull();
    }
  });

  it("marks no row active when activePath names no destination", () => {
    render(
      <PrototypeShell
        activePath="/not-a-destination"
        breadcrumbs={[{ isCurrent: true, label: "Home" }]}
      >
        <p>Content</p>
      </PrototypeShell>
    );

    expect(navRow(SESSIONS_NAME)).toHaveAttribute("data-active", "false");
    expect(navRow(BRANCHES_NAME)).toHaveAttribute("data-active", "false");
  });

  describe("account area (ISS-10391)", () => {
    function renderShell(): void {
      render(
        <PrototypeShell activePath="/sessions" breadcrumbs={[{ label: "S" }]}>
          <p>Content</p>
        </PrototypeShell>
      );
    }

    it("mounts the real workspace menu at the top of the sidebar, above the nav", () => {
      renderShell();

      const trigger = screen.getByRole("button", {
        name: WORKSPACE_MENU_TRIGGER_LABEL,
      });
      expect(trigger).toHaveTextContent("Closedloop");

      // Where production puts it (`workspaceHeader`), not the old footer.
      const order = [...document.querySelectorAll("a, button")];
      expect(order.indexOf(trigger)).toBeLessThan(
        order.indexOf(navRow(SESSIONS_NAME))
      );
    });

    it("opens the real menu, not an inert mock", async () => {
      const user = userEvent.setup();
      renderShell();

      await user.click(
        screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
      );

      expect(await screen.findByRole("menu")).toBeInTheDocument();
    });

    it("switches the active workspace, so the trigger follows the click", async () => {
      const user = userEvent.setup();
      renderShell();

      await user.click(
        screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
      );
      await user.click(
        await screen.findByRole("menuitem", { name: SWITCH_WORKSPACE_NAME })
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: OTHER_WORKSPACE_NAME })
      );

      // The fixture is stateful on purpose: an offered action that resolves
      // without moving the projection is the menu lying about what it did.
      expect(
        screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
      ).toHaveTextContent(OTHER_WORKSPACE_NAME);
    });

    it("offers no entry it has no mock state for", async () => {
      const user = userEvent.setup();
      renderShell();

      await user.click(
        screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL })
      );

      // Positive controls on the same locator: entries that DO resolve are
      // present, so the two absences below are a projection decision rather
      // than a query that never matched anything.
      expect(
        await screen.findByRole("menuitem", { name: SWITCH_WORKSPACE_NAME })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", {
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings],
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", {
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut],
        })
      ).toBeNull();

      await user.click(
        screen.getByRole("menuitem", { name: SWITCH_WORKSPACE_NAME })
      );

      expect(
        await screen.findByRole("menuitemradio", { name: OTHER_WORKSPACE_NAME })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("menuitem", {
          name: WORKSPACE_MENU_ENTRY_LABEL[
            WorkspaceMenuEntryId.CreateWorkspace
          ],
        })
      ).toBeNull();
    });
  });
});
