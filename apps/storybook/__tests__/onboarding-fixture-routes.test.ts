/**
 * The onboarding stories' echo routes (`POST /teams`, `POST /projects`) fall
 * back to the fixture team/project when the request omits a field. The story
 * flows always submit every field, so the fallbacks are driven here by calling
 * each route's `respond` directly with a sparse body.
 */
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { describe, expect, it } from "vitest";
import {
  ProjectStep,
  TeamCreated,
} from "../stories/surfaces/onboarding.stories";

type Echo = {
  name: string;
  slug: string;
  description?: string;
  teams?: unknown;
};

function routeOf(story: { parameters?: unknown }, path: string): FixtureRoute {
  const routes = (
    story.parameters as { appCore: { apiRoutes: FixtureRoute[] } }
  ).appCore.apiRoutes;
  const route = routes.find((r) => r.method === "POST" && r.path === path);
  if (!route) {
    throw new Error(`no POST ${path} route`);
  }
  return route;
}

function call(route: FixtureRoute, body: unknown): Echo {
  return route.respond({
    pathname: route.path,
    search: "",
    searchParams: new URLSearchParams(),
    method: "POST",
    body,
  } as FixtureRequestContext) as Echo;
}

describe("onboarding POST /teams fixture", () => {
  const teams = routeOf(TeamCreated, "/teams");

  it("echoes a submitted name, trimmed, with its slug", () => {
    const team = call(teams, { name: "  Platform Crew  " });
    expect(team.name).toBe("Platform Crew");
    expect(team.slug).toBe("platform-crew");
  });

  it("falls back to the fixture team when the body is missing", () => {
    const team = call(teams, undefined);
    expect(team.name).toBe("Design Systems");
    expect(team.slug).toBe("design-systems");
  });

  it("falls back to the fixture team when the name is blank", () => {
    expect(call(teams, { name: "   " }).name).toBe("Design Systems");
  });
});

describe("onboarding POST /projects fixture", () => {
  const projects = routeOf(ProjectStep, "/projects");

  it("falls back to the fixture name, description and team when the body is missing", () => {
    const project = call(projects, undefined);
    expect(project.name).toBe("Storybook Migration");
    expect(project.slug).toBe("storybook-migration");
    expect(project.description).toBe(
      "Move every legacy screen onto the real component catalog."
    );
    expect(project.teams).toEqual([
      { id: "team_design_systems", name: "Design Systems" },
    ]);
  });

  it("echoes submitted fields, naming every team with the fixture team name", () => {
    const project = call(projects, {
      name: "Docs Refresh",
      description: "",
      teamIds: ["team_a", "team_b"],
    });
    expect(project.name).toBe("Docs Refresh");
    expect(project.slug).toBe("docs-refresh");
    // An empty description is kept: `??` only replaces a missing one.
    expect(project.description).toBe("");
    // pins current behavior; looks odd because every submitted team id is
    // labelled "Design Systems", not its own name — the fixture has no team
    // lookup.
    expect(project.teams).toEqual([
      { id: "team_a", name: "Design Systems" },
      { id: "team_b", name: "Design Systems" },
    ]);
  });
});
