import {
  createFixtureFetch,
  type FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { describe, expect, it } from "vitest";
import {
  agentComponentList,
  agentComponentsFixture,
  agentsApiRoutes,
  agentsListRoute,
} from "../stories/surfaces-v2/fixtures/agents-fixtures";
import {
  branchDetailFixture,
  branchDetailRoutes,
} from "../stories/surfaces-v2/fixtures/branch-detail-fixtures";
import {
  artifactLinksFixture,
  documentDetailRoutes,
  planDetailFixture,
  planPullRequestsFixture,
  prdDetailFixture,
} from "../stories/surfaces-v2/fixtures/document-detail-fixtures";
import {
  judgeDetailFixture,
  judgeScoresFixture,
  judgesApiRoutes,
} from "../stories/surfaces-v2/fixtures/judges-fixtures";
import {
  onboardingApiRoutes,
  onboardingTeamFixture,
} from "../stories/surfaces-v2/fixtures/onboarding-fixtures";

const ORIGIN = "http://localhost";

async function read(routes: FixtureRoute[], path: string): Promise<unknown> {
  const response = await createFixtureFetch(routes)(`${ORIGIN}${path}`);
  const envelope = (await response.json()) as { data: unknown };
  return envelope.data;
}

describe("agents list route", () => {
  it("answers the current window without endDate and the preceding window with it", async () => {
    const current = agentComponentsFixture.slice(0, 2);
    const preceding = agentComponentsFixture.slice(2, 3);
    const route = agentsListRoute(current, preceding);
    expect(await read([route], "/agent-components")).toEqual(
      agentComponentList(current)
    );
    expect(await read([route], "/agent-components?endDate=2026-10-01")).toEqual(
      agentComponentList(preceding)
    );
  });

  it("uses the current list for the preceding window when none is given", async () => {
    const current = agentComponentsFixture.slice(0, 1);
    expect(
      await read([agentsListRoute(current)], "/agent-components?endDate=x")
    ).toEqual(agentComponentList(current));
  });

  it("scales the preceding inventory down to about four fifths of the current use", async () => {
    const now = (await read(agentsApiRoutes, "/agent-components")) as {
      items: { invocations: number | null }[];
    };
    const before = (await read(
      agentsApiRoutes,
      "/agent-components?endDate=2026-10-01"
    )) as { items: { invocations: number | null }[] };
    expect(before.items).toHaveLength(now.items.length);
    now.items.forEach((item, index) => {
      const prior = before.items[index]?.invocations;
      expect(prior).toBe(
        item.invocations === null ? null : Math.round(item.invocations * 0.8)
      );
    });
  });
});

describe("branch detail routes", () => {
  const routes = branchDetailRoutes();

  it("answers session trace-comments with a list and any other session read with an object", async () => {
    expect(await read(routes, "/agent-sessions/s1/trace-comments")).toEqual([]);
    expect(await read(routes, "/agent-sessions/s1")).toEqual({});
  });

  it("answers the branch itself and stamps its id on the trace", async () => {
    expect(await read(routes, `/branches/${branchDetailFixture.id}`)).toEqual(
      JSON.parse(JSON.stringify(branchDetailFixture))
    );
    const trace = (await read(
      routes,
      `/branches/${branchDetailFixture.id}/trace`
    )) as { branchId: string };
    expect(trace.branchId).toBe(branchDetailFixture.id);
  });
});

describe("document detail routes", () => {
  it("returns the plan's pull requests only for the plan document", async () => {
    const planRoutes = documentDetailRoutes(planDetailFixture);
    const prdRoutes = documentDetailRoutes(prdDetailFixture);
    expect(
      await read(planRoutes, `/documents/${planDetailFixture.id}/pull-request`)
    ).toHaveLength(planPullRequestsFixture.length);
    expect(
      await read(prdRoutes, `/documents/${prdDetailFixture.id}/pull-request`)
    ).toEqual([]);
  });

  it("resolves links for an empty artifact id when the query omits it", async () => {
    const [template] = artifactLinksFixture;
    if (!template) {
      throw new Error("artifactLinksFixture is empty");
    }
    const blank = { ...template, id: "link-blank", sourceId: "" };
    const other = { ...template, id: "link-other", sourceId: "other" };
    const routes = documentDetailRoutes(prdDetailFixture, {
      links: [blank, other],
    });
    expect(await read(routes, "/artifact-links/resolved")).toEqual([
      JSON.parse(JSON.stringify(blank)),
    ]);
  });
});

describe("judges routes", () => {
  it("falls back to empty groups echoing the report type when it is unknown or missing", async () => {
    expect(
      await read(judgesApiRoutes, "/judges-analytics?reportType=nope")
    ).toEqual({ groups: [], reportType: "nope" });
    // pins current behavior; looks odd because a missing reportType echoes null
    expect(await read(judgesApiRoutes, "/judges-analytics")).toEqual({
      groups: [],
      reportType: null,
    });
  });

  it("answers a judge's scores path with the scores and any other judge path with its detail", async () => {
    const scores = await read(judgesApiRoutes, "/judges-analytics/p/scores");
    expect(scores).toEqual(JSON.parse(JSON.stringify(judgeScoresFixture)));
    expect(await read(judgesApiRoutes, "/judges-analytics/p")).toEqual(
      JSON.parse(JSON.stringify(judgeDetailFixture))
    );
  });
});

describe("onboarding POST /teams route", () => {
  // The fixture fetch answers over JSON, so dates arrive as ISO strings.
  const team = JSON.parse(JSON.stringify(onboardingTeamFixture)) as Record<
    string,
    unknown
  >;

  async function createTeam(body?: unknown): Promise<unknown> {
    const response = await createFixtureFetch(onboardingApiRoutes)(
      `${ORIGIN}/teams`,
      {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    );
    return ((await response.json()) as { data: unknown }).data;
  }

  it("echoes the submitted team name onto the team fixture", async () => {
    expect(await createTeam({ name: "Platform" })).toEqual({
      ...team,
      name: "Platform",
    });
  });

  it("names the team with an empty string when no name is posted", async () => {
    expect(await createTeam({})).toEqual({
      ...team,
      name: "",
    });
    expect(await createTeam()).toEqual({ ...team, name: "" });
  });
});
