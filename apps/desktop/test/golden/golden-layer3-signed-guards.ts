/**
 * Layer 3 group 0 — the signed-file guards, split out of golden-layer3.ts
 * (grandfathered file-size ceiling) so the runner keeps the aggregate suites
 * and this module owns the checks that compare the SIGNED corpus file against
 * the corpus it claims to describe.
 *
 * These are the mechanical defenses packages/golden-sessions/AGENTS.md calls
 * for: re-derive the artifact on the merged tree and assert the fields that
 * move. A key asserted nowhere is a key free to drift (ISS-4702).
 *
 * Failures are collected and thrown (not node:assert) because this helper runs
 * outside a test body — the same noMisplacedAssertion contract golden-layer3-
 * facts.ts follows. Collecting also reports every drifted guard at once
 * instead of stopping at the first.
 */
import { isDeepStrictEqual } from "node:util";
import { CorpusExpectationsStatus } from "./corpus-expectations-file.js";
import type { CorpusYaml } from "./golden-layer3-corpus-schema.js";
import { countBy, type L3Rows, loadCorpus } from "./golden-layer3-derive.js";
import { assertNoFailures } from "./golden-layer3-facts.js";

const RESIGN_HINT =
  " — the corpus changed; re-derive with derive-corpus-expectations.ts and re-sign per packages/golden-sessions/AGENTS.md";

function expect(
  failures: string[],
  key: string,
  actual: unknown,
  expected: unknown,
  detail: string
): void {
  if (isDeepStrictEqual(actual, expected)) {
    return;
  }
  failures.push(
    `${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} — ${detail}`
  );
}

/** Assert the signed corpus file still describes the corpus it was signed for. */
export function assertSignedCorpusGuards(ctx: {
  yaml: CorpusYaml;
  refIso: string;
  rows: L3Rows;
}): void {
  const { yaml, refIso, rows } = ctx;
  const failures: string[] = [];
  expect(
    failures,
    "schema_version",
    yaml.schema_version,
    2,
    "corpus-expectations schema_version"
  );
  expect(
    failures,
    "status",
    yaml.status,
    CorpusExpectationsStatus.Signed,
    "corpus-expectations must be SIGNED (see packages/golden-sessions/AGENTS.md) before the Layer 3 CI suite can pass"
  );
  expect(
    failures,
    "reference_now",
    yaml.reference_now,
    refIso,
    "corpus-expectations reference_now does not equal the recomputed corpus clock (max ISO timestamp in the import inputs + 1h)" +
      RESIGN_HINT
  );
  expect(
    failures,
    "corpus.sessions_imported",
    yaml.corpus.sessions_imported,
    rows.sessions.length,
    "corpus-expectations sessions_imported does not equal the seeded store's session count" +
      RESIGN_HINT
  );
  expect(
    failures,
    "corpus.dossiers_total",
    yaml.corpus.dossiers_total,
    loadCorpus().dossiersTotal,
    "corpus-expectations dossiers_total does not equal the discovered dossier count" +
      RESIGN_HINT
  );
  // ISS-4702: nothing asserted this key, so the signed file drifted from its
  // own producer undetected (it still read the legacy `completed` vocabulary
  // ISS-4654 retired). Same derivation the producer uses — session rows counted
  // by store status.
  expect(
    failures,
    "corpus.sessions_by_status_store",
    yaml.corpus.sessions_by_status_store,
    Object.fromEntries(countBy(rows.sessions, (s) => s.status)),
    "corpus-expectations sessions_by_status_store does not equal the seeded store's session-status tally — " +
      "either the collector's status vocabulary moved (fix the collector) or the oracle is stale; amend it " +
      "under a ticket per packages/golden-sessions/AGENTS.md, never to green this test"
  );
  assertNoFailures(failures, "golden layer3: signed-file guards");
}
