/**
 * Unit tests for ZIP parsing logic in GitHub webhook handler.
 *
 * Tests scenarios 1-6 from the testing strategy:
 * 1. ZIP with judges.json is extracted correctly
 * 2. ZIP without judges.json yields null
 * 3. ZIP with perf.jsonl extracts a parsed PerfSummary
 * 4. ZIP without perf.jsonl yields null perfSummary
 * 5. ZIP with code-judges.json is extracted correctly (separate from judges.json)
 * 6. code-judges.json does not populate judgesReport (no cross-contamination)
 */
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import { PromptType } from "@repo/database";
import {
  findPlanInZip,
  parseJudgesReport,
} from "@/app/webhooks/github/zip-parser";
import { parsePromptFrontmatter } from "@/lib/prompt-snapshot-ingestion";
import { buildZipWithEntries } from "../fixtures/zip-helpers";

describe("ZIP parsing for judges.json", () => {
  describe("findPlanInZip", () => {
    it("extracts judges.json when present in ZIP", () => {
      const mockJudgesReport: JudgesReport = {
        report_id: "test-report-123",
        timestamp: "2026-02-05T00:00:00Z",
        stats: [
          {
            type: "case_score",
            case_id: "test-judge",
            final_status: 1,
            metrics: [
              {
                metric_name: "test_score",
                threshold: 0.8,
                score: 0.95,
                justification: "Test justification",
              },
            ],
          },
        ],
      };

      const zipBuffer = buildZipWithEntries([
        { name: "plan.json", content: '{"content": "# Plan"}' },
        { name: "judges.json", content: JSON.stringify(mockJudgesReport) },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.judgesReport).not.toBeNull();
      expect(result.judgesReport).toEqual(mockJudgesReport);
    });

    it("returns null for judgesReport when judges.json is not present", () => {
      const zipBuffer = buildZipWithEntries([
        { name: "plan.json", content: '{"content": "# Plan"}' },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.judgesReport).toBeNull();
    });

    it("does not extract code-judges.json into judgesReport slot", () => {
      const mockCodeJudgesReport: JudgesReport = {
        report_id: "code-judges-report-123",
        timestamp: "2026-02-05T00:00:00Z",
        stats: [],
      };

      const zipBuffer = buildZipWithEntries([
        { name: "plan.json", content: '{"content": "# Plan"}' },
        {
          name: "code-judges.json",
          content: JSON.stringify(mockCodeJudgesReport),
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      // code-judges.json must NOT bleed into the judgesReport slot
      expect(result.judgesReport).toBeNull();
      // It must be available in the codeJudgesReport slot
      expect(result.codeJudgesReport).toEqual(mockCodeJudgesReport);
    });

    it("extracts both judges.json and code-judges.json independently", () => {
      const mockJudgesReport: JudgesReport = {
        report_id: "plan-judges-report",
        timestamp: "2026-02-05T00:00:00Z",
        stats: [],
      };
      const mockCodeJudgesReport: JudgesReport = {
        report_id: "code-judges-report",
        timestamp: "2026-02-05T00:01:00Z",
        stats: [],
      };

      const zipBuffer = buildZipWithEntries([
        { name: "plan.json", content: '{"content": "# Plan"}' },
        { name: "judges.json", content: JSON.stringify(mockJudgesReport) },
        {
          name: "code-judges.json",
          content: JSON.stringify(mockCodeJudgesReport),
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.judgesReport).toEqual(mockJudgesReport);
      expect(result.codeJudgesReport).toEqual(mockCodeJudgesReport);
    });
  });

  describe("perf.jsonl extraction", () => {
    const VALID_PERF_JSONL = [
      '{"event":"iteration","run_id":"test-run","iteration":1,"started_at":"2026-01-01T00:00:00Z","ended_at":"2026-01-01T00:01:00Z","duration_s":60,"status":"completed","claude_exit_code":0}',
      '{"event":"agent","run_id":"test-run","iteration":1,"agent_id":"a1","agent_type":"general","agent_name":"test-agent","started_at":"2026-01-01T00:00:00Z","ended_at":"2026-01-01T00:00:30Z","duration_s":30}',
      '{"event":"pipeline_step","run_id":"test-run","iteration":1,"step":1,"step_name":"build","started_at":"2026-01-01T00:00:00Z","ended_at":"2026-01-01T00:00:10Z","duration_s":10,"skipped":false,"exit_code":0}',
    ].join("\n");

    it("returns a parsed PerfSummary when perf.jsonl is present", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "plan.json",
          content:
            '{"content": "# Plan", "pendingTasks": [], "openQuestions": []}',
        },
        { name: "perf.jsonl", content: VALID_PERF_JSONL },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.perfSummary).not.toBeNull();
      const summary = result.perfSummary as PerfSummary;
      expect(summary.totalIterations).toBe(1);
      expect(summary.agentBreakdown).toHaveLength(1);
      expect(summary.agentBreakdown[0]).toMatchObject({
        agentName: "test-agent",
        agentType: "general",
        totalDurationS: 30,
        callCount: 1,
      });
      expect(summary.pipelineStepBreakdown).toHaveLength(1);
      expect(summary.pipelineStepBreakdown[0]).toMatchObject({
        stepName: "build",
        callCount: 1,
        skipCount: 0,
        totalDurationS: 10,
      });
    });

    it("returns null for perfSummary when perf.jsonl is not present", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "plan.json",
          content:
            '{"content": "# Plan", "pendingTasks": [], "openQuestions": []}',
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.perfSummary).toBeNull();
    });
  });

  describe("parseJudgesReport", () => {
    it("parses valid judges.json content", () => {
      const mockJudgesReport: JudgesReport = {
        report_id: "test-report",
        timestamp: "2026-02-05T00:00:00Z",
        stats: [],
      };

      const content = Buffer.from(JSON.stringify(mockJudgesReport), "utf-8");
      const result = parseJudgesReport(content, "judges.json");

      expect(result).not.toBeNull();
      expect(result).toEqual(mockJudgesReport);
    });

    it("returns null for malformed JSON", () => {
      const content = Buffer.from("invalid json", "utf-8");
      const result = parseJudgesReport(content, "judges.json");

      expect(result).toBeNull();
    });
  });
});

describe("agents-snapshot extraction", () => {
  const VALID_AGENT_FRONTMATTER = `---
name: my-agent
model: claude-opus-4-6
description: A general purpose agent
tools: bash, read, write
---

This is the agent system prompt content.
`;

  const VALID_JUDGE_FRONTMATTER = `---
name: my-judge
model: claude-opus-4-6
description: A judge agent
tools: read
---

This is the judge system prompt content.
`;

  describe("parsePromptFrontmatter", () => {
    it("returns AGENT type for a non-judges path", () => {
      const result = parsePromptFrontmatter(
        VALID_AGENT_FRONTMATTER,
        "agents-snapshot/my-agent.md"
      );

      expect(result).not.toBeNull();
      expect(result?.promptType).toBe(PromptType.AGENT);
      expect(result?.name).toBe("my-agent");
      expect(result?.model).toBe("claude-opus-4-6");
      expect(result?.description).toBe("A general purpose agent");
    });

    it("returns JUDGE type for a path under agents-snapshot/judges/", () => {
      const result = parsePromptFrontmatter(
        VALID_JUDGE_FRONTMATTER,
        "agents-snapshot/judges/my-judge.md"
      );

      expect(result).not.toBeNull();
      expect(result?.promptType).toBe(PromptType.JUDGE);
      expect(result?.name).toBe("my-judge");
    });

    it("parses tools from comma-separated string", () => {
      const result = parsePromptFrontmatter(
        VALID_AGENT_FRONTMATTER,
        "agents-snapshot/my-agent.md"
      );

      expect(result).not.toBeNull();
      expect(result?.tools).toEqual(["bash", "read", "write"]);
    });

    it("returns null when name field is missing", () => {
      const contentWithoutName = `---
model: claude-opus-4-6
description: Missing name field
---

Content here.
`;
      const result = parsePromptFrontmatter(
        contentWithoutName,
        "agents-snapshot/nameless.md"
      );

      expect(result).toBeNull();
    });

    it("returns null when frontmatter is missing entirely", () => {
      const contentWithoutFrontmatter =
        "Just plain content with no frontmatter.";
      const result = parsePromptFrontmatter(
        contentWithoutFrontmatter,
        "agents-snapshot/no-frontmatter.md"
      );

      expect(result).toBeNull();
    });
  });

  describe("findPlanInZip integration", () => {
    it("returns null promptsSnapshot when no agents-snapshot/ entries are in zip", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "plan.json",
          content:
            '{"content": "# Plan", "pendingTasks": [], "openQuestions": []}',
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.promptsSnapshot).toBeNull();
    });

    it("returns promptsSnapshot with parsed AGENT prompt when zip has agents-snapshot/my-agent.md", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "plan.json",
          content:
            '{"content": "# Plan", "pendingTasks": [], "openQuestions": []}',
        },
        {
          name: "agents-snapshot/my-agent.md",
          content: VALID_AGENT_FRONTMATTER,
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const result = findPlanInZip(zip);

      expect(result.promptsSnapshot).not.toBeNull();
      expect(result.promptsSnapshot?.prompts).toHaveLength(1);
      expect(result.promptsSnapshot?.prompts[0]).toMatchObject({
        promptType: PromptType.AGENT,
        name: "my-agent",
        model: "claude-opus-4-6",
        tools: ["bash", "read", "write"],
      });
    });
  });
});
