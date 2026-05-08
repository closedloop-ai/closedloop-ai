import { describe, expect, it } from "vitest";

import { LoopArtifactFile } from "../src/artifacts";
import { ResultBundle, validateResultBundle } from "../src/bundles";
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
