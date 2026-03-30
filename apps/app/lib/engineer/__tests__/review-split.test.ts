import { describe, expect, it } from "vitest";
import { splitReviewOutput } from "../review-split";

describe("splitReviewOutput", () => {
  it("parses codex full review comments blocks into findings", () => {
    const output = [
      "some process log",
      "Full review comments:",
      "- [P2] Emit command_completed for successful commands — apps/desktop/src/main/cloud-command-executor.ts:250-252",
      "`command_completed` can be skipped on common success paths.",
    ].join("\n");

    const result = splitReviewOutput(output, "codex");

    expect(result.processLog).toContain("some process log");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      priority: "P2",
      severity: "warning",
      file: "apps/desktop/src/main/cloud-command-executor.ts",
      line: 250,
    });
    expect(result.findings[0].message).toContain(
      "Emit command_completed for successful commands"
    );
  });

  it("handles inline headers and deduplicates repeated findings", () => {
    const findingA = [
      "- [P2] Emit command_completed for successful commands — apps/desktop/src/main/cloud-command-executor.ts:250-252",
      "`command_completed` can be skipped on common success paths.",
    ].join("\n");
    const findingB = [
      "- [P2] Initialize release_version from app version — apps/desktop/src/main/app.ts:101-101",
      "release_version is initialized from a protocol constant.",
    ].join("\n");

    const output = [
      "codexThe refactor introduces analytics regressions. Full review comments:",
      findingA,
      findingB,
      findingA,
      findingB,
    ].join("\n");

    const result = splitReviewOutput(output, "codex");

    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.file)).toEqual([
      "apps/desktop/src/main/cloud-command-executor.ts",
      "apps/desktop/src/main/app.ts",
    ]);
  });

  it("does not split findings on inline [P#] mentions in descriptions", () => {
    const output = [
      "some process log",
      "Full review comments:",
      "- [P2] First issue — apps/api/src/a.ts:10",
      "This description mentions [P3] inline and should stay in one finding.",
      "- [P1] Second issue — apps/api/src/b.ts:20",
      "Second description line.",
    ].join("\n");

    const result = splitReviewOutput(output, "codex");

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.message).toContain("mentions [P3] inline");
    expect(result.findings[0]?.priority).toBe("P2");
    expect(result.findings[1]?.priority).toBe("P1");
  });
});
