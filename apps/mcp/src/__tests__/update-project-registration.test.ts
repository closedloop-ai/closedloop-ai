import { MAX_PROJECT_TEAMS } from "@repo/api/src/types/project.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerUpdateProject } from "../tools/update-project.js";
import {
  createToolHarnessWithMock,
  registeredToolConfig,
  registeredToolName,
} from "./fixtures/tool-harness.js";
import { expectIssue, UUID_REJECTION } from "./fixtures/zod-issues.js";

const VALID_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// createToolHarnessWithMock calls registerUpdateProject synchronously, so the
// registered call is captured before any `it` block runs.
const { registerTool } = createToolHarnessWithMock(registerUpdateProject, {
  put: vi.fn(),
} as unknown as ApiClient);

const registeredName = registeredToolName(registerTool);
const registeredDescription = registeredToolConfig(registerTool).description;
const inputSchema = registeredToolConfig(registerTool).inputSchema;

// The handler tests in project-tools.test.ts drive the registered CALLBACK, which
// never applies `inputSchema` — the MCP SDK does that, stripping unknown keys
// before the handler sees them. So deleting the whole `teamIds` field left every
// one of those cases green while a real client silently lost the argument. These
// assertions are the half that fails on that mutation.
describe("update-project tool registration", () => {
  it("registers the tool as update-project", () => {
    expect(registeredName).toBe("update-project");
  });

  it("includes teamIds in inputSchema", () => {
    expect(inputSchema).toHaveProperty("teamIds");
  });

  it("makes teamIds optional so an unrelated edit leaves the teams alone", () => {
    expect(inputSchema.teamIds.safeParse(undefined).success).toBe(true);
  });

  it("accepts several team UUIDs so a multi-team project can be expressed whole", () => {
    expect(
      inputSchema.teamIds.safeParse([
        VALID_UUID,
        "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      ]).success
    ).toBe(true);
  });

  it("rejects a non-UUID team id with a message naming list-teams", () => {
    const result = inputSchema.teamIds.safeParse(["platform"]);
    expectIssue(result, [0], UUID_REJECTION);
    // list-teams rows carry a `slug`, so a slug is the wrong value an agent will
    // actually reach for; the error has to name the discovery tool or there is
    // no recovery move (same contract as `projectId`, ISS-7080).
    expect(JSON.stringify(result.error?.issues)).toContain("list-teams");
  });

  it("rejects an empty array rather than letting it clear the last team", () => {
    expect(inputSchema.teamIds.safeParse([]).success).toBe(false);
  });

  it("rejects more teams than the server accepts", () => {
    const overCap = Array.from(
      { length: MAX_PROJECT_TEAMS + 1 },
      () => VALID_UUID
    );
    expect(inputSchema.teamIds.safeParse(overCap).success).toBe(false);
  });

  it("description names the teams capability and that it replaces rather than adds", () => {
    expect(registeredDescription.toLowerCase()).toContain("team");
    expect(inputSchema.teamIds.description?.toUpperCase()).toContain(
      "REPLACES"
    );
  });

  // `update-project` is registered `requiresWrite`, so a write-only grant is
  // offered it while `list-teams` — read-scoped — is withheld. The tool cannot
  // resolve that by demanding read as well (that would withhold a call the grant
  // CAN make, which is what `requiredScopes: [READ, WRITE]` is reserved for), so
  // the description has to name the recovery the write-only session does have:
  // an unresolvable id comes back as a 400 carrying the org's team roster.
  it("description names the 400 fallback a write-only grant has instead of list-teams", () => {
    expect(registeredDescription).toContain("list-teams");
    expect(registeredDescription).toContain("write-only");
    expect(registeredDescription).toContain("400");
  });
});
