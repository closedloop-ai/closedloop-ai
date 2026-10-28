import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FullConfig } from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DatadogQuarantineReporter, {
  QUARANTINE_REPORT_FILENAME,
} from "../scripts/dd-quarantine-reporter.js";

describe("DatadogQuarantineReporter default outputDir", () => {
  let workDir = "";

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "dd-quarantine-cwd-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("writes the report into process.cwd() when no outputDir is given", () => {
    vi.spyOn(process, "cwd").mockReturnValue(workDir);
    const reporter = new DatadogQuarantineReporter();
    reporter.onBegin({ rootDir: workDir } as FullConfig);
    reporter.onEnd();

    const report = JSON.parse(
      readFileSync(path.join(workDir, QUARANTINE_REPORT_FILENAME), "utf8")
    );
    expect(report).toEqual({ quarantinedSpecs: [] });
  });
});
