/**
 * Unit tests for ZIP parsing logic in GitHub webhook handler.
 *
 * Tests scenarios 1-4 from the testing strategy:
 * 1. ZIP with judges.json is extracted correctly
 * 2. ZIP without judges.json yields null
 * 3. ZIP with perf.jsonl extracts a parsed PerfSummary
 * 4. ZIP without perf.jsonl yields null perfSummary
 */
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import {
  findPlanInZip,
  parseJudgesReport,
} from "@/app/webhooks/github/zip-parser";
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
