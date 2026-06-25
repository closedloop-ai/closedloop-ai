import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CREATE_BRANCH_TOOL_REGISTRATION_REGEX =
  /name:\s*"create_branch_artifact"[\s\S]*?register:\s*registerCreateBranchArtifact[\s\S]*?requiresWrite:\s*true/;
const WRITE_SCOPE_FILTER_REGEX =
  /registration\.requiresWrite\s*&&\s*!allowWriteTools/;

describe("create_branch_artifact tool registration gating", () => {
  it("marks create_branch_artifact as write-scoped in the shared registry", () => {
    const source = readFileSync(resolve("src/index.ts"), "utf8");

    expect(source).toMatch(CREATE_BRANCH_TOOL_REGISTRATION_REGEX);
    expect(source).toMatch(WRITE_SCOPE_FILTER_REGEX);
  });
});
