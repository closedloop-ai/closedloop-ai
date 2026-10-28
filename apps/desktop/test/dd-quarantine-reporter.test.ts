/**
 * @file dd-quarantine-reporter.test.ts
 * @description ISS-10304 — desktop-lane coverage for the ISS-10132 Playwright
 * reporter (`scripts/dd-quarantine-reporter.ts`). The gate integration is
 * owned by `scripts/lint/desktop-e2e-exit-code-workflow-source.test.ts`, which
 * runs in the repo-root lint lane; that lane does not load the file in the
 * desktop c8 run, so the tooling reach gate in `coverage-main.yml` reported it
 * unreached. This suite pins the reporter's own contract: the file it writes,
 * which tagged tests it records, and the three fields it records for each.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FullConfig, TestCase } from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, test } from "vitest";
import DatadogQuarantineReporter, {
  QUARANTINE_REPORT_FILENAME,
} from "../scripts/dd-quarantine-reporter.js";

type DatadogTags = {
  _ddIsAttemptToFix?: boolean;
  _ddIsQuarantined?: boolean;
};

type TagCase = {
  name: string;
  recorded: boolean;
  tags: DatadogTags;
};

const SPEC_LINE = 42;
const SPEC_TITLE = "renders the session list";
const SPEC_SEGMENTS = ["sessions", "list.spec.ts"];

// Both "not set" spellings, absent and `false`, appear on each side of the
// predicate, so swapping either comparison for its `false`-based twin
// (`!== false`, `=== false`) fails a row. A truthiness check does not: for a
// boolean or absent tag it gives the same answer as `=== true`.
const TAG_CASES: TagCase[] = [
  {
    name: "quarantined, attempt-to-fix absent",
    recorded: true,
    tags: { _ddIsQuarantined: true },
  },
  {
    name: "quarantined, attempt-to-fix false",
    recorded: true,
    tags: { _ddIsAttemptToFix: false, _ddIsQuarantined: true },
  },
  {
    name: "quarantined and attempt-to-fix",
    recorded: false,
    tags: { _ddIsAttemptToFix: true, _ddIsQuarantined: true },
  },
  { name: "neither tag", recorded: false, tags: {} },
  {
    name: "both tags false",
    recorded: false,
    tags: { _ddIsAttemptToFix: false, _ddIsQuarantined: false },
  },
  {
    name: "attempt-to-fix only",
    recorded: false,
    tags: { _ddIsAttemptToFix: true },
  },
  {
    name: "quarantined false, attempt-to-fix true",
    recorded: false,
    tags: { _ddIsAttemptToFix: true, _ddIsQuarantined: false },
  },
];

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "iss10304-dd-quarantine-"));
});

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true });
  workDir = "";
});

describe("DatadogQuarantineReporter", () => {
  test("onEnd writes the report into outputDir with no quarantined tests", () => {
    // A nested, not-yet-created directory: the reporter owns creating it, and
    // an empty report must still be a file — "none quarantined" and "never
    // ran" must not look the same to the gate.
    const outputDir = path.join(workDir, "results", "nested");
    const reporter = new DatadogQuarantineReporter({ outputDir });
    reporter.onBegin(configAt(workDir));
    reporter.onEnd();

    assert.deepEqual(readdirSync(outputDir), [QUARANTINE_REPORT_FILENAME]);
    assert.deepEqual(readReport(outputDir), { quarantinedSpecs: [] });
  });

  for (const tagCase of TAG_CASES) {
    test(`onTestEnd ${tagCase.recorded ? "records" : "skips"} a test: ${tagCase.name}`, () => {
      const rootDir = path.join(workDir, "e2e");
      const reporter = new DatadogQuarantineReporter({ outputDir: workDir });
      reporter.onBegin(configAt(rootDir));
      reporter.onTestEnd(testCaseAt(rootDir, tagCase.tags));
      reporter.onEnd();

      assert.equal(
        readReport(workDir).quarantinedSpecs.length,
        tagCase.recorded ? 1 : 0
      );
    });
  }

  test("records file relative to the onBegin rootDir, with the test's line and title", () => {
    // rootDir is a temp directory, never the process cwd, so a reporter that
    // resolved against cwd instead of `config.rootDir` produces a different path.
    const rootDir = path.join(workDir, "e2e");
    const reporter = new DatadogQuarantineReporter({ outputDir: workDir });
    reporter.onBegin(configAt(rootDir));
    reporter.onTestEnd(testCaseAt(rootDir, { _ddIsQuarantined: true }));
    reporter.onEnd();

    assert.deepEqual(readReport(workDir), {
      quarantinedSpecs: [
        {
          file: path.join(...SPEC_SEGMENTS),
          line: SPEC_LINE,
          title: SPEC_TITLE,
        },
      ],
    });
  });
});

// The reporter reads `rootDir` off the config and `location`, `title`, and the
// two dd-trace tags off the test. A full Playwright `FullConfig` or `TestCase`
// cannot be built outside the runner, so each helper casts once from the
// fields the reporter actually reads.
function configAt(rootDir: string): FullConfig {
  return { rootDir } as FullConfig;
}

function testCaseAt(rootDir: string, tags: DatadogTags): TestCase {
  return {
    ...tags,
    location: {
      column: 1,
      file: path.join(rootDir, ...SPEC_SEGMENTS),
      line: SPEC_LINE,
    },
    title: SPEC_TITLE,
  } as TestCase;
}

function readReport(outputDir: string): {
  quarantinedSpecs: Array<{ file: string; line: number; title: string }>;
} {
  return JSON.parse(
    readFileSync(path.join(outputDir, QUARANTINE_REPORT_FILENAME), "utf8")
  );
}
