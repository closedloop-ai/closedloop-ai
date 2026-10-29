/**
 * ISS-7841 — the coverage-manifest half of the Layer 1 golden harness.
 *
 * Split out of `golden-corpus.ts`, which carried both dossier
 * discovery/normalization and the whole `test-cases.csv` /
 * `collection-matrix.csv` reconciliation concern. These four tests answer one
 * question — does the coverage manifest tell the truth about the corpus — and
 * they share the CSV parser and the importability rule below.
 *
 * The importability rule: a Layer 2/3/4 row whose cited sessions are ALL
 * null-normalized DROP dossiers contributes no rows to the store that layer
 * reads, so the row claims evidence that structurally cannot exist. Layer 1 is
 * exempt — a dropped dossier is exactly what its DROP contract asserts.
 *
 * ISS-8561 separated that rule from CITATION, which it used to swallow. Being
 * unimportable excuses a dossier from LAYERED rows; it does not excuse it from
 * appearing in the coverage record at all. Opencode is why: its only dossier
 * was a DROP, the citation loop skipped DROP dossiers, and so the harness had
 * no row in either manifest, in any status, with no test able to say so.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import type { GoldenDossier } from "./golden-corpus.js";
import { uncoveredOperationFamilies } from "./golden-manifest-operation-families.js";

// Session ids as they appear in the coverage CSVs: UUIDs, plus opencode ids in
// both spellings. The opencode parser emits `opencode-<raw session.id>` as
// NormalizedSession.sessionId, so an importable opencode dossier's directory —
// and therefore its manifest citation — carries that prefix, while a
// null-normalized DROP dossier predates it and is named by the raw id alone.
// The prefixed alternative is REQUIRED — without it the scan yields
// `ses_fa6832…`, which matches no dossier directory. Its position among the
// alternatives is not: matching is leftmost-first, and at position 0 of
// `opencode-ses_…` a bare `ses_` cannot match whichever order they are in.
const SESSION_ID_TOKEN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|opencode-ses_[A-Za-z0-9]+|ses_[A-Za-z0-9]+/g;

// A dossier's `provenance.md` names the collection-matrix cell it fills.
const MATRIX_CLAIM_RE = /`collection-matrix\.csv` rows satisfied:\s*(.+)/;

/**
 * Whether a provenance matrix claim declares that the dossier fills NO cell.
 * `N/A` is the synthetic-dossier spelling, `(none` the unmatrixed one, and
 * `(already covered)` marks a real cell another dossier is the one filling.
 */
function isNoMatrixCellClaim(claim: string): boolean {
  const text = claim.trim();
  return (
    text.startsWith("N/A") ||
    text.startsWith("(none") ||
    text.includes("(already covered)")
  );
}

export function registerCoverageManifestTests(
  corpusDir: string,
  dossiers: GoldenDossier[]
): void {
  test("coverage manifests reconcile with the corpus", () => {
    if (dossiers.length === 0) {
      return; // pre-corpus no-op
    }
    const manifestContents = new Map<string, string>();
    for (const csv of MANIFEST_CSV_NAMES) {
      const p = join(corpusDir, csv);
      if (!existsSync(p)) {
        continue;
      }
      manifestContents.set(csv, readFileSync(p, "utf8"));
    }
    assert.ok(
      manifestContents.has(TEST_CASES_CSV),
      "coverage reconciliation requires test-cases.csv"
    );
    const issues = reconcileCoverageManifests(dossiers, manifestContents);
    assert.equal(issues.length, 0, issues.join("\n"));
  });

  // ISS-8751: the reconciliation above pools BOTH CSVs into one `cited` set, so
  // a dossier named only by `test-cases.csv` satisfies it and an omission from
  // `collection-matrix.csv` cannot fail it. Four ISS-7258 dossiers shipped that
  // way — each `provenance.md` stating a matrix cell that was never written.
  // Hold each dossier to its OWN declaration rather than guessing which ones
  // belong in a collection matrix: a concrete cell must be cited, and the three
  // established ways of declaring it fills no cell are the exemption.
  test("a dossier claiming a collection-matrix cell is cited there", () => {
    const matrixPath = join(corpusDir, "collection-matrix.csv");
    if (dossiers.length === 0 || !existsSync(matrixPath)) {
      return; // pre-corpus no-op
    }
    const matrix = readFileSync(matrixPath, "utf8");
    const unfulfilled: string[] = [];
    for (const d of dossiers) {
      const provenancePath = join(corpusDir, d.sessionId, "provenance.md");
      if (!existsSync(provenancePath)) {
        continue;
      }
      const claim = MATRIX_CLAIM_RE.exec(readFileSync(provenancePath, "utf8"));
      if (!claim || isNoMatrixCellClaim(claim[1])) {
        continue;
      }
      if (!matrix.includes(d.sessionId)) {
        unfulfilled.push(
          `${d.sessionId}: provenance.md claims collection-matrix cell "${claim[1].trim()}" but the row does not cite it — write the row, or declare N/A`
        );
      }
    }
    assert.equal(unfulfilled.length, 0, unfulfilled.join("\n"));
  });

  test("layered manifest rows require an importable cited session", () => {
    const header = "id,category,test_case,layer,status,sessions";
    const currentTc075 = `${header}\nTC-075,Filter & search correctness,Filter that matches nothing (empty result renders correctly),3,collected,${NULL_NORMALIZED_FIXTURE_SESSION_ID}\n`;
    const correctedTc075 = `${header}\nTC-075,Filter & search correctness,Filter that matches nothing (empty result renders correctly),3,needed,\n`;
    const nullNormalizedDossierIds = new Set([
      NULL_NORMALIZED_FIXTURE_SESSION_ID,
    ]);
    const assertNoImportabilityIssues = (csv: string): void => {
      const issues = findLayeredManifestImportabilityIssues(
        csv,
        nullNormalizedDossierIds
      );
      assert.equal(issues.length, 0, issues.join("\n"));
    };

    assert.throws(
      () => assertNoImportabilityIssues(currentTc075),
      NULL_NORMALIZED_TC075_LAYER,
      "today's TC-075 shape must fail because its only cited dossier is dropped"
    );
    assert.doesNotThrow(
      () => assertNoImportabilityIssues(correctedTc075),
      "the corrected needed row has no false claim of collected store evidence"
    );
    assert.doesNotThrow(() =>
      assertNoImportabilityIssues(
        currentTc075.replace(
          NULL_NORMALIZED_FIXTURE_SESSION_ID,
          `${NULL_NORMALIZED_FIXTURE_SESSION_ID};${IMPORTABLE_FIXTURE_SESSION_ID}`
        )
      )
    );
    for (const layer of [2, 4]) {
      const layeredFixture = currentTc075.replace(
        ",3,collected,",
        `,${layer},collected,`
      );
      assert.throws(
        () => assertNoImportabilityIssues(layeredFixture),
        NULL_NORMALIZED_TC075_LAYER
      );
    }
    assert.doesNotThrow(() =>
      assertNoImportabilityIssues(
        currentTc075.replace(",3,collected,", ",1,collected,")
      )
    );
    assert.doesNotThrow(() => assertNoImportabilityIssues(""));
    for (const malformedHeader of [
      currentTc075.replace("id,category", "category"),
      currentTc075.replace(",layer,status", ",status"),
      currentTc075.replace(",sessions\n", "\n"),
    ]) {
      assert.throws(
        () => assertNoImportabilityIssues(malformedHeader),
        MISSING_TEST_CASES_COLUMN
      );
    }
  });

  test("every dossier must be cited, DROP dossiers included", () => {
    // ISS-8561: the citation half used to skip null-normalized dossiers
    // entirely, so a harness represented ONLY by DROP dossiers vanished from
    // the coverage record with no test able to notice — which is exactly what
    // happened to opencode. The layered-importability exemption below still
    // stands (a DROP dossier contributes no store rows, so it must not appear
    // on a Layer 2/3/4 row); what it may no longer buy is silence.
    const header = "id,category,test_case,layer,status,sessions";
    const layer1Row = (sessions: string) =>
      `${header}\nTC-900,Model attribution,synthetic citation fixture,1,collected,${sessions}\n`;

    // The DROP fixture carries `normalized: null` — the exact shape the retired
    // exemption keyed on — so re-adding that filter turns the middle assertion
    // red instead of leaving it vacuously green.
    const importable = {
      sessionId: IMPORTABLE_FIXTURE_SESSION_ID,
      normalized: {},
    };
    const dropped = {
      sessionId: NULL_NORMALIZED_FIXTURE_SESSION_ID,
      normalized: null,
    };

    // ISS-8561 (davetho review): drive the SAME function the corpus is held
    // to, not the leaf helper. Re-adding a `normalized !== null` filter at the
    // call site — the mutation this guard exists to catch — used to leave every
    // assertion here green.
    const reconcile = (
      fixtures: readonly Pick<GoldenDossier, "sessionId" | "normalized">[],
      sessions: string
    ): string[] =>
      reconcileCoverageManifests(
        fixtures,
        new Map([[TEST_CASES_CSV, layer1Row(sessions)]])
      );

    assert.deepEqual(
      reconcile([importable], IMPORTABLE_FIXTURE_SESSION_ID),
      [],
      "a cited importable dossier is not a finding"
    );

    const issues = reconcile(
      [importable, dropped],
      IMPORTABLE_FIXTURE_SESSION_ID
    );
    assert.equal(
      issues.length,
      1,
      `an uncited DROP dossier must be reported, not exempted: ${issues.join("\n")}`
    );
    assert.match(issues[0], UNCITED_DOSSIER);
    assert.ok(issues[0].includes(NULL_NORMALIZED_FIXTURE_SESSION_ID));

    assert.deepEqual(
      reconcile(
        [importable, dropped],
        `${IMPORTABLE_FIXTURE_SESSION_ID};${NULL_NORMALIZED_FIXTURE_SESSION_ID}`
      ),
      [],
      "citing the DROP dossier from a Layer 1 row clears the finding"
    );

    // The other direction: a citation with no dossier behind it.
    assert.match(
      reconcile([importable], NULL_NORMALIZED_FIXTURE_SESSION_ID).join("\n"),
      CITED_WITHOUT_DOSSIER
    );

    // The prefixed opencode id must tokenize as ONE citation. A bare `ses_`
    // match would yield `ses_fa6832…`, which is no dossier's directory name, so
    // the importable dossier would read as uncited AND the leftover token would
    // trip the "cites a session with no dossier" assertion.
    assert.deepEqual(
      reconcile(
        [{ sessionId: OPENCODE_FIXTURE_SESSION_ID, normalized: {} }],
        OPENCODE_FIXTURE_SESSION_ID
      ),
      []
    );
  });

  test("only the sessions column counts as a citation", () => {
    // ISS-8561 (whitlockk review): both manifests carry free prose, so a scan over
    // the whole file counts a MENTION as coverage. A dossier named only in a
    // note would clear the uncited guard with no coverage cell behind it.
    const dossier = {
      sessionId: IMPORTABLE_FIXTURE_SESSION_ID,
      normalized: {},
    };
    const inNotesOnly = new Map([
      [
        TEST_CASES_CSV,
        `id,category,test_case,layer,status,sessions\nTC-901,Model attribution,see ${IMPORTABLE_FIXTURE_SESSION_ID} for context,1,needed,\n`,
      ],
    ]);
    assert.match(
      reconcileCoverageManifests([dossier], inNotesOnly).join("\n"),
      UNCITED_DOSSIER,
      "an id mentioned in prose is not a citation"
    );

    const inSessionsCell = new Map([
      [
        TEST_CASES_CSV,
        `id,category,test_case,layer,status,sessions\nTC-901,Model attribution,no id here,1,collected,${IMPORTABLE_FIXTURE_SESSION_ID}\n`,
      ],
    ]);
    assert.deepEqual(
      reconcileCoverageManifests([dossier], inSessionsCell),
      [],
      "the same id in the sessions cell IS a citation"
    );

    // A manifest that lost the column is a finding, never an empty citation
    // set — silently returning nothing would report every dossier as uncited.
    assert.match(
      reconcileCoverageManifests(
        [dossier],
        new Map([
          [
            "collection-matrix.csv",
            `Model,Harness,notes\nGPT 5.5,OpenCode,${IMPORTABLE_FIXTURE_SESSION_ID}\n`,
          ],
        ])
      ).join("\n"),
      MISSING_SESSIONS_COLUMN
    );
  });

  test("coverage manifest status values are valid rungs", () => {
    // ISS-12552: `unsupported` marks a harness with no evidence path yet.
    const validStatuses = new Set(["needed", "collected", "unsupported"]);
    for (const csv of ["test-cases.csv", "collection-matrix.csv"]) {
      const p = join(corpusDir, csv);
      if (!existsSync(p)) {
        continue;
      }
      const content = readFileSync(p, "utf8");
      const rows = parseCsvRows(content);
      if (rows.length === 0) {
        continue;
      }
      const header = rows[0];
      const statusIdx = header.indexOf("status");
      assert.ok(statusIdx !== -1, `${csv}: no "status" column in header row`);
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        assert.equal(
          row.length,
          header.length,
          `${csv} row ${i + 1}: ${row.length} fields, but the header declares ${header.length}`
        );
        const status = row[statusIdx];
        assert.ok(
          validStatuses.has(status),
          `${csv} row ${i + 1}: status "${status}" is not a valid rung (expected "needed", "collected" or "unsupported")`
        );
      }
    }
  });

  test("every Closedloop operation family is cited by a test-cases.csv row", () => {
    const rows = parseCsvRows(
      readFileSync(join(corpusDir, TEST_CASES_CSV), "utf8")
    );
    assert.deepEqual(uncoveredOperationFamilies(rows), []);
    const withoutCreate = rows.filter(
      (row) => !row.join(",").includes("[operation family: create]")
    );
    assert.deepEqual(
      uncoveredOperationFamilies(withoutCreate),
      ["create"],
      "dropping the only rows for a family must report that family"
    );
  });

  test("coverage manifest parser fails loudly on a swallowed row", () => {
    // An unterminated quote absorbs every following row into one field, so a
    // corrupt manifest would parse to a shorter, all-valid row set and the rung
    // assertion above would pass on rows it never saw.
    const swallowed = 'id,status\nTC-001,"collected\nTC-002,bogus\n';
    assert.throws(
      () => parseCsvRows(swallowed),
      UNTERMINATED_QUOTED_FIELD,
      "a quote left open must reject the parse, not silently truncate it"
    );
    // The rejection must not come at the cost of legitimate quoted fields.
    const wellFormed = 'id,status\nTC-001,"col,lected"\nTC-002,needed\n';
    assert.deepEqual(parseCsvRows(wellFormed), [
      ["id", "status"],
      ["TC-001", "col,lected"],
      ["TC-002", "needed"],
    ]);
  });
}

/**
 * Minimal RFC 4180 CSV parser — handles quoted fields containing commas,
 * newlines, and escaped quotes (`""`). Returns an array of rows, each an
 * array of string fields. Empty trailing lines are dropped.
 *
 * Decomposed into helpers to stay under the cognitive-complexity ceiling.
 *
 * Parses .csv data files only — it never raw-text-scans .ts source, which the
 * no-raw-text-source-scan gate forbids (AGENTS.md).
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const result =
      text[pos] === '"'
        ? parseQuotedField(text, pos)
        : parseUnquotedField(text, pos);
    row.push(result.field);
    pos = result.next;
    if (pos < text.length && text[pos] === ",") {
      pos++;
    } else {
      pos = skipNewline(text, pos);
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
    rows.push(row);
  }
  return rows;
}

/** Advance past a CRLF or LF newline, or return the position unchanged. */
function skipNewline(text: string, pos: number): number {
  if (pos >= text.length) {
    return pos;
  }
  if (text[pos] === "\r" && pos + 1 < text.length && text[pos + 1] === "\n") {
    return pos + 2;
  }
  if (text[pos] === "\n" || text[pos] === "\r") {
    return pos + 1;
  }
  return pos;
}

/** Parse a quoted CSV field starting at the opening `"`. */
function parseQuotedField(
  text: string,
  start: number
): { field: string; next: number } {
  let i = start + 1; // skip opening quote
  let field = "";
  while (i < text.length) {
    if (text[i] !== '"') {
      field += text[i];
      i++;
      continue;
    }
    // Doubled quote = escaped literal quote.
    if (i + 1 < text.length && text[i + 1] === '"') {
      field += '"';
      i += 2;
      continue;
    }
    // Closing quote.
    return { field, next: i + 1 };
  }
  // Falling out of the loop means EOF arrived with the quote still open, so
  // this field absorbed every remaining row. Returning silently would hand the
  // caller a short, all-valid row set and hide the corrupt rows entirely.
  throw new Error(
    `unterminated quoted field starting at offset ${start}: the manifest is malformed`
  );
}

/** Parse an unquoted CSV field starting at the current position. */
function parseUnquotedField(
  text: string,
  start: number
): { field: string; next: number } {
  let i = start;
  let field = "";
  while (
    i < text.length &&
    text[i] !== "," &&
    text[i] !== "\n" &&
    text[i] !== "\r"
  ) {
    field += text[i];
    i++;
  }
  return { field, next: i };
}

const UNTERMINATED_QUOTED_FIELD = /unterminated quoted field/;

function findLayeredManifestImportabilityIssues(
  csv: string,
  nullNormalizedDossierIds: ReadonlySet<string>
): string[] {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0];
  const idIdx = header.indexOf("id");
  const layerIdx = header.indexOf("layer");
  const sessionsIdx = header.indexOf("sessions");
  const missingColumns = [
    ["id", idIdx],
    ["layer", layerIdx],
    ["sessions", sessionsIdx],
  ].filter((entry) => entry[1] === -1);
  if (missingColumns.length > 0) {
    return missingColumns.map(
      ([column]) => `test-cases.csv: no "${column}" column in header row`
    );
  }

  const issues: string[] = [];
  for (const row of rows.slice(1)) {
    const layer = Number(row[layerIdx]);
    if (layer !== 2 && layer !== 3 && layer !== 4) {
      continue;
    }
    const sessionIds = [
      ...(row[sessionsIdx] ?? "").matchAll(SESSION_ID_TOKEN),
    ].map((match) => match[0]);
    if (sessionIds.length === 0) {
      continue;
    }
    if (sessionIds.every((id) => nullNormalizedDossierIds.has(id))) {
      issues.push(
        `${row[idIdx]}: layer ${layer} coverage cites only null-normalized dossiers, so it contributes no store rows`
      );
    }
  }
  return issues;
}

/**
 * Every session id the coverage manifests cite, tokenized once so the real
 * reconciliation and the synthetic-fixture test above read the same rules.
 *
 * ISS-8561 (whitlockk review): read the `sessions` CELL, never the raw file text.
 * Both manifests carry free prose — `test-cases.csv`'s `test_case`,
 * `collection-matrix.csv`'s `notes` — and a scan over the whole file counts an
 * id MENTIONED in a note as a citation. That is the wrong direction on both
 * halves of the reconciliation: a dossier named only in prose reads as cited
 * and clears the uncited guard with no coverage cell behind it, and an id left
 * in a note after its row was removed keeps a deleted dossier looking present.
 *
 * A manifest with no `sessions` column at all is a FINDING, not an empty
 * citation set — silently returning nothing would report every dossier as
 * uncited, or (worse, if both files lost it) reconcile a corpus against no
 * citations at all.
 */
function collectCitedSessionIds(
  manifestContents: ReadonlyMap<string, string>
): { cited: ReadonlySet<string>; issues: string[] } {
  const cited = new Set<string>();
  const issues: string[] = [];
  for (const [name, content] of manifestContents) {
    const rows = parseCsvRows(content);
    if (rows.length === 0) {
      continue;
    }
    const sessionsIdx = rows[0].indexOf("sessions");
    if (sessionsIdx === -1) {
      issues.push(`${name}: no "sessions" column in header row`);
      continue;
    }
    for (const row of rows.slice(1)) {
      for (const m of (row[sessionsIdx] ?? "").matchAll(SESSION_ID_TOKEN)) {
        cited.add(m[0]);
      }
    }
  }
  return { cited, issues };
}

/**
 * ISS-8561 (davetho review): the WHOLE dossier↔manifest reconciliation, as
 * one function over its inputs.
 *
 * The registered test above used to inline it, so the only thing a synthetic
 * fixture could reach was `findUncitedDossiers` — and the mutation that guard
 * exists to catch is a `normalized !== null` filter creeping back in at the
 * CALL SITE, which no fixture touched. Every assertion the real corpus is held
 * to now runs here, so the fixture case drives the same code the corpus does
 * and re-adding that filter anywhere on this path turns it red.
 */
function reconcileCoverageManifests(
  dossiers: readonly Pick<GoldenDossier, "sessionId" | "normalized">[],
  manifestContents: ReadonlyMap<string, string>
): string[] {
  const dossierIds = new Set(dossiers.map((d) => d.sessionId));
  const nullNormalizedDossierIds = new Set(
    dossiers.filter((d) => d.normalized === null).map((d) => d.sessionId)
  );
  const { cited, issues } = collectCitedSessionIds(manifestContents);
  for (const id of cited) {
    if (!dossierIds.has(id)) {
      issues.push(
        `coverage CSVs cite session ${id} but no dossier directory exists — coverage silently shrank`
      );
    }
  }
  issues.push(...findUncitedDossiers(dossiers, cited));
  const testCasesCsv = manifestContents.get(TEST_CASES_CSV);
  if (testCasesCsv !== undefined) {
    issues.push(
      ...findLayeredManifestImportabilityIssues(
        testCasesCsv,
        nullNormalizedDossierIds
      )
    );
  }
  return issues;
}

/**
 * ISS-8561: EVERY dossier owes a manifest citation, including a null-normalized
 * DROP one. A DROP dossier still legitimately evidences Layer 1 (its raw shape
 * and the collector's refusal), so it has a row it can be cited from; what it
 * cannot do is stay invisible.
 *
 * It takes the DOSSIERS rather than their ids so that `normalized` is in scope
 * here: the mutation this guard exists to prevent is a `normalized !== null`
 * filter creeping back in, and a helper handed bare ids would leave that filter
 * at a call site no fixture can reach — the test would stay green under exactly
 * the change it was written to catch.
 */
function findUncitedDossiers(
  dossiers: readonly Pick<GoldenDossier, "sessionId" | "normalized">[],
  cited: ReadonlySet<string>
): string[] {
  return dossiers
    .filter((d) => !cited.has(d.sessionId))
    .map(
      (d) =>
        `dossier ${d.sessionId} is cited by no coverage-CSV row — annotate the manifests or remove the dossier`
    );
}

const TEST_CASES_CSV = "test-cases.csv";
const MANIFEST_CSV_NAMES = [TEST_CASES_CSV, "collection-matrix.csv"] as const;
const UNCITED_DOSSIER = /is cited by no coverage-CSV row/;
const CITED_WITHOUT_DOSSIER = /but no dossier directory exists/;
const MISSING_SESSIONS_COLUMN = /no "sessions" column in header row/;
const NULL_NORMALIZED_FIXTURE_SESSION_ID = "ses_0ffde2471ffe6DynttjfK0Yp3H";
const IMPORTABLE_FIXTURE_SESSION_ID = "7da87bc7-83f6-7bef-8524-edfc58585a4f";
const OPENCODE_FIXTURE_SESSION_ID = "opencode-ses_fa6832d22ffeP9RQlLpkf7UK4e";
const MISSING_TEST_CASES_COLUMN =
  /test-cases.csv: no "(id|layer|sessions)" column in header row/;
const NULL_NORMALIZED_TC075_LAYER =
  /TC-075: layer (2|3|4) coverage cites only null-normalized dossiers/;
