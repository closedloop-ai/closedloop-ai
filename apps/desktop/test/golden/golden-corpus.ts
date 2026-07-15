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
import { findDivergence, KNOWN_DIVERGENCES } from "./golden-divergences.js";

const CORPUS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/golden-sessions"
);
const TICKET_ID = /^FEA-\d+$/;
// Session ids as they appear in the coverage CSVs: UUIDs plus opencode ses_* ids.
const SESSION_ID_TOKEN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[A-Za-z0-9]+/g;

type DossierTokenCounts = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
};

type DossierSubagent = {
  subagent_id?: string;
  model?: string | null;
  tokens?: DossierTokenCounts;
};

/** The Layer-1-relevant slice of expectations.yaml (extra keys are ignored). */
export type DossierExpectations = {
  session?: {
    status?: string;
    billing_mode?: string;
    primary_model?: string | null;
    models_used?: string[];
    lifecycle?: {
      fresh?: boolean;
      resumed?: boolean;
      compacted?: boolean;
      interrupted?: boolean;
    };
  };
  turns?: {
    total?: number;
    user?: number;
    assistant?: number;
    tool_result?: number;
  };
  tokens_by_model?: Record<string, DossierTokenCounts>;
  cost?: { total?: number; metered_total?: number };
  subagents?: { count?: number; attributed?: DossierSubagent[] };
  activity?: {
    tools?: { name?: string; count?: number }[];
    commands?: { name?: string; count?: number }[];
    thinking_blocks?: number;
  };
  pr_lifecycle?: { observed?: boolean };
  notes?: string;
};

type ParsedSubagentView = {
  id?: string;
  nativeSubagentId?: string | null;
  tokensByModel?: Record<
    string,
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  >;
};

/** The Layer-1-relevant slice of a JSON-normalized parse result. */
type ParsedSessionView = {
  userMessages?: number;
  assistantMessages?: number;
  model?: string | null;
  tokensByModel?: Record<
    string,
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  >;
  subagents?: ParsedSubagentView[];
  thinkingBlockCount?: number;
  slashCommands?: { name?: string }[];
  toolUses?: { name?: string; subagentId?: string | null }[];
  compactions?: unknown[];
};

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
 * Required expectations keys — a dossier missing any of these fails instead of
 * silently skipping the assertion (codex-review finding: optional-key skipping
 * lets a hollow dossier pass).
 */
function missingRequiredFacts(exp: DossierExpectations): string[] {
  const missing: string[] = [];
  const need = (cond: boolean, key: string) => {
    if (!cond) {
      missing.push(key);
    }
  };
  need(typeof exp.session?.status === "string", "session.status");
  need(
    exp.session?.billing_mode === "unknown",
    'session.billing_mode=="unknown"'
  );
  need(exp.session?.primary_model !== undefined, "session.primary_model");
  need(Array.isArray(exp.session?.models_used), "session.models_used");
  for (const flag of [
    "fresh",
    "resumed",
    "compacted",
    "interrupted",
  ] as const) {
    need(
      typeof exp.session?.lifecycle?.[flag] === "boolean",
      `session.lifecycle.${flag}`
    );
  }
  for (const t of ["total", "user", "assistant", "tool_result"] as const) {
    need(typeof exp.turns?.[t] === "number", `turns.${t}`);
  }
  const turns = exp.turns;
  if (turns) {
    need(
      (turns.total ?? 0) ===
        (turns.user ?? 0) + (turns.assistant ?? 0) + (turns.tool_result ?? 0),
      "turns.total==user+assistant+tool_result"
    );
  }
  need(
    typeof exp.tokens_by_model === "object" && exp.tokens_by_model !== null,
    "tokens_by_model"
  );
  need(exp.cost?.total === 0 && exp.cost?.metered_total === 0, "cost zeroed");
  need(typeof exp.subagents?.count === "number", "subagents.count");
  need(Array.isArray(exp.activity?.tools), "activity.tools");
  need(Array.isArray(exp.activity?.commands), "activity.commands");
  need(
    typeof exp.activity?.thinking_blocks === "number",
    "activity.thinking_blocks"
  );
  need(
    typeof exp.pr_lifecycle?.observed === "boolean",
    "pr_lifecycle.observed"
  );
  need(
    typeof exp.notes === "string" && exp.notes.trim().length > 0,
    "notes (evidence trail)"
  );
  return missing;
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
function jsonNormalize(
  session: NormalizedSession | null
): Record<string, unknown> | null {
  if (session === null) {
    return null;
  }
  const plain = JSON.parse(JSON.stringify(session)) as Record<string, unknown>;
  plain.fileModifiedAt = null;
  return plain;
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

type Layer1Fact = {
  /** expectations.yaml key path — cited verbatim in failure messages */
  key: string;
  /** Extract the expected value from expectations.yaml (undefined = not asserted) */
  expected: (exp: DossierExpectations) => unknown;
  /** Extract the actual value from the parse result */
  actual: (s: ParsedSessionView) => unknown;
};

function commandTally(
  entries: { name?: string; count?: number }[] | undefined
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const e of entries ?? []) {
    const name = e.name ?? "(unnamed)";
    tally[name] = (tally[name] ?? 0) + (e.count ?? 1);
  }
  return tally;
}

/**
 * The Layer-1-mappable dossier facts (FEA-2646): turn counts, model set,
 * per-model token totals, subagent count + per-child attribution, thinking
 * blocks, slash-command identities, parent-transcript tool tallies, compaction
 * flag. Cost/billing_mode are excluded by corpus convention (tested
 * separately); PR lifecycle and autonomy classification are Layer 2+.
 */
const LAYER1_FACTS: Layer1Fact[] = [
  {
    key: "turns.user",
    expected: (e) => e.turns?.user,
    actual: (s) => s.userMessages,
  },
  {
    key: "turns.assistant",
    expected: (e) => e.turns?.assistant,
    actual: (s) => s.assistantMessages,
  },
  {
    key: "session.primary_model",
    expected: (e) => e.session?.primary_model ?? null,
    actual: (s) => s.model,
  },
  {
    key: "session.models_used",
    expected: (e) => [...(e.session?.models_used ?? [])].sort(),
    actual: (s) => Object.keys(s.tokensByModel ?? {}).sort(),
  },
  {
    key: "subagents.count",
    expected: (e) => e.subagents?.count,
    actual: (s) => (s.subagents ?? []).length,
  },
  {
    key: "activity.thinking_blocks",
    expected: (e) => e.activity?.thinking_blocks,
    actual: (s) => s.thinkingBlockCount,
  },
  {
    key: "activity.commands",
    expected: (e) => commandTally(e.activity?.commands),
    actual: (s) =>
      commandTally((s.slashCommands ?? []).map((c) => ({ name: c.name }))),
  },
  {
    key: "activity.tools",
    expected: (e) => commandTally(e.activity?.tools),
    // Parent-transcript tally by corpus convention ("Activity elements used
    // (parent transcript)") — folded child toolUses carry a subagentId.
    actual: (s) =>
      commandTally(
        (s.toolUses ?? [])
          .filter((tu) => tu.subagentId == null)
          .map((tu) => ({ name: tu.name }))
      ),
  },
  {
    key: "session.lifecycle.compacted",
    expected: (e) => e.session?.lifecycle?.compacted,
    actual: (s) => (s.compactions ?? []).length > 0,
  },
];

function tokenFacts(exp: DossierExpectations): Layer1Fact[] {
  const models = Object.keys(exp.tokens_by_model ?? {}).sort();
  const fields: [
    keyof DossierTokenCounts,
    "input" | "output" | "cacheRead" | "cacheWrite",
  ][] = [
    ["input", "input"],
    ["output", "output"],
    ["cache_read", "cacheRead"],
    ["cache_write", "cacheWrite"],
  ];
  return models.flatMap((m) =>
    fields.map(([dossierField, parsedField]) => ({
      key: `tokens_by_model[${m}].${dossierField}`,
      expected: (e: DossierExpectations) =>
        e.tokens_by_model?.[m]?.[dossierField],
      actual: (s: ParsedSessionView) => s.tokensByModel?.[m]?.[parsedField],
    }))
  );
}

function findParsedSubagent(
  s: ParsedSessionView,
  subagentId: string
): ParsedSubagentView | undefined {
  return (s.subagents ?? []).find(
    (sub) => sub.id === subagentId || sub.nativeSubagentId === subagentId
  );
}

function subagentTokenTotal(
  sub: ParsedSubagentView | undefined,
  model: string | null | undefined,
  field: "input" | "output" | "cacheRead" | "cacheWrite"
): number | undefined {
  if (!sub) {
    return undefined;
  }
  // When the dossier names the child's model, read that model's counts — an
  // all-model sum would let tokens misattributed under another model still
  // satisfy the fact.
  if (model) {
    return sub.tokensByModel?.[model]?.[field] ?? 0;
  }
  let total = 0;
  for (const counts of Object.values(sub.tokensByModel ?? {})) {
    total += counts?.[field] ?? 0;
  }
  return total;
}

/** Per-child attribution facts: presence, model, and the four token fields. */
function subagentFacts(exp: DossierExpectations): Layer1Fact[] {
  const facts: Layer1Fact[] = [];
  const fields: [
    keyof DossierTokenCounts,
    "input" | "output" | "cacheRead" | "cacheWrite",
  ][] = [
    ["input", "input"],
    ["output", "output"],
    ["cache_read", "cacheRead"],
    ["cache_write", "cacheWrite"],
  ];
  for (const child of exp.subagents?.attributed ?? []) {
    const id = child.subagent_id;
    if (!id) {
      continue;
    }
    facts.push({
      key: `subagents.attributed[${id}].present`,
      expected: () => true,
      actual: (s) => findParsedSubagent(s, id) !== undefined,
    });
    if (child.model) {
      facts.push({
        key: `subagents.attributed[${id}].model`,
        expected: () => true,
        actual: (s) =>
          Object.keys(findParsedSubagent(s, id)?.tokensByModel ?? {}).includes(
            child.model as string
          ),
      });
    }
    for (const [dossierField, parsedField] of fields) {
      const expectedValue = child.tokens?.[dossierField];
      if (expectedValue === undefined) {
        continue;
      }
      facts.push({
        key: `subagents.attributed[${id}].tokens.${dossierField}`,
        expected: () => expectedValue,
        actual: (s) =>
          subagentTokenTotal(
            findParsedSubagent(s, id),
            child.model,
            parsedField
          ),
      });
    }
  }
  return facts;
}

/** Divergence entries that actually fired this run (three-way self-guard). */
const firedDivergences = new Set<string>();

function checkFact(
  sessionId: string,
  fact: Layer1Fact,
  exp: DossierExpectations,
  parsed: ParsedSessionView,
  diagnostics: string[],
  failures: string[]
): void {
  const expected = fact.expected(exp);
  if (expected === undefined) {
    return; // dossier doesn't assert this key (required keys are enforced separately)
  }
  const actual = fact.actual(parsed);
  const divergence = findDivergence(sessionId, fact.key);
  const matches = isDeepStrictEqual(actual, expected);
  if (divergence) {
    firedDivergences.add(`${sessionId} ${fact.key}`);
    if (matches) {
      failures.push(
        `${fact.key} — registered divergence (${divergence.ticket}) no longer reproduces; ` +
          "a human must remove the golden-divergences.ts entry to promote this key to a hard assertion"
      );
    } else if (isDeepStrictEqual(actual, divergence.actual)) {
      diagnostics.push(
        `expected-fail ${sessionId}: ${fact.key} oracle=${JSON.stringify(expected)} parser=${JSON.stringify(actual)} (${divergence.ticket})`
      );
    } else {
      failures.push(
        `${fact.key} — parser drifted to a THIRD value ${JSON.stringify(actual)} ` +
          `(oracle ${JSON.stringify(expected)}, registered divergence ${JSON.stringify(divergence.actual)}, ${divergence.ticket}); new regression`
      );
    }
    return;
  }
  if (!matches) {
    failures.push(
      `${fact.key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} ` +
        `(oracle: packages/golden-sessions/${sessionId}/expectations.yaml → ${fact.key})`
    );
  }
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
      const missing = missingRequiredFacts(d.expectations ?? {});
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
        `divergence ${d.sessionId}:${d.key} must cite a FEA ticket`
      );
      const dup = `${d.sessionId} ${d.key}`;
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
      const parsed = jsonNormalize(await parseDossierRaw(d));

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
      const oracle = { ...d.normalized, fileModifiedAt: null };
      if (!isDeepStrictEqual(parsed, oracle)) {
        const diff = firstDiffPath(parsed, oracle);
        assert.fail(
          `${d.sessionId}: parse(raw) does not deep-equal normalized.json — first divergence at ${diff} ` +
            `(oracle: packages/golden-sessions/${d.sessionId}/normalized.json)`
        );
      }

      // 2. The human-signed facts (expectations.yaml), key by key. ALL facts are
      // checked before failing so one divergence can't mask another.
      const parsedView = parsed as ParsedSessionView;
      const diagnostics: string[] = [];
      const failures: string[] = [];
      const facts = [
        ...LAYER1_FACTS,
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
    for (const entry of KNOWN_DIVERGENCES) {
      if (!dossierIds.has(entry.sessionId)) {
        continue; // inert pre-seeded entry for a dossier arriving via another PR
      }
      assert.ok(
        firedDivergences.has(`${entry.sessionId} ${entry.key}`),
        `divergence ${entry.sessionId}:${entry.key} (${entry.ticket}) never fired — ` +
          "stale key path or the dossier stopped asserting it; remove or fix the entry"
      );
    }
  });
}
