import { Priority } from "@repo/api/src/types/common";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummaryRow } from "../../lib/project-summary-row";
import { ProjectList } from "../project-list";

/**
 * ISS-10476 review (codex P2, tamsinb): on the product route "Save current
 * view" appended to component-local state, so a named view was gone on the next
 * mount, and column visibility lost the identity-namespaced persistence
 * ISS-9726 gives the surface it replaces. Each case here REMOUNTS — a store
 * that only survives inside one mount passes nothing below.
 */

const VIEW_STATE_KEY = "table:view:team-projects-portable::id:user-1:org-1";
const VIEWS_TRIGGER = /^Views$/;
const SAVE_ITEM = /Save current view/;
const SAVE_CONFIRM = /^Save view$/;
const VIEW_NAME = "Mine, grouped";
// The two arrangements this surface used to seed into the menu as though a
// reader had saved them. Nobody did, so neither may appear.
const SEEDED_VIEW_NAME = "Projects by owner";
const PERSONAL_SECTION = "Personal views";
const PRIORITY_COLUMN_LABEL = "Priority";
const OPTIONS_TRIGGER = /^Options$/;
const PRIORITY_COLUMN_ITEM = /^Priority$/;

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

function row(
  overrides: Partial<ProjectSummaryRow> & Pick<ProjectSummaryRow, "id" | "name">
): ProjectSummaryRow {
  return {
    childTaskCount: null,
    code: null,
    completionPercentage: null,
    dueDateLabel: null,
    dueDateMs: null,
    owner: null,
    priority: null,
    updatedAtMs: 0,
    updatedLabel: "just now",
    ...overrides,
  };
}

const ROWS: ProjectSummaryRow[] = [
  row({ id: "1", name: "Apollo", priority: Priority.High }),
  row({ id: "2", name: "Borealis", priority: Priority.Low }),
];

function priorityHeader() {
  return screen
    .queryAllByRole("columnheader")
    .find((header) => header.textContent?.includes(PRIORITY_COLUMN_LABEL));
}

async function openViewsMenu() {
  await userEvent.click(
    screen.getAllByRole("button", { name: VIEWS_TRIGGER })[0]
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("ProjectList saved views", () => {
  it("lists no view until this reader saves one", async () => {
    render(<ProjectList rows={ROWS} viewStateKey={VIEW_STATE_KEY} />);
    await openViewsMenu();
    // Presence first, so the absence below is taken inside a menu that opened:
    // Save is the only item an empty collection offers.
    expect(
      await screen.findByRole("menuitem", { name: SAVE_ITEM })
    ).toBeInTheDocument();
    expect(screen.queryByText(SEEDED_VIEW_NAME)).toBeNull();
    expect(screen.queryByText(PERSONAL_SECTION)).toBeNull();
  });

  it("keeps a saved view across a remount", async () => {
    const first = render(
      <ProjectList rows={ROWS} viewStateKey={VIEW_STATE_KEY} />
    );
    await openViewsMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: SAVE_ITEM })
    );
    await userEvent.type(await screen.findByRole("textbox"), VIEW_NAME);
    await userEvent.click(
      await screen.findByRole("button", { name: SAVE_CONFIRM })
    );
    // Present in THIS mount first, so the post-remount assertion below is taken
    // on a control that resolved at least once.
    expect(
      screen.getAllByRole("button", { name: VIEW_NAME }).length
    ).toBeGreaterThan(0);

    first.unmount();
    render(<ProjectList rows={ROWS} viewStateKey={VIEW_STATE_KEY} />);
    expect(
      screen.getAllByRole("button", { name: VIEW_NAME }).length
    ).toBeGreaterThan(0);
  });

  it("persists nothing when the host supplies no key", async () => {
    const first = render(<ProjectList rows={ROWS} />);
    await openViewsMenu();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: SAVE_ITEM })
    );
    await userEvent.type(await screen.findByRole("textbox"), VIEW_NAME);
    await userEvent.click(
      await screen.findByRole("button", { name: SAVE_CONFIRM })
    );
    expect(
      screen.getAllByRole("button", { name: VIEW_NAME }).length
    ).toBeGreaterThan(0);

    first.unmount();
    render(<ProjectList rows={ROWS} />);
    expect(screen.queryByRole("button", { name: VIEW_NAME })).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

describe("ProjectList column visibility", () => {
  async function hidePriorityColumn() {
    await userEvent.click(
      screen.getAllByRole("button", { name: OPTIONS_TRIGGER })[0]
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: PRIORITY_COLUMN_ITEM })
    );
  }

  it("keeps a hidden column hidden across a remount", async () => {
    const first = render(
      <ProjectList rows={ROWS} viewStateKey={VIEW_STATE_KEY} />
    );
    expect(priorityHeader()).toBeDefined();
    await hidePriorityColumn();
    expect(priorityHeader()).toBeUndefined();

    first.unmount();
    render(<ProjectList rows={ROWS} viewStateKey={VIEW_STATE_KEY} />);
    expect(priorityHeader()).toBeUndefined();
  });

  it("resets to every column when the host supplies no key", async () => {
    const first = render(<ProjectList rows={ROWS} />);
    await hidePriorityColumn();
    expect(priorityHeader()).toBeUndefined();

    first.unmount();
    render(<ProjectList rows={ROWS} />);
    expect(priorityHeader()).toBeDefined();
  });
});
