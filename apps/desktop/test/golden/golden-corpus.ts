/**
 * FEA-2646 Layer 1 golden runner — shared harness.
 *
 * Discovers every dossier under packages/golden-sessions/<session-id>/, runs the
 * harness-appropriate PRODUCTION parse path over a temp copy of raw/, and asserts:
 *   1. parse(raw) deep-equals the frozen normalized.json (the Layer 1 contract),
 *   2. the Layer-1-mappable facts in the human-owned expectations.yaml, and
 *   3. per-child subagent attribution (model + token fields per attributed child).
 *
 * Production fidelity: claude subagent folding happens inside parseSessionFile;
 * codex descendant folding uses the SAME foldCodexDescendants the collector
 * invokes (codex-collector.ts) — the runner never re-implements folding math.
 *
 * Failure messages cite dossier keys ("<sid>: turns.user expected 5, got 6") so a
 * red test names the golden fact and the file holding the evidence.
 *
 * Honors packages/golden-sessions/AGENTS.md: this harness is strictly READ-ONLY
 * over the corpus — every parse runs against a temp-dir copy of raw/ (the
 * opencode SQLite handle would otherwise be write-capable in place), and the
 * suite never writes, regenerates, or "fixes" fixtures. Known collector-side
 * divergences live in golden-divergences.ts, keyed to a ticket, with a
 * three-way self-guard: an entry that stops reproducing fails (promote the key),
 * a parser that drifts to a third value fails (new regression), and an entry
 * that is never exercised fails (stale key / silently changed dossier).
 *
 * Hermeticity: results are independent of machine TZ (see the paired UTC /
 * America/Chicago test files), of filesystem enumeration order (dossiers,
 * rollouts, and claude subagent files are all sorted), and of capture-machine
 * state (fileModifiedAt — an mtime, not a semantic fact — is normalized to null
 * on both sides). Coverage cannot silently shrink: the manifest-reconciliation
 * test fails if a dossier cited by the coverage CSVs disappears, or a dossier
 * exists that no CSV row cites.
 *
 * ISS-4499: the expectations types + fact machinery (builders, checkFact,
 * required-facts policy, new-block Zod validation) live in the sibling
 * golden-layer1-facts.ts; this module keeps discovery/parse/normalize/
 * registration and re-exports DossierExpectations for existing importers.
 */
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { parseSessionFile } from "../../src/main/collectors/claude/claude-parser.js";
import { foldCodexDescendants } from "../../src/main/collectors/codex/codex-collector.js";
import { parseRolloutFile } from "../../src/main/collectors/codex/codex-parser.js";
import {
  classifyRawFiles,
  listDossierRawDirs,
} from "../../src/main/collectors/golden/corpus-layout.js";
import { loadSessionsFromDb } from "../../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../../src/main/collectors/types.js";
import { KNOWN_DIVERGENCES } from "./golden-divergences.js";
import {
  cacheWriteTtlFacts,
  captureLayer1Extras,
  checkFact,
  type DossierExpectations,
  getFiredDivergences,
  LAYER1_FACTS,
  missingRequiredFacts,
  PARSE_QUALITY_FACTS,
  type ParsedSessionView,
  SESSION_CLASSIFICATION_FACTS,
  subagentFacts,
  tokenFacts,
  toolResultFacts,
  USAGE_EXTRAS_FACTS,
  validateNewExpectationBlocks,
} from "./golden-layer1-facts.js";

// Re-exported so existing importers (golden-layer2.ts,
// regen-golden-sync-payloads.ts) keep resolving the type from this module
// after the ISS-4499 split.
export type { DossierExpectations } from "./golden-layer1-facts.js";

const CORPUS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/golden-sessions"
);
// The platform renamed FEA → ISS; both prefixes are valid ticket citations.
const TICKET_ID = /^(FEA|ISS)-\d+$/;
// Session ids as they appear in the coverage CSVs: UUIDs plus opencode ses_* ids.
const SESSION_ID_TOKEN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[A-Za-z0-9]+/g;

export type GoldenDossier = {
  sessionId: string;
  dir: string;
  rawDir: string;
  /** Parsed normalized.json — null means "the collector emits no session for this raw input" */
  normalized: Record<string, unknown> | null;
  expectations: DossierExpectations;
};

export function discoverDossiers(): GoldenDossier[] {
  const dossiers: GoldenDossier[] = [];
  // Enumeration + the non-dossier/dot-dir skip discipline live in the shared
  // corpus-layout SSOT (also consumed by golden mode); the oracle-file reads
  // below stay here.
  for (const { sessionId, dir, rawDir } of listDossierRawDirs(CORPUS_DIR)) {
    const normalizedPath = join(dir, "normalized.json");
    const expectationsPath = join(dir, "expectations.yaml");
    // A directory under the corpus IS a dossier; incomplete ones must fail, not
    // silently skip — an unnoticed skip would hollow out the suite.
    dossiers.push({
      sessionId,
      dir,
      rawDir,
      normalized: existsSync(normalizedPath)
        ? JSON.parse(readFileSync(normalizedPath, "utf8"))
        : (undefined as never),
      expectations: existsSync(expectationsPath)
        ? (parseYaml(
            readFileSync(expectationsPath, "utf8")
          ) as DossierExpectations)
        : (undefined as never),
    });
  }
  return dossiers;
}

/**
 * Parse a dossier through the harness-appropriate PRODUCTION path, against a
 * temp copy of raw/ (never in place — see header).
 */
export async function parseDossierRaw(
  d: GoldenDossier
): Promise<NormalizedSession | null> {
  const tempDir = mkdtempSync(join(tmpdir(), "golden-raw-"));
  try {
    cpSync(d.rawDir, tempDir, { recursive: true });
    // Raw-file → harness classification is the shared corpus-layout SSOT (also
    // consumed by golden mode); the parse/fold below stays here.
    const classification = classifyRawFiles(readdirSync(tempDir), d.sessionId);

    if (classification.kind === "opencode") {
      const all = loadSessionsFromDb(join(tempDir, classification.dbFile));
      return all.find((s) => s.sessionId === d.sessionId) ?? null;
    }

    if (classification.kind === "codex") {
      const session = await parseRolloutFile(
        join(tempDir, classification.parent)
      );
      if (session) {
        // Production descendant fold (codex-collector.ts) — same function,
        // same math; sources sorted for deterministic subagent order.
        await foldCodexDescendants(
          session,
          join(tempDir, classification.parent),
          classification.rollouts.map((f) => join(tempDir, f)).sort()
        );
      }
      return session;
    }

    return await parseSessionFile(join(tempDir, classification.main));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * For a null-normalized dossier the collector must emit nothing — but the raw
 * evidence for WHY must hold, or the dossier could claim anything. For the
 * opencode empty-session contract: the session row exists, with zero messages.
 */
function opencodeDropPreconditions(d: GoldenDossier): string[] {
  // Even a readOnly open of a WAL-mode SQLite db creates -wal/-shm sidecars
  // next to the file — so this too must run against a temp copy, never the
  // frozen corpus bytes.
  const tempDir = mkdtempSync(join(tmpdir(), "golden-precond-"));
  try {
    cpSync(d.rawDir, tempDir, { recursive: true });
    return opencodeDropPreconditionsIn(tempDir, d.sessionId);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function opencodeDropPreconditionsIn(
  rawDir: string,
  sessionId: string
): string[] {
  const dbFile = readdirSync(rawDir)
    .sort()
    .find((f) => f.endsWith(".db"));
  if (!dbFile) {
    return [`${sessionId}: null normalized.json but no .db in raw/`];
  }
  const problems: string[] = [];
  const db = new DatabaseSync(join(rawDir, dbFile), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT id FROM session WHERE id = ?")
      .get(sessionId);
    if (!row) {
      problems.push(
        `${sessionId}: session row missing from raw db — the drop contract has no evidence`
      );
    }
    const msg = db
      .prepare("SELECT count(*) AS n FROM message WHERE session_id = ?")
      .get(sessionId) as { n: number } | undefined;
    if ((msg?.n ?? -1) !== 0) {
      problems.push(
        `${sessionId}: expected 0 message rows (empty-session drop contract), got ${msg?.n}`
      );
    }
  } finally {
    db.close();
  }
  return problems;
}

/** JSON round-trip + strip capture-machine noise so deep-equal is hermetic. */
// Exported for the FEA-3419 amendment-proposal tooling (agent-generated,
// human-applied): a proposal must be the SAME projection the Layer-1 deep-equal
// compares, so the compare semantics and the amendment generator can never
// drift apart.
export function jsonNormalize(
  session: NormalizedSession | null
): Record<string, unknown> | null {
  if (session === null) {
    return null;
  }
  // FEA-3525: `modelContextWindow` is an additive Codex-parser field captured
  // AFTER these dossiers' `normalized.json` oracles were frozen (their raw
  // rollouts carry `model_context_window`, but the frozen oracles predate
  // the field). Strip it from the Layer-1 deep-equal — same pattern as FEA-3128
  // `prLinks` below — so the frozen oracles round-trip UNCHANGED rather than
  // forcing an oracle amendment. Its capture is covered by the
  // parse-codex + worker-protocol unit tests instead.
  const {
    prLinks: _prLinks,
    // FEA-3526: `codexLastTokenUsage` is an additive metadata field that
    // postdates the frozen normalized.json oracles (which must not be
    // regenerated). Strip it before the Layer 1 deep-equal, exactly
    // as `prLinks` is, so the additive Codex per-turn snapshot round-trips
    // without a coincidental oracle mismatch. The field's own correctness is
    // covered by the parser unit tests + worker-protocol round-trip tests.
    codexLastTokenUsage: _codexLastTokenUsage,
    modelContextWindow: _modelContextWindow,
    // FEA-3524: additive Codex rate_limits capture the frozen normalized.json
    // predates. Stripped before the Layer 1 deep-equal (like prLinks) so a Codex
    // dossier carrying a populated block round-trips against a frozen oracle
    // that does not model the field; asserted separately in FEA-3524's unit tests.
    codexRateLimits: _codexRateLimits,
    // FEA-3715: the static Codex protocol pin is emitted on every Codex session
    // but postdates these frozen oracles. Strip it before the Layer 1
    // deep-equal — exactly as codexRateLimits is — so the frozen oracles
    // round-trip UNCHANGED; the pin's presence/shape is asserted directly by the
    // parse-codex + protocol-inventory unit tests.
    codexProtocolSupport: _codexProtocolSupport,
    // FEA-4093: the Claude parser now emits first-class `hooks` firings from
    // `attachment` (hook_success/hook_error) records — every Claude session
    // carries `hooks: []` (or a populated list where hooks fired) where the
    // frozen oracles predate the field and omit the key entirely.
    // Strip it before the Layer 1 deep-equal — exactly as prLinks is — so the
    // oracles round-trip UNCHANGED without a regeneration. Hook-capture
    // correctness is asserted directly by the parse-claude-hooks unit tests
    // (packages/lib/harness/claude/parse-claude-hooks.test.ts).
    hooks: _hooks,
    ...plain
  } = JSON.parse(JSON.stringify(session)) as Record<string, unknown> & {
    prLinks?: unknown;
    codexLastTokenUsage?: unknown;
    modelContextWindow?: unknown;
    codexRateLimits?: unknown;
    codexProtocolSupport?: unknown;
    hooks?: unknown;
  };
  plain.fileModifiedAt = null;
  // ISS-4884: transcript-entry source identity is additive evidence the frozen
  // normalized oracles predate. Keep the corpus immutable and strip only this
  // new field from Layer 1 comparison; focused adapter, boot/live parity, cache,
  // and persistence tests assert the populated evidence and replay behavior.
  stripTokenSourceIdentity(plain);
  // FEA-3527: `usageExtras.reasoning_output_tokens` is an ADDITIVE metadata
  // subdivision that the frozen normalized.json oracles predate (they carry only
  // service_tiers/speeds/inference_geos). Strip it here — exactly as prLinks is
  // stripped above — so the frozen oracles round-trip unchanged; the field
  // is a non-additive subset of the already-asserted output total, so removing
  // it from the deep-equal loses no Layer-1 token fact. Asserted directly by the
  // Codex parser unit tests in packages/lib/harness/codex/parse-codex.test.ts.
  //
  // PRD-538: `usageExtras.web_search_requests` is likewise an ADDITIVE field the
  // frozen oracles predate. Every corpus dossier used no web search (the raw
  // transcripts carry `server_tool_use.web_search_requests: 0`), so the parser
  // emits 0 and stripping it is lossless against the oracles — no oracle
  // amendment required. Its capture + per-request cost pricing are asserted by
  // the parse-claude unit tests and the write-core "web-search cost is added
  // once" integration test.
  //
  // ISS-4499: both stripped fields are now ALSO asserted as Layer-1 facts via
  // the pre-normalize capture in the dossier test below (usage_extras block in
  // expectations.yaml) — the strip here keeps the frozen normalized.json
  // deep-equal unchanged while the oracle assertion happens on the captured
  // values.
  if (plain.usageExtras && typeof plain.usageExtras === "object") {
    const {
      reasoning_output_tokens: _reasoning,
      web_search_requests: _webSearchRequests,
      ...usageExtrasRest
    } = plain.usageExtras as Record<string, unknown>;
    plain.usageExtras = usageExtrasRest;
  }
  // FEA-3419: `cacheWriteTtl` (tokensByModel + tokenSeries, main and subagent)
  // is deliberately NOT stripped here, unlike the additive precedents above:
  // Layer 2 imports the FROZEN normalized.json, so an oracle without the typed
  // split would import with absent provenance and pin FIVE-MINUTE-only prices
  // for the corpus's genuine 1-hour sessions — institutionalizing the exact
  // undercount FEA-3419 fixes. The split is a hard Layer-1 token fact; the
  // frozen oracles gain it (and lose the retired
  // `usageExtras.cache_creation` blob) via the FEA-3419 amendments.
  // FEA-3553: the Claude parser now emits `plans` (ExitPlanMode input + inline
  // prose), so every Claude session carries `plans: []` where the frozen
  // Claude oracles predate the field and omit the key entirely. An EMPTY plans
  // array is a no-op — drop it (parse side) so those frozen oracles
  // round-trip UNCHANGED, exactly as prLinks/codexRateLimits are stripped above.
  // The oracle projection at the assertion site drops an empty `plans` too, so
  // the Codex oracles that DO carry `plans: []` still match. A POPULATED plans
  // array is preserved on both sides and remains a hard Layer-1 fact — so a real
  // captured plan can never be silently dropped from the deep-equal.
  if (Array.isArray(plain.plans) && plain.plans.length === 0) {
    const { plans: _emptyPlans, ...withoutPlans } = plain;
    return withoutPlans;
  }
  return plain;
}

/**
 * FEA-3553: mirror `jsonNormalize`'s empty-`plans` drop on the ORACLE side so
 * the Layer-1 deep-equal treats "no plans key" (frozen Claude oracle) and
 * "plans: []" (frozen Codex oracle) as equivalent, without editing either
 * frozen file. A non-empty oracle `plans` is passed through untouched.
 */
function projectOracle(
  normalized: Record<string, unknown>
): Record<string, unknown> {
  const oracle: Record<string, unknown> = {
    ...normalized,
    fileModifiedAt: null,
  };
  if (Array.isArray(oracle.plans) && oracle.plans.length === 0) {
    const { plans: _emptyPlans, ...withoutPlans } = oracle;
    return withoutPlans;
  }
  return oracle;
}

function stripTokenSourceIdentity(session: Record<string, unknown>): void {
  stripTokenSeriesSourceIdentity(session.tokenSeries);
  if (!Array.isArray(session.subagents)) {
    return;
  }
  for (const subagent of session.subagents) {
    if (subagent && typeof subagent === "object") {
      stripTokenSeriesSourceIdentity(
        (subagent as Record<string, unknown>).tokenSeries
      );
    }
  }
}

function stripTokenSeriesSourceIdentity(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const record of value) {
    if (record && typeof record === "object") {
      Reflect.deleteProperty(record, "sourceIdentity");
    }
  }
}

/** First differing path between two JSON values — for citable deep-equal failures. */
function firstDiffPath(a: unknown, b: unknown, path = "$"): string | null {
  if (isDeepStrictEqual(a, b)) {
    return null;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return `${path}: expected ${JSON.stringify(b)?.slice(0, 120)}, got ${JSON.stringify(a)?.slice(0, 120)}`;
  }
  const keys = new Set([
    ...Object.keys(a as object),
    ...Object.keys(b as object),
  ]);
  for (const k of [...keys].sort()) {
    const sub = firstDiffPath(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}.${k}`
    );
    if (sub) {
      return sub;
    }
  }
  return `${path}: (values differ)`;
}

/** Register the full Layer 1 suite under the current process TZ. */
export function registerGoldenLayer1Suite(): void {
  const dossiers = discoverDossiers();
  const dossierIds = new Set(dossiers.map((d) => d.sessionId));

  test("golden corpus discovered and complete", () => {
    for (const d of dossiers) {
      assert.ok(
        d.normalized !== (undefined as never),
        `${d.sessionId}: missing normalized.json — incomplete dossier must not merge`
      );
      assert.ok(
        d.expectations !== (undefined as never),
        `${d.sessionId}: missing expectations.yaml — incomplete dossier must not merge`
      );
      assert.ok(
        existsSync(d.rawDir),
        `${d.sessionId}: missing raw/ — incomplete dossier must not merge`
      );
      // ISS-4499: strict validation of the new oracle blocks — a typo'd or
      // unknown nested key fails loudly instead of silently disabling the
      // assertion it was meant to feed.
      const schemaIssues = validateNewExpectationBlocks(d.expectations ?? {});
      assert.ok(
        schemaIssues.length === 0,
        `${d.sessionId}: expectations.yaml new-block schema violations:\n  - ${schemaIssues.join("\n  - ")}`
      );
      const missing = missingRequiredFacts(d.expectations ?? {}, {
        hasNormalized: d.normalized != null,
        harness: d.expectations?.harness,
      });
      assert.ok(
        missing.length === 0,
        `${d.sessionId}: expectations.yaml missing required facts: ${missing.join(", ")}`
      );
    }
  });

  test("coverage manifests reconcile with the corpus", () => {
    if (dossiers.length === 0) {
      return; // pre-corpus no-op
    }
    const cited = new Set<string>();
    for (const csv of ["test-cases.csv", "collection-matrix.csv"]) {
      const p = join(CORPUS_DIR, csv);
      if (!existsSync(p)) {
        continue;
      }
      for (const m of readFileSync(p, "utf8").matchAll(SESSION_ID_TOKEN)) {
        cited.add(m[0]);
      }
    }
    for (const id of cited) {
      assert.ok(
        dossierIds.has(id),
        `coverage CSVs cite session ${id} but no dossier directory exists — coverage silently shrank`
      );
    }
    for (const d of dossiers) {
      assert.ok(
        cited.has(d.sessionId),
        `dossier ${d.sessionId} is cited by no coverage-CSV row — annotate the manifests or remove the dossier`
      );
    }
  });

  test("known-divergence registry is well-formed", () => {
    const seen = new Set<string>();
    for (const d of KNOWN_DIVERGENCES) {
      assert.match(
        d.ticket,
        TICKET_ID,
        `divergence ${d.sessionId}:${d.key} must cite a FEA/ISS ticket`
      );
      const dup = `${d.sessionId} ${d.key}`;
      assert.ok(
        !seen.has(dup),
        `duplicate divergence entry ${d.sessionId}:${d.key}`
      );
      seen.add(dup);
    }
  });

  for (const d of dossiers) {
    test(`golden ${d.sessionId}: parse(raw) matches dossier`, async () => {
      assert.ok(
        d.normalized !== (undefined as never) &&
          d.expectations !== (undefined as never),
        `${d.sessionId}: incomplete dossier (missing normalized.json or expectations.yaml)`
      );
      const rawParsed = await parseDossierRaw(d);
      // FEA-3128/ISS-4499: capture prLinks, the jsonNormalize-stripped
      // usageExtras fields, and the worker-parity failed-run signal BEFORE
      // normalization (the capture semantics live in the facts module).
      const extras = captureLayer1Extras(rawParsed);
      const parsed = jsonNormalize(rawParsed);

      if (d.normalized === null) {
        assert.equal(
          parsed,
          null,
          `${d.sessionId}: normalized.json is null (collector is expected to emit no session) but the parser produced one`
        );
        const preconditions = opencodeDropPreconditions(d);
        assert.ok(
          preconditions.length === 0,
          `${d.sessionId}: drop-contract raw evidence failed:\n  - ${preconditions.join("\n  - ")}`
        );
        return;
      }
      assert.ok(
        parsed !== null,
        `${d.sessionId}: parser produced no session but normalized.json expects one`
      );

      // 1. The Layer 1 contract: parse(raw) deep-equals the frozen normalized.json.
      // fileModifiedAt is a capture-time mtime, not a semantic fact — nulled on
      // BOTH sides (a dossier may freeze a real mtime; c8dcfab8 does).
      const oracle = projectOracle(d.normalized);
      if (!isDeepStrictEqual(parsed, oracle)) {
        const diff = firstDiffPath(parsed, oracle);
        assert.fail(
          `${d.sessionId}: parse(raw) does not deep-equal normalized.json — first divergence at ${diff} ` +
            `(oracle: packages/golden-sessions/${d.sessionId}/normalized.json)`
        );
      }

      // 2. The human-signed facts (expectations.yaml), key by key. ALL facts are
      // checked before failing so one divergence can't mask another.
      const parsedView = {
        ...(parsed as ParsedSessionView),
        ...extras,
      };
      const diagnostics: string[] = [];
      const failures: string[] = [];
      const facts = [
        ...LAYER1_FACTS,
        ...SESSION_CLASSIFICATION_FACTS,
        ...toolResultFacts(d.expectations),
        ...PARSE_QUALITY_FACTS,
        ...cacheWriteTtlFacts(d.expectations),
        ...USAGE_EXTRAS_FACTS,
        ...tokenFacts(d.expectations),
        ...subagentFacts(d.expectations),
      ];
      for (const fact of facts) {
        checkFact(
          d.sessionId,
          fact,
          d.expectations,
          parsedView,
          diagnostics,
          failures
        );
      }
      for (const line of diagnostics) {
        // Surfaced in the runner output so expected-fails stay visible.
        console.log(`  [known-divergence] ${line}`);
      }
      assert.ok(
        failures.length === 0,
        `${d.sessionId}: ${failures.length} dossier fact(s) diverged:\n  - ${failures.join("\n  - ")}`
      );
    });
  }

  // Registered LAST: node:test runs top-level tests in registration order, so
  // every dossier test above has completed by the time this sweep runs.
  test("every registered divergence for a present dossier was exercised", () => {
    const fired = getFiredDivergences();
    for (const entry of KNOWN_DIVERGENCES) {
      if (!dossierIds.has(entry.sessionId)) {
        continue; // inert pre-seeded entry for a dossier arriving via another PR
      }
      assert.ok(
        fired.has(`${entry.sessionId} ${entry.key}`),
        `divergence ${entry.sessionId}:${entry.key} (${entry.ticket}) never fired — ` +
          "stale key path or the dossier stopped asserting it; remove or fix the entry"
      );
    }
  });
}
