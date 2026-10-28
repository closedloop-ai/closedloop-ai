/**
 * @file data-revision-history-doc.test.ts
 * @description ISS-8625: the data revision ledger moved out of the source
 * file's header comment into `docs/desktop-data-revision-history.md`, which
 * removes the one thing that made an un-documented bump obvious — the entry
 * sitting three lines above the constant being edited. Nothing in the compiler
 * or the linter notices a doc that stopped tracking a constant, so this suite
 * is that notice.
 *
 * Direction matters: the constant is authoritative and the ledger follows it,
 * so every expectation here is read from the constants and never the reverse.
 * ISS-12552 (PRD-800 "Rollout") made the revision a pair chosen by the
 * parse policy; the ledger documents both, and the highest a build stamps is
 * `DATA_REVISION_ATTRIBUTION`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  DATA_REVISION_ATTRIBUTION,
  DATA_REVISION_BASE,
} from "../src/main/collectors/engine/data-revision.js";

/** The file the pointer comment in `data-revision.ts` names. */
const HISTORY_DOC = path.join(
  import.meta.dirname,
  "../../../docs/desktop-data-revision-history.md"
);

/**
 * The fenced block the ledger entries live in. Only its contents are scanned:
 * the prose above it is free to number things (a heading, an enumerated note),
 * and matching those would red the "no revision ahead of the constant"
 * assertion below for a sentence that documents nothing (marisolashgrove, PR
 * #6785).
 */
const LEDGER_FENCE = /^```text\n([\s\S]*?)^```/m;

/**
 * What opens a ledger entry, written out by hand rather than derived from the
 * doc: a line whose first non-space token is the revision number, followed by
 * the separator the ledger uses — `N — text` for the entries authored before
 * revision 55 and `N. text` for the ones after. Deriving this from the file
 * would let a ledger truncated to a stub redefine what "has an entry" means and
 * keep the suite green, which is the exact regression the move risks.
 */
const ENTRY_LINE = /^ *(\d+)(?:\. | — )/gm;

/** The first revision the ledger has ever carried; predates every bump. */
const OLDEST_REVISION = 1;

function ledgerRevisions(): number[] {
  const fenced = LEDGER_FENCE.exec(readFileSync(HISTORY_DOC, "utf8"));
  if (!fenced) {
    // Thrown rather than asserted so this reads as "the guard could not run"
    // rather than "the ledger is wrong", and so a fence that was renamed fails
    // loudly instead of handing all three tests an empty ledger to pass
    // vacuously against.
    throw new Error(
      "docs/desktop-data-revision-history.md has no ```text ledger fence, so every assertion in this file would read an empty ledger and pass vacuously. Repoint LEDGER_FENCE if the doc's fence changed."
    );
  }
  return [...fenced[1].matchAll(ENTRY_LINE)].map((match) => Number(match[1]));
}

test("the ledger documents both revisions the app stamps", () => {
  for (const revision of [DATA_REVISION_BASE, DATA_REVISION_ATTRIBUTION]) {
    assert.ok(
      ledgerRevisions().includes(revision),
      `docs/desktop-data-revision-history.md has no entry for revision ${revision}. Bumping a data revision means appending the entry that says what changed and whether a rebuild is required.`
    );
  }
});

test("no ledger entry names a revision the app has never stamped", () => {
  // The positive sibling of the assertion above: without it, a matcher that
  // reported every number as present would satisfy that test forever.
  //
  // Every revision ahead of the constant, not just `DATA_REVISION + 1` (whitlockk,
  // PR #6785): an entry landed at 102 while the app stamps 100 is the same
  // defect as one landed at 101 — a documented semantic change no build
  // performs — and the +1 form called it green.
  const ahead = ledgerRevisions().filter(
    (revision) => revision > DATA_REVISION_ATTRIBUTION
  );
  assert.deepEqual(
    ahead,
    [],
    `docs/desktop-data-revision-history.md documents revisions ${ahead.join(", ")}, which no build stamps. DATA_REVISION_ATTRIBUTION is ${DATA_REVISION_ATTRIBUTION}.`
  );
});

test("the ledger still covers every revision the app has ever stamped", () => {
  // The move was a copy of ~1,570 comment lines out of one file and into
  // another; a truncation would be invisible from either side. Contiguity from
  // 1 to the current revision is the cheapest whole-file check there is.
  const documented = new Set(ledgerRevisions());
  const missing: number[] = [];
  for (
    let revision = OLDEST_REVISION;
    revision <= DATA_REVISION_ATTRIBUTION;
    revision += 1
  ) {
    if (!documented.has(revision)) {
      missing.push(revision);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `docs/desktop-data-revision-history.md is missing entries for revisions ${missing.join(", ")}.`
  );
});
