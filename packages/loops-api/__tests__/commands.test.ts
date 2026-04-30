import { describe, expect, it } from "vitest";

import {
  CommandInputRequirements,
  LoopCommand,
  validateCommandInputs,
} from "../src/commands";

describe("CommandInputRequirements", () => {
  it("has an entry for every LoopCommand", () => {
    for (const command of Object.values(LoopCommand)) {
      expect(
        CommandInputRequirements[command],
        `Missing entry for command: ${command}`
      ).toBeDefined();
    }
  });
});

describe("validateCommandInputs", () => {
  it("returns null for unknown commands", () => {
    expect(validateCommandInputs("UNKNOWN", false, false)).toBeNull();
  });

  // --- EXECUTE: requires prompt OR artifacts ---

  it("EXECUTE: accepts prompt only", () => {
    expect(validateCommandInputs(LoopCommand.Execute, true, false)).toBeNull();
  });

  it("EXECUTE: accepts artifacts only", () => {
    expect(validateCommandInputs(LoopCommand.Execute, false, true)).toBeNull();
  });

  it("EXECUTE: rejects neither prompt nor artifacts", () => {
    expect(validateCommandInputs(LoopCommand.Execute, false, false)).toContain(
      "EXECUTE"
    );
  });

  // --- REQUEST_CHANGES: requires prompt ---

  it("REQUEST_CHANGES: accepts with prompt", () => {
    expect(
      validateCommandInputs(LoopCommand.RequestChanges, true, false)
    ).toBeNull();
  });

  it("REQUEST_CHANGES: rejects without prompt", () => {
    expect(
      validateCommandInputs(LoopCommand.RequestChanges, false, true)
    ).toContain("prompt");
  });

  // --- DECOMPOSE: requires artifacts ---

  it("DECOMPOSE: accepts with artifacts", () => {
    expect(
      validateCommandInputs(LoopCommand.Decompose, false, true)
    ).toBeNull();
  });

  it("DECOMPOSE: rejects without artifacts", () => {
    expect(
      validateCommandInputs(LoopCommand.Decompose, false, false)
    ).toContain("artifacts");
  });

  // --- EVALUATE_PRD: requires artifacts ---

  it("EVALUATE_PRD: accepts with artifacts", () => {
    expect(
      validateCommandInputs(LoopCommand.EvaluatePrd, false, true)
    ).toBeNull();
  });

  it("EVALUATE_PRD: rejects without artifacts", () => {
    expect(
      validateCommandInputs(LoopCommand.EvaluatePrd, false, false)
    ).toContain("artifacts");
  });

  // --- EVALUATE_FEATURE: requires artifacts ---

  it("EVALUATE_FEATURE: accepts with artifacts", () => {
    expect(
      validateCommandInputs(LoopCommand.EvaluateFeature, false, true)
    ).toBeNull();
  });

  it("EVALUATE_FEATURE: rejects without artifacts", () => {
    expect(
      validateCommandInputs(LoopCommand.EvaluateFeature, false, false)
    ).toContain("artifacts");
  });

  // --- GENERATE_PRD: requires prompt ---

  it("GENERATE_PRD: accepts with prompt", () => {
    expect(
      validateCommandInputs(LoopCommand.GeneratePrd, true, false)
    ).toBeNull();
  });

  it("GENERATE_PRD: rejects without prompt", () => {
    expect(
      validateCommandInputs(LoopCommand.GeneratePrd, false, false)
    ).toContain("prompt");
  });

  // --- PLAN: no strict requirements ---

  it("PLAN: accepts with nothing", () => {
    expect(validateCommandInputs(LoopCommand.Plan, false, false)).toBeNull();
  });

  // --- CHAT/EXPLORE: require prompt ---

  it("CHAT: rejects without prompt", () => {
    expect(validateCommandInputs(LoopCommand.Chat, false, false)).toContain(
      "prompt"
    );
  });

  it("EXPLORE: rejects without prompt", () => {
    expect(validateCommandInputs(LoopCommand.Explore, false, false)).toContain(
      "prompt"
    );
  });
});
