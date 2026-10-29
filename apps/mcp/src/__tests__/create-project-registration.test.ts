import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerCreateProject } from "../tools/create-project.js";
import { createToolHarnessWithMock } from "./fixtures/tool-harness.js";
import { expectIssue, UUID_REJECTION } from "./fixtures/zod-issues.js";

const VALID_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// createToolHarnessWithMock calls registerCreateProject synchronously, so
// mock.calls[0] is populated before any `it` block runs.
const { registerTool } = createToolHarnessWithMock(registerCreateProject, {
  post: vi.fn(),
} as unknown as ApiClient);

const registeredName = registerTool.mock.calls[0]![0] as string;
const registeredConfig = registerTool.mock.calls[0]![1] as {
  description: string;
  inputSchema: Record<string, ZodType>;
};
const registeredDescription = registeredConfig.description;
const inputSchema = registeredConfig.inputSchema;

describe("create-project tool registration", () => {
  it("registers the tool as create-project", () => {
    expect(registeredName).toBe("create-project");
  });

  it("includes teamId in inputSchema", () => {
    expect(inputSchema).toHaveProperty("teamId");
  });

  it("makes teamId optional so a call without it still reaches the server", () => {
    expect(inputSchema.teamId.safeParse(undefined).success).toBe(true);
  });

  it("rejects a non-UUID value for teamId", () => {
    expectIssue(inputSchema.teamId.safeParse("not-a-uuid"), [], UUID_REJECTION);
  });

  it("accepts a valid UUID value for teamId", () => {
    expect(inputSchema.teamId.safeParse(VALID_UUID).success).toBe(true);
  });

  it("description names the team requirement and the 400-that-lists-teams discovery mechanism", () => {
    // Substance check: fails if team guidance is stripped, survives harmless copy edits.
    expect(registeredDescription.toLowerCase()).toContain("team");
    // Discovery mechanism: the 400 is what tells an agent which teams to retry with.
    expect(registeredDescription).toContain("400");
  });

  it("description points at list-teams for the complete team set", () => {
    // ISS-6966: the 400's roster is character-bounded, so the description has
    // to name the tool that is not — otherwise an agent whose team was omitted
    // has no next move.
    expect(registeredDescription).toContain("list-teams");
  });
});
