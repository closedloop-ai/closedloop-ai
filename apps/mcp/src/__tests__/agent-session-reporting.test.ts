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
      // FEA-3345: omitted quality → explicit `substantive` (see below).
      quality: "substantive",
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
      quality: "substantive",
    });
  });

  it("maps the quality filter so idle sessions can be included in aggregates", () => {
    expect(buildAgentSessionReportingQuery({ quality: "all" })).toEqual({
      quality: "all",
    });
    expect(buildAgentSessionReportingQuery({ quality: "substantive" })).toEqual(
      {
        quality: "substantive",
      }
    );
  });

  it("drops undefined filters so unset params are omitted", () => {
    expect(buildAgentSessionReportingQuery({ harness: "codex" })).toEqual({
      harness: "codex",
      quality: "substantive",
    });
  });

  // FEA-3345: the server default is now fail-open `all`, but this MCP reporting
  // tool keeps its documented `substantive` default by sending it explicitly, so
  // an agent that omits `quality` still excludes idle sessions from aggregates
  // (its `.describe()` contract) rather than inheriting the server's `all`.
  it("defaults quality to substantive when no filters are set", () => {
    expect(buildAgentSessionReportingQuery({})).toEqual({
      quality: "substantive",
    });
  });
});
