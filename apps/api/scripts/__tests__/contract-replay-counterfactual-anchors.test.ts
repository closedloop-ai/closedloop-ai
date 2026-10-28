import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COUNTERFACTUALS,
  occurrences,
  REPO_ROOT,
} from "../contract-replay-counterfactual";

/**
 * ISS-9846 — keeps the counterfactual harness's anchors alive.
 *
 * `runOne` already aborts on an anchor that does not occur exactly once, but
 * nothing RUNS it: no package script references the harness and it costs a full
 * integration-suite execution per entry, so anchor rot would surface the first
 * time somebody reached for it — during an incident, months after the reformat
 * that broke it. This suite asks the same question for free, on the PR that
 * causes it.
 *
 * It deliberately does not run a single mutation: it pins that each `find`
 * string still identifies exactly one place in its file, which is the whole
 * precondition the harness's verdicts rest on.
 */
describe("contract-replay counterfactual anchors", () => {
  it("names at least the five reproducible incidents", () => {
    // A table silently emptied by a bad edit would make every assertion below
    // vacuously pass.
    expect(COUNTERFACTUALS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(COUNTERFACTUALS.map((entry) => [entry.incident, entry] as const))(
    "%s anchors to exactly one place in its file",
    (_incident, entry) => {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), "utf8");
      expect({
        file: entry.file,
        found: occurrences(source, entry.find),
      }).toEqual({ file: entry.file, found: 1 });
    }
  );

  it.each(COUNTERFACTUALS.map((entry) => [entry.incident, entry] as const))(
    "%s actually changes the source it mutates",
    (_incident, entry) => {
      // A `replace` equal to its `find` writes the file back unchanged, runs the
      // suite green, and reports "the layer does not guard this" — the exact
      // false finding the anchor check exists to prevent.
      expect(entry.replace).not.toBe(entry.find);
    }
  );
});
