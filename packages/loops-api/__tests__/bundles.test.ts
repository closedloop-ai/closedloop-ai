import { describe, expect, it } from "vitest";

import { LoopArtifactFile } from "../src/artifacts";
import {
  findUnproducedRequiredArtifacts,
  missingRequiredArtifactsMessage,
  ResultBundle,
  validateResultBundle,
} from "../src/bundles";
import { LoopCommand } from "../src/commands";

describe("ResultBundle", () => {
  it("has a manifest for every LoopCommand", () => {
    for (const command of Object.values(LoopCommand)) {
      expect(
        ResultBundle[command],
        `Missing ResultBundle entry for command: ${command}`
      ).toBeDefined();
    }
  });

  it("every file referenced in a manifest exists in LoopArtifactFile", () => {
    const validFiles = new Set(Object.values(LoopArtifactFile));
    for (const [command, manifest] of Object.entries(ResultBundle)) {
      for (const file of [...manifest.required, ...manifest.optional]) {
        expect(
          validFiles.has(file as LoopArtifactFile),
          `ResultBundle[${command}] references unknown file: ${file}`
        ).toBe(true);
      }
    }
  });
});

describe("validateResultBundle", () => {
  it("returns missing files when required artifacts are absent", () => {
    const missing = validateResultBundle(LoopCommand.Plan, []);
    expect(missing).toContain(LoopArtifactFile.Plan);
  });

  it("returns empty array when all required artifacts are present", () => {
    const missing = validateResultBundle(LoopCommand.Plan, [
      LoopArtifactFile.Plan,
    ]);
    expect(missing).toHaveLength(0);
  });

  it("ignores optional artifacts", () => {
    const missing = validateResultBundle(LoopCommand.Plan, [
      LoopArtifactFile.Plan,
    ]);
    expect(missing).not.toContain(LoopArtifactFile.Judges);
  });

  it("returns empty array for unknown commands", () => {
    const missing = validateResultBundle("UNKNOWN_COMMAND", []);
    expect(missing).toHaveLength(0);
  });

  it("returns empty array when feature-judges.json is present for EVALUATE_FEATURE", () => {
    const missing = validateResultBundle(LoopCommand.EvaluateFeature, [
      LoopArtifactFile.FeatureJudges,
    ]);
    expect(missing).toHaveLength(0);
  });

  it("returns missing file when feature-judges.json is absent for EVALUATE_FEATURE", () => {
    const missing = validateResultBundle(LoopCommand.EvaluateFeature, []);
    expect(missing).toContain(LoopArtifactFile.FeatureJudges);
  });
});

describe("findUnproducedRequiredArtifacts (ISS-5872)", () => {
  it("reports the missing deliverable for an enforced command", () => {
    expect(findUnproducedRequiredArtifacts(LoopCommand.Plan, [])).toEqual([
      LoopArtifactFile.Plan,
    ]);
  });

  it("reports nothing once the deliverable is present", () => {
    expect(
      findUnproducedRequiredArtifacts(LoopCommand.Plan, [LoopArtifactFile.Plan])
    ).toHaveLength(0);
  });

  it("reports nothing for EXECUTE, whose required file is conditional", () => {
    // EXECUTE writes execution-result.json only after a successful commit AND
    // push, so a legitimate no-changes run ends without it. `validateResultBundle`
    // still reports the raw manifest diff -- the difference between the two is
    // the whole point of the enforced/unenforced split.
    expect(validateResultBundle(LoopCommand.Execute, [])).toContain(
      LoopArtifactFile.ExecutionResult
    );
    expect(
      findUnproducedRequiredArtifacts(LoopCommand.Execute, [])
    ).toHaveLength(0);
  });

  it("reports nothing for commands that owe no artifact", () => {
    expect(findUnproducedRequiredArtifacts(LoopCommand.Chat, [])).toHaveLength(
      0
    );
    expect(findUnproducedRequiredArtifacts("UNKNOWN_COMMAND", [])).toHaveLength(
      0
    );
  });

  it("enforces every plan/PRD/decompose/evaluate command", () => {
    const enforced = [
      LoopCommand.Plan,
      LoopCommand.RequestChanges,
      LoopCommand.GeneratePrd,
      LoopCommand.RequestPrdChanges,
      LoopCommand.Decompose,
      LoopCommand.EvaluatePrd,
      LoopCommand.EvaluatePlan,
      LoopCommand.EvaluateCode,
      LoopCommand.EvaluateFeature,
    ];
    for (const command of enforced) {
      expect(
        findUnproducedRequiredArtifacts(command, []),
        `${command} must enforce its required bundle`
      ).toEqual([...ResultBundle[command].required]);
    }
  });
});

describe("missingRequiredArtifactsMessage", () => {
  it("names the command and every missing file", () => {
    const message = missingRequiredArtifactsMessage(LoopCommand.Plan, [
      LoopArtifactFile.Plan,
      LoopArtifactFile.PlanMarkdown,
    ]);
    expect(message).toContain(LoopCommand.Plan);
    expect(message).toContain(LoopArtifactFile.Plan);
    expect(message).toContain(LoopArtifactFile.PlanMarkdown);
  });
});
