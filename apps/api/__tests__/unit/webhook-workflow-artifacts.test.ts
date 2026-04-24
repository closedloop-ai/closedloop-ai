/**
 * Unit tests for mergeZipContent() in workflow-artifacts.ts.
 *
 * mergeZipContent is a pure function — no mocks needed.
 *
 * Tests cover:
 * - All-null current + all-null result → all-null output
 * - Non-null result fields overwrite null current fields
 * - Current non-null fields are preserved when result fields are null
 * - promptsSnapshot: both non-null → prompts arrays are concatenated
 * - promptsSnapshot: only result is non-null → result value used
 * - promptsSnapshot: only current is non-null → current value used
 * - promptsSnapshot: both null → null output
 */
import { describe, expect, it } from "vitest";
import { mergeZipContent } from "@/app/webhooks/github/handlers/workflow-artifacts";

const emptyContent = (): Parameters<typeof mergeZipContent>[1] => ({
  planContent: null,
  questionsContent: null,
  executionResult: null,
  judgesReport: null,
  codeJudgesReport: null,
  perfSummary: null,
  promptsSnapshot: null,
});

describe("mergeZipContent", () => {
  it("returns all-null output when both current and result are all-null", () => {
    const merged = mergeZipContent(emptyContent(), emptyContent());

    expect(merged.planContent).toBeNull();
    expect(merged.questionsContent).toBeNull();
    expect(merged.executionResult).toBeNull();
    expect(merged.judgesReport).toBeNull();
    expect(merged.codeJudgesReport).toBeNull();
    expect(merged.perfSummary).toBeNull();
    expect(merged.promptsSnapshot).toBeNull();
  });

  it("uses result value when current is null", () => {
    const result = {
      ...emptyContent(),
      planContent: "# Plan from result",
      questionsContent: "Questions from result",
    };

    const merged = mergeZipContent(emptyContent(), result);

    expect(merged.planContent).toBe("# Plan from result");
    expect(merged.questionsContent).toBe("Questions from result");
  });

  it("preserves current value when result field is null", () => {
    const current = {
      ...emptyContent(),
      planContent: "# Plan from current",
    };

    const merged = mergeZipContent(current, emptyContent());

    expect(merged.planContent).toBe("# Plan from current");
  });

  it("result value takes precedence over current value for scalar fields", () => {
    const current = {
      ...emptyContent(),
      planContent: "# Old plan",
    };
    const result = {
      ...emptyContent(),
      planContent: "# New plan",
    };

    const merged = mergeZipContent(current, result);

    expect(merged.planContent).toBe("# New plan");
  });

  it("concatenates prompts when both current and result have a promptsSnapshot", () => {
    const current = {
      ...emptyContent(),
      promptsSnapshot: {
        prompts: [
          {
            promptType: "AGENT" as const,
            name: "agent-one",
            description: "First agent",
            model: "claude-3",
            tools: ["bash"],
            filePath: "agents-snapshot/agent-one.md",
            content: "Agent one content",
          },
        ],
      },
    };

    const result = {
      ...emptyContent(),
      promptsSnapshot: {
        prompts: [
          {
            promptType: "JUDGE" as const,
            name: "judge-one",
            description: "First judge",
            model: "claude-3",
            tools: [],
            filePath: "agents-snapshot/judges/judge-one.md",
            content: "Judge one content",
          },
        ],
      },
    };

    const merged = mergeZipContent(current, result);

    expect(merged.promptsSnapshot).not.toBeNull();
    expect(merged.promptsSnapshot?.prompts).toHaveLength(2);
    expect(merged.promptsSnapshot?.prompts[0].name).toBe("agent-one");
    expect(merged.promptsSnapshot?.prompts[1].name).toBe("judge-one");
  });

  it("uses result promptsSnapshot when current promptsSnapshot is null", () => {
    const result = {
      ...emptyContent(),
      promptsSnapshot: {
        prompts: [
          {
            promptType: "AGENT" as const,
            name: "only-in-result",
            description: "Agent only in result",
            model: "claude-3",
            tools: [],
            filePath: "agents-snapshot/only-in-result.md",
            content: "Content",
          },
        ],
      },
    };

    const merged = mergeZipContent(emptyContent(), result);

    expect(merged.promptsSnapshot?.prompts).toHaveLength(1);
    expect(merged.promptsSnapshot?.prompts[0].name).toBe("only-in-result");
  });

  it("preserves current promptsSnapshot when result promptsSnapshot is null", () => {
    const current = {
      ...emptyContent(),
      promptsSnapshot: {
        prompts: [
          {
            promptType: "AGENT" as const,
            name: "only-in-current",
            description: "Agent only in current",
            model: "claude-3",
            tools: [],
            filePath: "agents-snapshot/only-in-current.md",
            content: "Content",
          },
        ],
      },
    };

    const merged = mergeZipContent(current, emptyContent());

    expect(merged.promptsSnapshot?.prompts).toHaveLength(1);
    expect(merged.promptsSnapshot?.prompts[0].name).toBe("only-in-current");
  });

  it("passes all fields through correctly in a realistic merge", () => {
    const mockJudgesReport = {
      report_id: "r-1",
      timestamp: "2026-01-01T00:00:00Z",
      stats: [],
    };
    const mockExecutionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/repo/pull/1",
      pr_number: 1,
      branch_name: "feature-branch",
      base_ref: "main",
    };
    const mockPerfSummary = {
      totalIterations: 2,
      totalDurationS: 120,
      agentBreakdown: [],
      pipelineStepBreakdown: [],
    };

    const current = {
      ...emptyContent(),
      planContent: "# Plan",
      judgesReport: mockJudgesReport,
    };
    const result = {
      ...emptyContent(),
      executionResult: mockExecutionResult,
      perfSummary: mockPerfSummary,
    };

    const merged = mergeZipContent(current, result);

    expect(merged.planContent).toBe("# Plan");
    expect(merged.judgesReport).toEqual(mockJudgesReport);
    expect(merged.executionResult).toEqual(mockExecutionResult);
    expect(merged.perfSummary).toEqual(mockPerfSummary);
    expect(merged.promptsSnapshot).toBeNull();
  });
});
