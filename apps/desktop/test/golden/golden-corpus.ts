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
 * on both sides; fileCreatedAt, a birth time, is dropped from both).
 *
 * ISS-4499: the expectations types + fact machinery (builders, checkFact,
 * required-facts policy, new-block Zod validation) live in the sibling
 * golden-layer1-facts.ts; this module keeps discovery/parse/normalize/
 * registration and re-exports DossierExpectations for existing importers.
 *
 * ISS-7841: the coverage-manifest tests (reconciliation, rung validity, the
 * CSV parser, and the Layer 2/3/4 importability rule) live in the sibling
 * golden-manifest.ts, registered from this module's Layer 1 suite.
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
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseSessionFile } from "../../src/main/collectors/claude/claude-parser.js";
import { foldCodexDescendants } from "../../src/main/collectors/codex/codex-collector.js";
import { parseRolloutFile } from "../../src/main/collectors/codex/codex-parser.js";
import {
  assertExhaustiveClassification,
  classifyRawFiles,
  findSqliteSidecars,
  listDossierRawDirs,
} from "../../src/main/collectors/golden/corpus-layout.js";
import { loadSessionsFromDb } from "../../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../../src/main/collectors/types.js";
import { effectiveParsePolicy } from "../../src/main/parse-policy/effective-parse-policy.js";
import {
  attributionLayer1Failures,
  heldOutDossierIds,
} from "./golden-attribution-layer1.js";
import { KNOWN_DIVERGENCES } from "./golden-divergences.js";
// ISS-12552: evaluated for its side effect, the attribution policy default.
import "./golden-parse-policy.js";
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
import { registerCoverageManifestTests } from "./golden-manifest.js";

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

    if (classification.kind === "claude") {
      return await parseSessionFile(join(tempDir, classification.main));
    }

    // ISS-7504: a fourth union member fails tsc here AND throws at runtime —
    // an unrecognised dossier must be rejected, not silently parsed as Claude.
    assertExhaustiveClassification(classification);
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
  session: NormalizedSession | null,
  options: { keepAttributionEvidence?: boolean } = {}
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
    // ISS-7259: the normalized launch-attribution facet. 33 non-subagent dossier
    // transcripts carry the source fields (799 `attributionSkill`, 139
    // `promptSource`, 13 Codex `thread_source`, 7 `agent_role`), so the parser
    // now emits a facet these frozen oracles predate and do not model. Strip it
    // before the Layer 1 deep-equal — exactly as codexRateLimits is — so the
    // oracles round-trip UNCHANGED and no `packages/golden-sessions/` write is
    // required. Capture correctness is asserted directly by the parse-claude and
    // parse-codex unit tests in packages/lib/harness, and its survival across the
    // worker boundary by the historical-parse-worker protocol tests.
    harnessLaunchAttribution: _harnessLaunchAttribution,
    // ISS-12251: a capture-time birth time, like fileModifiedAt below; the
    // frozen oracles predate it.
    fileCreatedAt: _fileCreatedAt,
    // ISS-12552: Codex code-mode MCP calls, kept outside `toolUses`. Stripped
    // like the tool result evidence below unless the oracle carries it.
    mcpCallEvidence,
    ...plain
  } = JSON.parse(JSON.stringify(session)) as Record<string, unknown> & {
    prLinks?: unknown;
    codexLastTokenUsage?: unknown;
    modelContextWindow?: unknown;
    codexRateLimits?: unknown;
    codexProtocolSupport?: unknown;
    hooks?: unknown;
    harnessLaunchAttribution?: unknown;
    fileCreatedAt?: unknown;
    mcpCallEvidence?: unknown;
  };
  plain.fileModifiedAt = null;
  // ISS-4884: transcript-entry source identity is additive evidence the frozen
  // normalized oracles predate. Keep the corpus immutable and strip only this
  // new field from Layer 1 comparison; focused adapter, boot/live parity, cache,
  // and persistence tests assert the populated evidence and replay behavior.
  stripTokenSourceIdentity(plain);
  // ISS-7795: per-invocation measured token usage on `skills[]` and
  // `slashCommands[]`. The parser now folds `message.usage` onto the entry the
  // harness stamped with `attributionSkill`, and the frozen oracles predate the
  // field entirely. Strip it before the Layer 1 deep-equal — exactly as
  // `harnessLaunchAttribution` is — so the oracles round-trip UNCHANGED and no
  // `packages/golden-sessions/` write is required. Attribution correctness is
  // asserted directly by component-usage-attribution.test.ts in
  // packages/lib/harness, its persistence by the desktop round-trip test, and
  // its survival across the worker boundary by the historical-parse-worker
  // protocol tests.
  stripComponentUsage(plain);
  // ISS-12552: tool result facts read before the output cap,
  // the request a call came from (PRD-800, asserted by
  // parse-claude-request-key.test.ts and subagent-scanner-request-key.test.ts),
  // plus the namespace and call id a Codex namespaced MCP call now carries, are
  // additive parse output the frozen oracles predate. Strip them before the
  // Layer 1 deep-equal, exactly as component usage is, so the oracles
  // round-trip UNCHANGED and no `packages/golden-sessions/` write is required.
  // Capture is asserted by tool-result-facts.test.ts and
  // parse-codex.mcp-tool-call.test.ts in packages/lib/harness, the sidecar lane
  // by claude-sidecar-result-facts.test.ts, and worker-boundary survival by
  // the historical-parse-worker tests.
  if (options.keepAttributionEvidence) {
    if (mcpCallEvidence !== undefined) {
      plain.mcpCallEvidence = mcpCallEvidence;
    }
  } else {
    stripToolResultEvidence(plain);
  }
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
// Exported for the ISS-10736 amendment-proposal tooling, for the same reason
// `jsonNormalize` above is: a proposal must be built against the SAME oracle
// projection the Layer-1 deep-equal compares, or the compare semantics and the
// amendment generator drift apart silently.
export function projectOracle(
  normalized: Record<string, unknown>
): Record<string, unknown> {
  const { fileCreatedAt: _fileCreatedAt, ...withoutBirthTime } = normalized;
  const oracle: Record<string, unknown> = {
    ...withoutBirthTime,
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
  const heldOut = heldOutDossierIds(CORPUS_DIR);
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

  test("golden corpus raw/ dirs carry no SQLite sidecars", () => {
    // ISS-10167: `.gitignore` hides `*.db-wal` / `*.db-shm`, so the CI
    // oracle-lock `git status` cannot see them, yet Layer 1 copies raw/
    // recursively and a non-empty -wal beside the frozen db WOULD be read.
    const sidecars = findSqliteSidecars(CORPUS_DIR);
    assert.ok(
      sidecars.length === 0,
      `the golden corpus has SQLite sidecars — something opened a corpus .db in place instead of staging a copy. Delete the named files:\n  - ${sidecars.join("\n  - ")}`
    );
  });

  registerCoverageManifestTests(CORPUS_DIR, dossiers);
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

  // ISS-12552 (PRD-800 "Rollout"): under the base policy a dossier from
  // the attribution intake is not parsed here; its oracle records the
  // attribution parse.
  const attributionPolicy = effectiveParsePolicy().attributionEvidence;
  for (const d of dossiers) {
    if (!attributionPolicy && isAttributionIntakeDossier(d)) {
      continue;
    }
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
      const parsed = jsonNormalize(rawParsed, {
        keepAttributionEvidence:
          d.normalized !== null && carriesAttributionEvidence(d.normalized),
      });

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
      // BOTH sides (a dossier may freeze a real mtime; 0c93c742 does).
      const oracle = projectOracle(d.normalized);
      const comparableParsed = withoutUnsignedSidecarCompletions(
        parsed,
        oracle
      );
      if (!isDeepStrictEqual(comparableParsed, oracle)) {
        const diff = firstDiffPath(comparableParsed, oracle);
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
      failures.push(
        ...(await heldInAttributionFailures(d, rawParsed, heldOut))
      );
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

/**
 * Ignore only ISS-6980 completion fields absent from a signed oracle. New tool
 * rows, ordering, identities, inputs, and every already-signed field remain part
 * of the frozen deep equality contract.
 */
// Exported for the ISS-10736 amendment-proposal tooling — see `projectOracle`.
export function withoutUnsignedSidecarCompletions(
  parsed: Record<string, unknown>,
  oracle: Record<string, unknown>
): Record<string, unknown> {
  const comparable = structuredClone(parsed);
  const oracleSubagents = indexedRecords(oracle.subagents);
  for (const subagent of recordArray(comparable.subagents)) {
    const subagentId = recordId(subagent);
    const oracleSubagent = subagentId ? oracleSubagents.get(subagentId) : null;
    if (!oracleSubagent) {
      continue;
    }
    const oracleToolUses = indexedRecords(oracleSubagent.toolUses);
    for (const toolUse of recordArray(subagent.toolUses)) {
      const toolUseId = recordId(toolUse);
      const oracleToolUse = toolUseId ? oracleToolUses.get(toolUseId) : null;
      if (!oracleToolUse) {
        continue;
      }
      for (const field of SIDECAR_COMPLETION_FIELDS) {
        if (!Object.hasOwn(oracleToolUse, field)) {
          Reflect.deleteProperty(toolUse, field);
        }
      }
    }
  }
  return comparable;
}

function indexedRecords(value: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const record of recordArray(value)) {
    const id = recordId(record);
    if (id) {
      index.set(id, record);
    }
  }
  return index;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object"
      )
    : [];
}

function recordId(record: Record<string, unknown>): string | null {
  return typeof record.id === "string" ? record.id : null;
}

const SIDECAR_COMPLETION_FIELDS = [
  "output",
  "resultTimestamp",
  "isError",
] as const;

/**
 * ISS-7795: drop the additive per-invocation `usage` the frozen Layer 1 oracles
 * predate, from both lists that can carry it.
 */
function stripComponentUsage(session: Record<string, unknown>): void {
  for (const key of ["skills", "slashCommands"]) {
    const entries = session[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        (entry as Record<string, unknown>).usage = undefined;
        Reflect.deleteProperty(entry as Record<string, unknown>, "usage");
      }
    }
  }
}

const TOOL_RESULT_EVIDENCE_FIELDS = [
  "resultState",
  "closedloopResultFacts",
  "shellOperationIds",
  // ISS-12552 (PRD-800): the request that issued the call.
  "requestKey",
] as const;

function stripToolResultEvidence(session: Record<string, unknown>): void {
  const subagents = Array.isArray(session.subagents) ? session.subagents : [];
  const toolLists = [
    session.toolUses,
    ...subagents.map((subagent: unknown) =>
      subagent && typeof subagent === "object"
        ? (subagent as Record<string, unknown>).toolUses
        : undefined
    ),
  ];
  for (const toolUses of toolLists) {
    if (!Array.isArray(toolUses)) {
      continue;
    }
    for (const toolUse of toolUses) {
      if (!toolUse || typeof toolUse !== "object") {
        continue;
      }
      const record = toolUse as Record<string, unknown>;
      for (const field of TOOL_RESULT_EVIDENCE_FIELDS) {
        Reflect.deleteProperty(record, field);
      }
      if (record.mcpNamespace !== undefined) {
        Reflect.deleteProperty(record, "mcpNamespace");
        Reflect.deleteProperty(record, "providerToolUseId");
      }
    }
  }
}

/** ISS-12552: attribution facts for a regression-set dossier; none for a held-out one. */
async function heldInAttributionFailures(
  d: GoldenDossier,
  rawParsed: NormalizedSession | null,
  heldOut: ReadonlySet<string>
): Promise<string[]> {
  if (rawParsed === null || heldOut.has(d.sessionId)) {
    return [];
  }
  const failures = await attributionLayer1Failures(
    d.dir,
    d.expectations,
    rawParsed
  );
  return failures.map((failure) => `attribution ${failure}`);
}

/**
 * ISS-12552: whether a frozen oracle was written with the attribution evidence
 * fields (tool result facts and Codex code-mode MCP calls). The oracles frozen
 * before them are compared without those fields; the ISS-12552 intake carries
 * them, so Layers 2 and 5, which import normalized.json, see the evidence the
 * parser actually produces.
 */
export function carriesAttributionEvidence(
  normalized: Record<string, unknown>
): boolean {
  if (normalized.mcpCallEvidence !== undefined) {
    return true;
  }
  const subagents = recordArray(normalized.subagents);
  return [normalized, ...subagents].some((holder) =>
    recordArray(holder.toolUses).some((toolUse) =>
      TOOL_RESULT_EVIDENCE_FIELDS.some((field) => Object.hasOwn(toolUse, field))
    )
  );
}

/**
 * ISS-12552: a dossier the attribution intake added, whose oracle was written
 * under the attribution policy: its normalized.json carries the evidence
 * fields, or its expectations carry an `attribution` block.
 */
export function isAttributionIntakeDossier(d: GoldenDossier): boolean {
  return (
    (d.normalized !== null && carriesAttributionEvidence(d.normalized)) ||
    Object.hasOwn(d.expectations ?? {}, "attribution")
  );
}
