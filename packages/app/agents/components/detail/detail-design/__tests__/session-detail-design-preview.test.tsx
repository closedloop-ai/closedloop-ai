import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_DESIGN_ARTIFACT } from "../session-detail-design-fixtures";
import { SessionDetailDesignPreview } from "../session-detail-design-preview";

// The Activity tab's rows resolve people, projects and tags through the org
// directories; seed them as a settled read with the example rows' records
// (activity-catalog.fixtures.ts), the way the stories do. Hoisted, so the
// records are declared here rather than imported.
const directory = vi.hoisted(() => {
  const settled = <T,>(data: T[]) => ({
    data,
    isPending: false,
    isError: false,
    fetchStatus: "idle",
  });
  return {
    users: settled([
      {
        id: "00000000-0000-7000-8000-000000000101",
        firstName: "Emily",
        lastName: "Carter",
      },
      {
        id: "00000000-0000-7000-8000-000000000102",
        firstName: "Jake",
        lastName: "Morrison",
      },
    ]),
    projects: settled([
      { id: "00000000-0000-7000-8000-000000000120", name: "Atlas" },
      { id: "00000000-0000-7000-8000-000000000121", name: "Orion" },
    ]),
    tags: settled([
      {
        id: "00000000-0000-7000-8000-000000000130",
        name: "frontend",
        color: "blue",
      },
      {
        id: "00000000-0000-7000-8000-000000000132",
        name: "backend",
        color: "green",
      },
    ]),
  };
});
vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOrganizationUsers: () => directory.users,
}));
vi.mock("@repo/app/projects/hooks/use-projects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => directory.projects,
}));
vi.mock("@repo/app/tags/hooks/use-tags", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTags: () => directory.tags,
}));
// A person's name links to their profile through the app's navigation port,
// which this harness has no provider for.
// Comment rows and linked values on the Activity tab are navigation-port
// links too; a plain anchor keeps their link semantics without a provider.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));
vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

const COMMENT_BODY = "Fixture: can we confirm the vitest failure is unrelated?";
const PROMPT_TEXT = "Please inspect the shared session detail screen.";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("SessionDetailDesignPreview", () => {
  it("shows Session, Details and Activity: no Artifact tab (ISS-12167)", () => {
    render(<SessionDetailDesignPreview />);

    // A Session hides the generic Artifact tab and reads its Sessions tab
    // singular; Activity stays the third (Activity kept, 2026-10-06).
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Session",
      "Details",
      "Activity",
    ]);
    expect(screen.queryByRole("tab", { name: "Artifact" })).toBeNull();
  });

  it("opens on Activity with the Session feed in the Session status words", () => {
    render(<SessionDetailDesignPreview initialTab="activity" />);

    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    const list = screen.getByRole("list", { name: "Activity" });
    // Newest first: a System status row leads (ISS-12117 example timeline,
    // C07), in the Session status words and with no cause it cannot prove.
    const [first] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("System");
    expect(first).toHaveTextContent("changed status from Active to Failed");
    expect(first).not.toHaveTextContent("inactive too long");
    expect(first).not.toHaveTextContent("from desktop sync");
    expect(list).toHaveTextContent("changed status from Active to Inactive");
  });

  it("keeps Refresh and the session overflow on every tab", async () => {
    const user = userEvent.setup();
    render(<SessionDetailDesignPreview />);

    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More session actions" })
    ).toBeInTheDocument();
  });

  it("moves the co-located trace to a trace comment's row when it is selected", async () => {
    const user = userEvent.setup();
    render(<SessionDetailDesignPreview />);

    const trace = screen.getByRole("region", { name: "Session Trace" });
    expect(trace.querySelector('[data-active="true"]')).toBeNull();

    await user.click(screen.getByText(COMMENT_BODY));

    const active = trace.querySelector('[data-active="true"]');
    expect(active).not.toBeNull();
    expect(within(active as HTMLElement).getByText(PROMPT_TEXT)).toBeVisible();
  });

  it("scrolls the Artifact panel's container to the trace row on a jump", async () => {
    // jsdom has no element scrollTo; the trace calls it when it exists.
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const user = userEvent.setup();
    render(<SessionDetailDesignPreview />);

    const container = screen
      .getByRole("region", { name: "Session Trace" })
      .closest('[data-artifact-frame="framed"]');
    expect(container).not.toBeNull();

    await user.click(screen.getByText(COMMENT_BODY));

    expect(scrollTo).toHaveBeenCalled();
    expect(scrollTo.mock.contexts).toContain(container);
  });
  // ISS-10798 AC4: no critical WCAG 2.2 AA violations on any tab; icon-only
  // controls are named and the tab list carries its label.
  it.each(["Session", "Details", "Activity"])(
    "has no critical axe violations on the %s tab",
    async (tab) => {
      const user = userEvent.setup();
      const { container } = render(<SessionDetailDesignPreview />);
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.getByRole("tablist", { name: "Artifact detail sections" })
      ).toBeInTheDocument();
      await expectCriticalAxeClean(container);
    }
  );

  it("hands the page header its title, overflow, status, and the comments toggle on Session only", async () => {
    const user = userEvent.setup();
    const pageHeader = vi.fn(() => null);
    render(<SessionDetailDesignPreview pageHeader={pageHeader} />);

    expect(pageHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({
        overflowMenu: expect.anything(),
        status: expect.anything(),
        title: SESSION_DESIGN_ARTIFACT.title,
      })
    );
    expect(pageHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentsToggle: expect.anything() })
    );
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(pageHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentsToggle: null })
    );
  });

  it("shows the collaborators beside the tabs on every tab", async () => {
    const user = userEvent.setup();
    render(<SessionDetailDesignPreview />);

    for (const tab of ["Session", "Details", "Activity"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      // ISS-12273: the shared widget makes ONE accessibility statement — the
      // wrapper names every collaborator — so each name is asserted inside
      // that one label rather than on an avatar of its own.
      for (const name of SESSION_DESIGN_ARTIFACT.collaborators) {
        expect(
          screen.getAllByRole("img", { name: new RegExp(name) }).length
        ).toBeGreaterThan(0);
      }
    }
  });
});
