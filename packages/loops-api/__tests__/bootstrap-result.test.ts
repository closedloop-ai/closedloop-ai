import { describe, expect, it } from "vitest";
import {
  BootstrapAgentSchema,
  BootstrapLoopResultSchema,
  BootstrapRepoResultSchema,
} from "../src/bootstrap-result";

const validAgent = {
  name: "Frontend Architect",
  slug: "frontend-architect",
  role: "frontend",
  description: "Specializes in React",
  prompt: "You are a frontend architect...",
};

const validRepo = {
  fullName: "closedloop-ai/symphony-alpha",
  success: true,
  agents: [validAgent],
  criticGates: null,
  metadata: null,
  duration: 12.5,
};

describe("BootstrapAgentSchema", () => {
  it("accepts a valid agent", () => {
    expect(BootstrapAgentSchema.safeParse(validAgent).success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = BootstrapAgentSchema.safeParse({ name: "x" });
    expect(result.success).toBe(false);
  });
});

describe("BootstrapRepoResultSchema", () => {
  it("accepts a valid repo result", () => {
    expect(BootstrapRepoResultSchema.safeParse(validRepo).success).toBe(true);
  });

  it("accepts optional error field", () => {
    const withError = { ...validRepo, success: false, error: "clone failed" };
    const result = BootstrapRepoResultSchema.safeParse(withError);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("clone failed");
    }
  });

  it("accepts nullable criticGates and metadata", () => {
    const withValues = {
      ...validRepo,
      criticGates: { quality: 0.8 },
      metadata: { commitSha: "abc123" },
    };
    const result = BootstrapRepoResultSchema.safeParse(withValues);
    expect(result.success).toBe(true);
  });

  it("accepts empty agents array", () => {
    const noAgents = { ...validRepo, agents: [] };
    expect(BootstrapRepoResultSchema.safeParse(noAgents).success).toBe(true);
  });
});

describe("BootstrapLoopResultSchema", () => {
  it("accepts a valid loop result", () => {
    const result = BootstrapLoopResultSchema.safeParse({
      repos: [validRepo],
      totalDuration: 45.2,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty repos array", () => {
    const result = BootstrapLoopResultSchema.safeParse({
      repos: [],
      totalDuration: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing totalDuration", () => {
    const result = BootstrapLoopResultSchema.safeParse({
      repos: [validRepo],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing repos", () => {
    const result = BootstrapLoopResultSchema.safeParse({
      totalDuration: 10,
    });
    expect(result.success).toBe(false);
  });
});
