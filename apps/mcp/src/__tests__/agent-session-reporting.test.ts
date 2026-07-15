import { describe, expect, it } from "vitest";
import { buildAgentSessionReportingQuery } from "../tools/agent-session-reporting.js";

describe("buildAgentSessionReportingQuery", () => {
  it("maps provided filters into the API query", () => {
    expect(
      buildAgentSessionReportingQuery({
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        harness: "claude-code",
        viewerScope: "organization",
      })
    ).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      harness: "claude-code",
      viewerScope: "organization",
    });
  });

  it("maps teamId for team-scoped queries", () => {
    expect(
      buildAgentSessionReportingQuery({
        viewerScope: "team",
        teamId: "11111111-1111-1111-1111-111111111111",
      })
    ).toEqual({
      viewerScope: "team",
      teamId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("drops undefined filters so unset params are omitted", () => {
    expect(buildAgentSessionReportingQuery({ harness: "codex" })).toEqual({
      harness: "codex",
    });
  });

  it("returns an empty query when no filters are set", () => {
    expect(buildAgentSessionReportingQuery({})).toEqual({});
  });
});
