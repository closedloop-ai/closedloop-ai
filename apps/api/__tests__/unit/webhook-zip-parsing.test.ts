/**
 * Unit tests for ZIP parsing logic in GitHub webhook handler.
 *
 * Tests scenarios 1-11 from the testing strategy:
 * 1. ZIP with judges.json is extracted correctly
 * 2. ZIP without judges.json yields null
 * 3. ZIP with perf.jsonl extracts a parsed PerfSummary
 * 4. ZIP without perf.jsonl yields null perfSummary
 * 5. ZIP with code-judges.json is extracted correctly (separate from judges.json)
 * 6. code-judges.json does not match judgesReportExtractor (no cross-contamination)
 * 7. ZIP with agents-snapshot/ prompt files extracts PromptsSnapshot
 * 8. Multiple prompt files are accumulated into a single PromptsSnapshot
 * 9. Files in agents-snapshot/judges/ receive PromptType.JUDGE
 * 10. Files outside agents-snapshot/ are not matched by promptsExtractor
 * 11. mergeFrom accumulates PromptsSnapshot across bags (cross-bag accumulation)
 */
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PerfSummary } from "@repo/api/src/types/performance";
import { parseCodeJudgesReport } from "@/app/webhooks/github/extractors/code-judges-report-extractor";
import { parseJudgesReport } from "@/app/webhooks/github/extractors/judges-report-extractor";
import { CONTENT_KEYS } from "@/app/webhooks/github/extractors/keys";
import { PromptType } from "@/app/webhooks/github/extractors/prompt-types";
import { parsePromptFile } from "@/app/webhooks/github/extractors/prompts-extractor";
import {
  contentKey,
  ZipContentBag,
} from "@/app/webhooks/github/extractors/types";
import { findContentInZip } from "@/app/webhooks/github/zip-parser";
import { buildZipWithEntries } from "../fixtures/zip-helpers";

describe("ZIP parsing for judges.json", () => {
  describe("findContentInZip", () => {
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
      const { bag } = findContentInZip(zip);

      const judgesReport = bag.get(CONTENT_KEYS.judgesReport);
      expect(judgesReport).not.toBeNull();
      expect(judgesReport).toEqual(mockJudgesReport);
    });

    it("returns null for judgesReport when judges.json is not present", () => {
      const zipBuffer = buildZipWithEntries([
        { name: "plan.json", content: '{"content": "# Plan"}' },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const { bag } = findContentInZip(zip);

      expect(bag.get(CONTENT_KEYS.judgesReport)).toBeNull();
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
      const { bag } = findContentInZip(zip);

      // code-judges.json must NOT bleed into the judgesReport slot
      expect(bag.get(CONTENT_KEYS.judgesReport)).toBeNull();
      // It must be available in the codeJudgesReport slot
      expect(bag.get(CONTENT_KEYS.codeJudgesReport)).toEqual(
        mockCodeJudgesReport
      );
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
      const { bag } = findContentInZip(zip);

      expect(bag.get(CONTENT_KEYS.judgesReport)).toEqual(mockJudgesReport);
      expect(bag.get(CONTENT_KEYS.codeJudgesReport)).toEqual(
        mockCodeJudgesReport
      );
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
      const { bag } = findContentInZip(zip);

      const perfSummary = bag.get(CONTENT_KEYS.perfSummary);
      expect(perfSummary).not.toBeNull();

      const summary = perfSummary as PerfSummary;
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
      const { bag } = findContentInZip(zip);

      expect(bag.get(CONTENT_KEYS.perfSummary)).toBeNull();
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

  describe("parseCodeJudgesReport", () => {
    it("parses valid code-judges.json content", () => {
      const mockCodeJudgesReport: JudgesReport = {
        report_id: "code-judges-report",
        timestamp: "2026-02-05T00:00:00Z",
        stats: [
          {
            type: "case_score",
            case_id: "dry-judge",
            final_status: 1,
            metrics: [
              {
                metric_name: "dry_score",
                threshold: 0.8,
                score: 1.0,
                justification: "No violations detected.",
              },
            ],
          },
        ],
      };

      const content = Buffer.from(
        JSON.stringify(mockCodeJudgesReport),
        "utf-8"
      );
      const result = parseCodeJudgesReport(content, "code-judges.json");

      expect(result).not.toBeNull();
      expect(result).toEqual(mockCodeJudgesReport);
    });

    it("returns null for malformed JSON", () => {
      const content = Buffer.from("invalid json", "utf-8");
      const result = parseCodeJudgesReport(content, "code-judges.json");

      expect(result).toBeNull();
    });
  });
});

const AGENT_FRONTMATTER = `---
name: test-agent
description: A test agent for unit tests.
model: sonnet
tools: Read, Write, Bash
---

# Test Agent

This is the agent body.
`;

const JUDGE_FRONTMATTER = `---
name: test-judge
description: A test judge for unit tests.
model: haiku
tools: Read, Grep, Glob
---

# Test Judge

This is the judge body.
`;

describe("prompts extractor", () => {
  describe("parsePromptFile", () => {
    it("parses frontmatter fields from an agent prompt file", () => {
      const data = Buffer.from(AGENT_FRONTMATTER, "utf-8");
      const result = parsePromptFile(data, "agents-snapshot/test-agent.md");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("test-agent");
      expect(result?.description).toBe("A test agent for unit tests.");
      expect(result?.model).toBe("sonnet");
      expect(result?.tools).toEqual(["Read", "Write", "Bash"]);
      expect(result?.promptType).toBe(PromptType.AGENT);
      expect(result?.file_path).toBe("agents-snapshot/test-agent.md");
      expect(result?.content).toBe(AGENT_FRONTMATTER);
      expect(result?.sha).toBe("5ff120cd4250ab001ec7156f7a9a04171b058651");
    });

    it("assigns PromptType.JUDGE for files under agents-snapshot/judges/", () => {
      const data = Buffer.from(JUDGE_FRONTMATTER, "utf-8");
      const result = parsePromptFile(
        data,
        "agents-snapshot/judges/test-judge.md"
      );

      expect(result?.promptType).toBe(PromptType.JUDGE);
      expect(result?.name).toBe("test-judge");
      expect(result?.tools).toEqual(["Read", "Grep", "Glob"]);
      expect(result?.sha).toBe("b9e01659b5ac88b7f4b10c1a1635f5312815fcc6");
    });

    it("returns a PromptInfo with empty fields when frontmatter is absent", () => {
      const data = Buffer.from(
        "# No frontmatter here\n\nJust content.",
        "utf-8"
      );
      const result = parsePromptFile(data, "agents-snapshot/no-meta.md");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("");
      expect(result?.description).toBe("");
      expect(result?.model).toBe("");
      expect(result?.tools).toEqual([]);
      expect(result?.sha).toBe("9384236570fbffde6da3c9d35d79d7d23d128082");
    });
  });

  describe("findContentInZip with agents-snapshot files", () => {
    it("extracts a single agent prompt file into PromptsSnapshot", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "agents-snapshot/test-agent.md",
          content: AGENT_FRONTMATTER,
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const { bag } = findContentInZip(zip);

      const snapshot = bag.get(CONTENT_KEYS.promptsSnapshot);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.prompts).toHaveLength(1);
      expect(snapshot?.prompts[0].name).toBe("test-agent");
      expect(snapshot?.prompts[0].promptType).toBe(PromptType.AGENT);
    });

    it("accumulates multiple prompt files into a single PromptsSnapshot", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "agents-snapshot/agent-one.md",
          content: AGENT_FRONTMATTER,
        },
        {
          name: "agents-snapshot/judges/judge-one.md",
          content: JUDGE_FRONTMATTER,
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const { bag } = findContentInZip(zip);

      const snapshot = bag.get(CONTENT_KEYS.promptsSnapshot);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.prompts).toHaveLength(2);

      const types = snapshot?.prompts.map((p) => p.promptType);
      expect(types).toContain(PromptType.AGENT);
      expect(types).toContain(PromptType.JUDGE);
    });

    it("returns null for promptsSnapshot when no agents-snapshot/ files are present", () => {
      const zipBuffer = buildZipWithEntries([
        { name: "plan.json", content: '{"content": "# Plan"}' },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const { bag } = findContentInZip(zip);

      expect(bag.get(CONTENT_KEYS.promptsSnapshot)).toBeNull();
    });

    it("ignores files outside agents-snapshot/", () => {
      const zipBuffer = buildZipWithEntries([
        { name: "some-other-folder/agent.md", content: AGENT_FRONTMATTER },
        { name: "agents-snapshot/real-agent.md", content: AGENT_FRONTMATTER },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const { bag } = findContentInZip(zip);

      const snapshot = bag.get(CONTENT_KEYS.promptsSnapshot);
      expect(snapshot?.prompts).toHaveLength(1);
      expect(snapshot?.prompts[0].file_path).toBe(
        "agents-snapshot/real-agent.md"
      );
    });

    it("matches prompt files prefixed with runs/<id>/ and strips the prefix from file_path", () => {
      const zipBuffer = buildZipWithEntries([
        {
          name: "runs/20240223-123456/agents-snapshot/test-agent.md",
          content: AGENT_FRONTMATTER,
        },
        {
          name: "runs/20240223-123456/agents-snapshot/judges/test-judge.md",
          content: JUDGE_FRONTMATTER,
        },
      ]);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipBuffer);
      const { bag } = findContentInZip(zip);

      const snapshot = bag.get(CONTENT_KEYS.promptsSnapshot);
      expect(snapshot?.prompts).toHaveLength(2);

      const agent = snapshot?.prompts.find(
        (p) => p.promptType === PromptType.AGENT
      );
      expect(agent?.file_path).toBe("agents-snapshot/test-agent.md");
      expect(agent?.name).toBe("test-agent");

      const judge = snapshot?.prompts.find(
        (p) => p.promptType === PromptType.JUDGE
      );
      expect(judge?.file_path).toBe("agents-snapshot/judges/test-judge.md");
      expect(judge?.name).toBe("test-judge");
    });
  });
});

describe("ZipContentBag.mergeFrom cross-bag accumulation", () => {
  it("accumulates PromptsSnapshot from two bags via setAccumulating", () => {
    const key = contentKey<{ items: string[] }>("test-accum");
    const mergeFn = (a: { items: string[] }, b: { items: string[] }) => ({
      items: [...a.items, ...b.items],
    });

    const bagA = new ZipContentBag();
    bagA.setAccumulating(key, { items: ["a1", "a2"] }, mergeFn);

    const bagB = new ZipContentBag();
    bagB.setAccumulating(key, { items: ["b1"] }, mergeFn);

    bagA.mergeFrom(bagB);

    expect(bagA.get(key)).toEqual({ items: ["a1", "a2", "b1"] });
  });

  it("accumulates into an empty bag (no prior value for key)", () => {
    const key = contentKey<{ items: string[] }>("test-accum-empty");
    const mergeFn = (a: { items: string[] }, b: { items: string[] }) => ({
      items: [...a.items, ...b.items],
    });

    const bagA = new ZipContentBag();

    const bagB = new ZipContentBag();
    bagB.setAccumulating(key, { items: ["b1"] }, mergeFn);

    bagA.mergeFrom(bagB);

    expect(bagA.get(key)).toEqual({ items: ["b1"] });
  });

  it("accumulates PromptsSnapshot across two findContentInZip bags", () => {
    const AdmZip = require("adm-zip");

    const zipBufferA = buildZipWithEntries([
      { name: "agents-snapshot/agent-one.md", content: AGENT_FRONTMATTER },
    ]);
    const zipBufferB = buildZipWithEntries([
      {
        name: "agents-snapshot/judges/judge-one.md",
        content: JUDGE_FRONTMATTER,
      },
    ]);

    const { bag: bagA } = findContentInZip(new AdmZip(zipBufferA));
    const { bag: bagB } = findContentInZip(new AdmZip(zipBufferB));

    bagA.mergeFrom(bagB);

    const snapshot = bagA.get(CONTENT_KEYS.promptsSnapshot);
    expect(snapshot?.prompts).toHaveLength(2);

    const names = snapshot?.prompts.map((p) => p.name);
    expect(names).toContain("test-agent");
    expect(names).toContain("test-judge");
  });

  it("does not lose first bag prompts when second bag has same key at equal priority", () => {
    const AdmZip = require("adm-zip");

    const zipBufferA = buildZipWithEntries([
      { name: "agents-snapshot/agent-one.md", content: AGENT_FRONTMATTER },
    ]);
    const zipBufferB = buildZipWithEntries([
      { name: "agents-snapshot/agent-two.md", content: AGENT_FRONTMATTER },
    ]);

    const { bag: bagA } = findContentInZip(new AdmZip(zipBufferA));
    const { bag: bagB } = findContentInZip(new AdmZip(zipBufferB));

    bagA.mergeFrom(bagB);

    const snapshot = bagA.get(CONTENT_KEYS.promptsSnapshot);
    // Both agents should be present — the bug would have dropped agent-two
    expect(snapshot?.prompts).toHaveLength(2);
  });

  it("priority-wins semantics still apply to non-accumulating keys", () => {
    const key = contentKey<string>("priority-key");

    const bagA = new ZipContentBag();
    bagA.set(key, "low-priority", 1);

    const bagB = new ZipContentBag();
    bagB.set(key, "high-priority", 10);

    bagA.mergeFrom(bagB);

    expect(bagA.get(key)).toBe("high-priority");
  });

  it("lower-priority non-accumulating value does not overwrite higher-priority", () => {
    const key = contentKey<string>("priority-key-no-overwrite");

    const bagA = new ZipContentBag();
    bagA.set(key, "high-priority", 10);

    const bagB = new ZipContentBag();
    bagB.set(key, "low-priority", 1);

    bagA.mergeFrom(bagB);

    expect(bagA.get(key)).toBe("high-priority");
  });
});
