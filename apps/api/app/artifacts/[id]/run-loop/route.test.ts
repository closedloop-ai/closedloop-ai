import { RunLoopCommand } from "@repo/api/src/types/loop";
import { afterEach, describe, expect, it } from "vitest";
import { buildAdditionalReposInput } from "./route";

describe("buildAdditionalReposInput", () => {
  const originalFlag = process.env.MULTI_REPO_PLAN_ENABLED;

  afterEach(() => {
    process.env.MULTI_REPO_PLAN_ENABLED = originalFlag;
  });

  it("returns undefined when feature flag is disabled", () => {
    process.env.MULTI_REPO_PLAN_ENABLED = "false";

    const result = buildAdditionalReposInput(
      [{ fullName: "org/repo-a", branch: "main" }],
      RunLoopCommand.Plan,
      "org/primary",
      "artifact-1"
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined for non-plan commands", () => {
    process.env.MULTI_REPO_PLAN_ENABLED = "true";

    const result = buildAdditionalReposInput(
      [{ fullName: "org/repo-a", branch: "main" }],
      RunLoopCommand.Execute,
      "org/primary",
      "artifact-1"
    );

    expect(result).toBeUndefined();
  });

  it("deduplicates entries and removes primary repo", () => {
    process.env.MULTI_REPO_PLAN_ENABLED = "true";

    const result = buildAdditionalReposInput(
      [
        { fullName: "org/peer-a", branch: "main" },
        { fullName: "org/primary", branch: "main" },
        { fullName: "org/peer-a", branch: "release" },
        { fullName: "org/peer-b", branch: "dev" },
      ],
      RunLoopCommand.Plan,
      "org/primary",
      "artifact-1"
    );

    expect(result).toEqual([
      { fullName: "org/peer-a", branch: "main" },
      { fullName: "org/peer-b", branch: "dev" },
    ]);
  });
});
