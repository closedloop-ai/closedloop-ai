/**
 * Unit tests for ZIP parsing logic in GitHub webhook handler.
 *
 * Tests scenarios 1-2 from the testing strategy:
 * 1. ZIP with judges.json is extracted correctly
 * 2. ZIP without judges.json yields null
 */
import type { JudgesReport } from "@repo/api/src/types/evaluation";
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
