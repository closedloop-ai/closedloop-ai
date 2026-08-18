import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  diffToolingReach,
  formatToolingReachGap,
  TOOLING_PARTITION,
  TOOLING_REACH_LEDGER,
  type ToolingReachLedgerEntry,
} from "../scripts/tooling-reach-ledger.mjs";

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

// A percentage is never a legitimate reason to exclude a file (PRD-618 rule 3:
// raising reach may lower a percentage, and that is progress). These catch a
// reason string that smuggles a number in as the justification.
const PERCENTAGE_REASON_PATTERN = /\d\s*%|percent(?:age)?\b/i;
const COVERAGE_EXCUSE_PATTERN =
  /\b(?:drags?|lowers?|below the (?:bar|average))\b/i;

function entry(
  pathValue: string,
  reason = "test reason"
): ToolingReachLedgerEntry {
  return { path: pathValue, reason };
}

// The reconciler is driven with SYNTHETIC file sets on purpose. Its job is
// set-reconciliation logic, so adding a real script to apps/desktop/scripts/
// must never redden these — only the staleness suite below reads the real tree.
describe("ISS-5303: diffToolingReach reconciles declared exclusions against a run", () => {
  test("an unreached file nobody declared is the silent gap, and is reported", () => {
    const diff = diffToolingReach(
      [entry("scripts/declared.mjs")],
      ["scripts/covered.mjs", "scripts/declared.mjs", "scripts/forgotten.mjs"],
      ["scripts/covered.mjs"]
    );

    assert.deepEqual(diff.unledgeredUnreached, ["scripts/forgotten.mjs"]);
    assert.deepEqual(diff.ledgeredUnreached, ["scripts/declared.mjs"]);
    assert.equal(diff.reconciled, false);
  });

  test("a fully reconciled set reports no gap", () => {
    const diff = diffToolingReach(
      [entry("scripts/declared.mjs")],
      ["scripts/covered.mjs", "scripts/declared.mjs"],
      ["scripts/covered.mjs"]
    );

    assert.deepEqual(diff.unledgeredUnreached, []);
    assert.deepEqual(diff.staleLedgered, []);
    assert.equal(diff.reconciled, true);
    assert.deepEqual(formatToolingReachGap(diff), []);
  });

  test("an entry whose file was deleted is stale", () => {
    const diff = diffToolingReach(
      [entry("scripts/deleted.mjs")],
      ["scripts/covered.mjs"],
      ["scripts/covered.mjs"]
    );

    assert.deepEqual(diff.staleLedgered, [
      { path: "scripts/deleted.mjs", kind: "missingFromSource" },
    ]);
    assert.equal(diff.reconciled, false);
  });

  test("an entry whose file is now executed is stale — the exclusion outlived its reason", () => {
    // The good-news case, and the one most likely to rot silently: somebody
    // adds a test for a ledgered script and the stale entry keeps claiming the
    // file is unreachable. An exclusion nobody revisits is just an
    // undocumented gap wearing a justification.
    const diff = diffToolingReach(
      [entry("scripts/nowtested.mjs")],
      ["scripts/nowtested.mjs"],
      ["scripts/nowtested.mjs"]
    );

    assert.deepEqual(diff.staleLedgered, [
      { path: "scripts/nowtested.mjs", kind: "actuallyExecuted" },
    ]);
    assert.equal(diff.reconciled, false);
  });

  test("counts ignore executed paths outside the source universe", () => {
    // The node lane's map carries src/ files too; only the tooling partition's
    // own files may count toward its executed total, or the reach ratio lies.
    const diff = diffToolingReach(
      [],
      ["scripts/a.mjs"],
      ["scripts/a.mjs", "src/main/index.ts"]
    );

    assert.equal(diff.counts.sourceFiles, 1);
    assert.equal(diff.counts.executedFiles, 1);
    assert.equal(diff.counts.unreached, 0);
  });

  test("the diagnostic names the file and what to do about it", () => {
    const diff = diffToolingReach(
      [entry("scripts/deleted.mjs")],
      ["scripts/forgotten.mjs"],
      []
    );
    const lines = formatToolingReachGap(diff);

    assert.equal(lines.length, 2);
    assert.ok(
      lines.some((line) => line.includes("scripts/forgotten.mjs")),
      "the unledgered file must be named"
    );
    assert.ok(
      lines.some((line) => line.includes("scripts/deleted.mjs")),
      "the stale entry must be named"
    );
  });
});

describe("ISS-5303: the shipped ledger is honest about the real tree", () => {
  test("every ledgered path still exists", () => {
    // This is the one test that reads the real tree: an entry pointing at a
    // renamed or deleted file is an exclusion with no subject.
    for (const ledgerEntry of TOOLING_REACH_LEDGER) {
      assert.ok(
        existsSync(path.join(desktopDir, ledgerEntry.path)),
        `ledger entry ${ledgerEntry.path} does not exist — remove or repoint it`
      );
    }
  });

  test("every ledgered path is in the tooling partition", () => {
    for (const ledgerEntry of TOOLING_REACH_LEDGER) {
      assert.ok(
        ledgerEntry.path.startsWith("scripts/"),
        `${ledgerEntry.path} is not a tooling-partition path; this ledger only describes ${TOOLING_PARTITION}`
      );
    }
  });

  test("no reason justifies an exclusion with a percentage", () => {
    // The failure mode this ledger exists to prevent is laundering an
    // inconvenient number into an "exclusion". A reason must be a
    // file-specific impossibility, never "it would drag the average down".
    for (const ledgerEntry of TOOLING_REACH_LEDGER) {
      assert.ok(
        !PERCENTAGE_REASON_PATTERN.test(ledgerEntry.reason),
        `${ledgerEntry.path}: a coverage percentage is not a reason to exclude a file (PRD-618 rule 3)`
      );
      assert.ok(
        !COVERAGE_EXCUSE_PATTERN.test(ledgerEntry.reason),
        `${ledgerEntry.path}: reason reads as a coverage excuse rather than a file-specific impossibility`
      );
    }
  });

  test("no duplicate entries", () => {
    const seen = new Set(TOOLING_REACH_LEDGER.map((item) => item.path));

    assert.equal(seen.size, TOOLING_REACH_LEDGER.length);
  });

  test("every reason is substantive", () => {
    for (const ledgerEntry of TOOLING_REACH_LEDGER) {
      assert.ok(
        ledgerEntry.reason.length > 40,
        `${ledgerEntry.path}: reason is too thin to review`
      );
    }
  });
});
