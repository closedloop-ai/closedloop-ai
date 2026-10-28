/**
 * Regression guard for the ISS-6966 self-correction channel.
 *
 * The API's `details` is stripped by the MCP sanitizer (FEA-2550), so the team
 * names the agent needs to retry must survive inside the error `message`. These
 * tests pin that channel: if a future change to the friendly-error fallback, the
 * sanitizer, or `withErrorHandling` drops the message, they go red before a
 * headless agent goes blind.
 */
import { ProjectErrorCode } from "@repo/api/src/types/project.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import { registerCreateProject } from "../tools/create-project.js";
import { createToolHarness } from "./fixtures/tool-harness.js";

const PLATFORM_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const GROWTH_UUID = "2b1f0f4e-5b2c-4fb7-a3d2-4c3f5c2c6a8b";

// Shaped like the real API 400 body: team names AND their uuids live in the
// message so they reach the agent even when `details` is sanitized away.
const TEAM_MESSAGE = `At least one team is required. Teams in this organization: Platform (${PLATFORM_UUID}), Growth (${GROWTH_UUID}).`;

describe("create-project error rendering", () => {
  it("surfaces team names and ids from the error message in the tool response text", async () => {
    const post = vi.fn().mockRejectedValueOnce(
      new McpApiError(TEAM_MESSAGE, {
        code: ProjectErrorCode.ProjectTeamRequired,
      })
    );
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    const result = await handler({ name: "My Project" });

    expect(result.isError).toBe(true);
    // Both human-readable name and machine-usable id must reach the agent.
    expect(result.content[0].text).toContain("Platform");
    expect(result.content[0].text).toContain(PLATFORM_UUID);
    expect(result.content[0].text).toContain("Growth");
    expect(result.content[0].text).toContain(GROWTH_UUID);
  });

  it("does not leak details fields into the tool response text (FEA-2550 sanitizer preserved)", async () => {
    // The API may include a `details` payload with internal paths or other
    // server-side data. Only `code`, `message`, and `timestamp` survive the
    // sanitizer — everything else must be stripped.
    const post = vi.fn().mockRejectedValueOnce(
      new McpApiError(TEAM_MESSAGE, {
        code: ProjectErrorCode.ProjectTeamRequired,
        details: {
          teams: [{ id: PLATFORM_UUID, name: "Platform" }],
          internalPath: "/srv/secret",
        },
      })
    );
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    const result = await handler({ name: "My Project" });

    expect(result.isError).toBe(true);
    // Team names still reach the agent through the message channel.
    expect(result.content[0].text).toContain(PLATFORM_UUID);
    // The raw details object — including any internal fields — must be absent.
    expect(result.content[0].text).not.toContain("internalPath");
  });

  // An org with more teams than the old 25-name prose cap. `details.teams` is
  // stripped here and there is no `list-teams` tool, so a team missing from this
  // text is a team the agent cannot choose at all. The API now names every team;
  // this pins that the MCP boundary does not re-truncate what it forwards.
  it("forwards a long roster whole, including the last team, for an org over 25 teams", async () => {
    const teams = Array.from({ length: 30 }, (_, i) => ({
      id: `7c9e6679-7425-40de-944b-${String(i).padStart(12, "0")}`,
      name: `Team ${i}`,
    }));
    const message = `At least one team is required. Teams in this organization: ${teams
      .map((team) => `${team.name} (${team.id})`)
      .join(", ")}.`;
    const post = vi.fn().mockRejectedValueOnce(
      new McpApiError(message, {
        code: ProjectErrorCode.ProjectTeamRequired,
      })
    );
    const handler = createToolHarness(registerCreateProject, {
      post,
    } as unknown as ApiClient);

    const result = await handler({ name: "My Project" });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Every team the API named survives to the agent — not just the first page.
    for (const team of teams) {
      expect(text).toContain(team.id);
    }
    expect(text).toContain(teams.at(-1)?.id);
  });
});
