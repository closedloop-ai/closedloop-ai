import { Circle } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { buildBreadcrumbs } from "../breadcrumb-model";
import { NavId } from "../route-table";

vi.mock("../nav-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nav-config")>();
  return {
    ...actual,
    navEntryFor: vi.fn(actual.navEntryFor),
    navSectionFor: vi.fn(actual.navSectionFor),
  };
});

const BASE_ARGS = {
  detailSessionId: null as string | null,
  detailBranchId: null as string | null,
  detailAgentSlug: null as string | null,
  detailTitle: null as string | null,
  detailTitleSettled: true,
  navId: NavId.Dashboard,
  sessionsListHref: "/sessions",
  branchBackHref: "/branches",
  branchBackLabel: "Branches" as const,
  agentsListHref: "/agents",
};

describe("buildBreadcrumbs — nav-lookup fallbacks", () => {
  it("uses the real Sessions nav label as the session-detail parent when the entry resolves", async () => {
    const { navEntryFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockImplementation((id) =>
      id === NavId.Sessions
        ? { id, label: "Sessions", icon: Circle, section: "artifacts" }
        : undefined
    );

    const crumbs = buildBreadcrumbs({
      ...BASE_ARGS,
      detailSessionId: "sess_1",
    });

    expect(crumbs[0]).toEqual({ label: "Sessions", href: "/sessions" });
  });

  // pins current behavior; looks odd because navEntryFor never actually returns
  // undefined for NavId.Sessions in production (NAV_ENTRIES always has it) — the
  // `?? "Sessions"` fallback exists defensively, so this exercises it directly by
  // mocking nav-config rather than by reaching it through real data.
  it("falls back to the literal 'Sessions' label when the Sessions nav entry cannot be resolved", async () => {
    const { navEntryFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockReturnValue(undefined);

    const crumbs = buildBreadcrumbs({
      ...BASE_ARGS,
      detailSessionId: "sess_1",
    });

    expect(crumbs[0]).toEqual({ label: "Sessions", href: "/sessions" });
  });

  it("uses the real Agents nav label as the agent-detail parent when the entry resolves", async () => {
    const { navEntryFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockImplementation((id) =>
      id === NavId.Agents
        ? { id, label: "Agents", icon: Circle, section: "labs" }
        : undefined
    );

    const crumbs = buildBreadcrumbs({
      ...BASE_ARGS,
      detailAgentSlug: "claude",
    });

    expect(crumbs[0]).toEqual({ label: "Agents", href: "/agents" });
  });

  // pins current behavior; looks odd for the same reason as the Sessions case
  // above — NavId.Agents always resolves in real NAV_ENTRIES.
  it("falls back to the literal 'Agents' label when the Agents nav entry cannot be resolved", async () => {
    const { navEntryFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockReturnValue(undefined);

    const crumbs = buildBreadcrumbs({
      ...BASE_ARGS,
      detailAgentSlug: "claude",
    });

    expect(crumbs[0]).toEqual({ label: "Agents", href: "/agents" });
  });

  it("omits the section crumb on a list page when the nav id has no displayed section", async () => {
    const { navEntryFor, navSectionFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockReturnValue({
      id: NavId.Dashboard,
      label: "Dashboard",
      icon: Circle,
      section: "main",
    });
    vi.mocked(navSectionFor).mockReturnValue(undefined);

    const crumbs = buildBreadcrumbs({ ...BASE_ARGS, navId: NavId.Dashboard });

    expect(crumbs).toEqual([{ label: "Dashboard" }]);
  });

  it("prepends the resolved section label on a list page when a section is displayed", async () => {
    const { navEntryFor, navSectionFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockReturnValue({
      id: NavId.Sessions,
      label: "Sessions",
      icon: Circle,
      section: "artifacts",
    });
    vi.mocked(navSectionFor).mockReturnValue("artifacts");

    const crumbs = buildBreadcrumbs({ ...BASE_ARGS, navId: NavId.Sessions });

    expect(crumbs).toEqual([{ label: "Artifacts" }, { label: "Sessions" }]);
  });

  it("falls back to the raw nav id as the final list-page label when the entry cannot be resolved", async () => {
    const { navEntryFor, navSectionFor } = await import("../nav-config");
    vi.mocked(navEntryFor).mockReturnValue(undefined);
    vi.mocked(navSectionFor).mockReturnValue(undefined);

    const crumbs = buildBreadcrumbs({ ...BASE_ARGS, navId: NavId.Dashboard });

    expect(crumbs).toEqual([{ label: NavId.Dashboard }]);
  });
});

describe("project contextual breadcrumbs", () => {
  it("names the actual project destination rather than the dashboard nav fallback", () => {
    expect(
      buildBreadcrumbs({
        ...BASE_ARGS,
        projectContext: { teamId: "team", archived: false },
      })
    ).toEqual([{ label: "Projects" }]);
    expect(
      buildBreadcrumbs({
        ...BASE_ARGS,
        projectContext: { teamId: "team", archived: true },
      })
    ).toEqual([
      { label: "Projects", href: "/teams/team/projects" },
      { label: "Archived" },
    ]);
  });
});
