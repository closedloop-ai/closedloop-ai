/**
 * @file golden-collectors.test.ts
 * @description Unit tests for stageGoldenCorpus + createGoldenCollectors
 * (FEA-2648). All corpus writes happen in throwaway temp dirs; the real
 * packages/golden-sessions corpus is touched by at most one read-only test.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isImportableCollectorSource } from "../src/main/collectors/engine/source-admission.js";
import { listDossierDirs } from "../src/main/collectors/golden/corpus-layout.js";
import {
  createGoldenCollectors,
  stageGoldenCorpus,
} from "../src/main/collectors/golden/golden-collectors.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Three directories up from test/ → symphony-alpha-fea-2648/packages/golden-sessions
const REAL_CORPUS_DIR = path.resolve(
  __dirname,
  "../../../packages/golden-sessions"
);

const DISJOINT_ERROR = /disjoint/;
const MISSING_RAW_ERROR = /has no raw\/ directory/;
const OPENCODE_DB_NAME_ERROR = /must be named opencode\.db/;

// Synthetic session ids used throughout the fixture corpus
const CLAUDE_SID = "claude-golden-test-001";
const CODEX_SID = "codex-golden-test-001";
const OPENCODE_SID = "ses_goldentestopen";

// Codex rollout basenames (parent carries the CODEX_SID for classifyRawFiles)
const CODEX_PARENT_ROLLOUT = `rollout-2026-01-01T00-00-00-${CODEX_SID}.jsonl`;
const CODEX_CHILD_ROLLOUT = "rollout-2026-01-01T00-00-01-child-abc.jsonl";

// Temp-dir tracking — afterEach cleanup is registered by the manager
const { makeTempDir } = createTempDirManager("golden-collectors-");

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Populate a claude dossier under corpusDir:
 *   <sid>/raw/<sid>.jsonl
 *   <sid>/raw/<sid>/subagents/agent-1.jsonl   ← sidecar tree
 */
function makeClaudeDossier(corpusDir: string): void {
  const rawDir = path.join(corpusDir, CLAUDE_SID, "raw");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(path.join(rawDir, `${CLAUDE_SID}.jsonl`), '{"type":"test"}\n');
  const subagentsDir = path.join(rawDir, CLAUDE_SID, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(
    path.join(subagentsDir, "agent-1.jsonl"),
    '{"type":"subagent"}\n'
  );
}

/**
 * Populate a codex dossier under corpusDir with a parent rollout (containing
 * CODEX_SID in its name) and one child rollout:
 *   <sid>/raw/rollout-...-<sid>.jsonl  ← parent
 *   <sid>/raw/rollout-...-child.jsonl  ← child
 */
function makeCodexDossier(corpusDir: string): void {
  const rawDir = path.join(corpusDir, CODEX_SID, "raw");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(path.join(rawDir, CODEX_PARENT_ROLLOUT), '{"type":"parent"}\n');
  writeFileSync(path.join(rawDir, CODEX_CHILD_ROLLOUT), '{"type":"child"}\n');
}

/**
 * Populate an opencode dossier under corpusDir with a real WAL-mode SQLite db:
 *   <sid>/raw/opencode.db
 * The db is immediately closed so no open handles remain; the file is a valid
 * SQLite db — non-db files would satisfy classification but a real db is used
 * to exercise the corpus-integrity invariant (no new -wal/-shm created by
 * stageGoldenCorpus or by listSources/watchRoots calls on the staged copy).
 */
function makeOpencodeDossier(corpusDir: string): void {
  const rawDir = path.join(corpusDir, OPENCODE_SID, "raw");
  mkdirSync(rawDir, { recursive: true });
  const dbPath = path.join(rawDir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.close();
}

/**
 * Recursively enumerate all regular files under dir as {relPath → size}.
 * Used to snapshot a directory tree before/after golden-mode operations so
 * corpus-integrity violations (new files, changed sizes) are immediately
 * visible.
 */
function snapshotDir(dir: string): Map<string, number> {
  const result = new Map<string, number>();
  function walk(d: string, rel: string): void {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, relPath);
      } else {
        result.set(relPath, stat.size);
      }
    }
  }
  walk(dir, "");
  return result;
}

// ── Test 1: Staging mirrors ──────────────────────────────────────────────────

test("stageGoldenCorpus: staging mirrors dossier raw/ contents exactly", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");

  makeClaudeDossier(corpusDir);
  makeCodexDossier(corpusDir);
  // Non-dossier scaffolding must not be staged
  mkdirSync(path.join(corpusDir, "_templates"), { recursive: true });
  writeFileSync(path.join(corpusDir, "stray.txt"), "stray");

  stageGoldenCorpus(corpusDir, stagingDir);

  // Claude main file is staged
  assert.ok(
    existsSync(path.join(stagingDir, CLAUDE_SID, `${CLAUDE_SID}.jsonl`)),
    "claude main .jsonl is staged"
  );
  // Claude subagent sidecar tree (raw/<sid>/<sid>/subagents/) is preserved
  assert.ok(
    existsSync(
      path.join(
        stagingDir,
        CLAUDE_SID,
        CLAUDE_SID,
        "subagents",
        "agent-1.jsonl"
      )
    ),
    "claude subagent sidecar tree is preserved in staging"
  );
  // Codex parent and child rollouts are both staged
  assert.ok(
    existsSync(path.join(stagingDir, CODEX_SID, CODEX_PARENT_ROLLOUT)),
    "codex parent rollout is staged"
  );
  assert.ok(
    existsSync(path.join(stagingDir, CODEX_SID, CODEX_CHILD_ROLLOUT)),
    "codex child rollout is staged"
  );
  // _templates is a known non-dossier dir → not staged
  assert.ok(
    !existsSync(path.join(stagingDir, "_templates")),
    "_templates is not staged"
  );
  // A stray file (non-directory) at corpus root is not a dossier → not staged
  assert.ok(
    !existsSync(path.join(stagingDir, "stray.txt")),
    "stray root file is not staged"
  );
});

// ── Test 2: CORPUS-INTEGRITY ─────────────────────────────────────────────────

test("CORPUS-INTEGRITY: staging + collectors + listSources/watchRoots never write to the corpus", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");

  makeClaudeDossier(corpusDir);
  makeCodexDossier(corpusDir);
  makeOpencodeDossier(corpusDir);

  // Snapshot the fixture corpus BEFORE any golden-mode operations. If the
  // opencode.db creation left -wal/-shm behind, they appear in BOTH snapshots
  // so the comparison still succeeds; what matters is nothing NEW is written.
  const before = snapshotDir(corpusDir);

  stageGoldenCorpus(corpusDir, stagingDir);
  const collectors = createGoldenCollectors(stagingDir);

  // Drive every collector's enumeration surface — these are the calls the
  // production boot importer makes before touching any file content.
  for (const collector of collectors) {
    collector.listSources();
    collector.watchRoots();
  }

  const after = snapshotDir(corpusDir);

  // File set must be byte-identical
  assert.equal(
    before.size,
    after.size,
    "no files added or removed from corpus"
  );
  for (const [relPath, sizeBefore] of before) {
    assert.ok(after.has(relPath), `corpus file disappeared: ${relPath}`);
    assert.equal(
      after.get(relPath),
      sizeBefore,
      `corpus file size changed: ${relPath}`
    );
  }

  // Belt-and-suspenders: verify nothing was written into the corpus — covers
  // the -wal/-shm case explicitly (any new file added by a stale open would
  // appear here and fail the assertion).
  for (const [relPath] of after) {
    assert.ok(
      before.has(relPath),
      `unexpected new file in corpus after golden operations: ${relPath}`
    );
  }
});

// ── Test 3: Idempotency ───────────────────────────────────────────────────────

test("stageGoldenCorpus idempotency: removed dossier disappears; planted alien file is wiped", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");

  makeClaudeDossier(corpusDir);
  makeCodexDossier(corpusDir);

  // First stage — both dossiers land in staging
  stageGoldenCorpus(corpusDir, stagingDir);
  assert.ok(
    existsSync(path.join(stagingDir, CODEX_SID)),
    "codex dossier staged on first pass"
  );

  // Remove codex from the fixture corpus and plant a file in staging that has
  // no corpus origin. After re-staging the removed dossier must be gone and
  // the planted file must be gone (staging is always a clean copy).
  rmSync(path.join(corpusDir, CODEX_SID), { recursive: true, force: true });
  writeFileSync(path.join(stagingDir, "alien.txt"), "should be wiped");

  // Re-stage
  stageGoldenCorpus(corpusDir, stagingDir);

  assert.ok(
    !existsSync(path.join(stagingDir, CODEX_SID)),
    "removed dossier is gone from staging after re-stage"
  );
  assert.ok(
    !existsSync(path.join(stagingDir, "alien.txt")),
    "manually planted alien file is wiped by re-stage"
  );
  // The claude dossier that was NOT removed must still be present
  assert.ok(
    existsSync(path.join(stagingDir, CLAUDE_SID, `${CLAUDE_SID}.jsonl`)),
    "remaining claude dossier is still staged"
  );
});

// ── Fail-loud contracts (incomplete dossiers must never be silently skipped) ──

test("stageGoldenCorpus throws when a dossier has no raw/ directory", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");
  mkdirSync(path.join(corpusDir, "incomplete-dossier"), { recursive: true });
  assert.throws(
    () => stageGoldenCorpus(corpusDir, stagingDir),
    MISSING_RAW_ERROR,
    "a dossier without raw/ must fail staging, never be skipped"
  );
});

test("createGoldenCollectors throws when an opencode db is not named opencode.db", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");
  const rawDir = path.join(corpusDir, "ses_wrongname", "raw");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(path.join(rawDir, "custom-name.db"), "not-a-real-db");
  stageGoldenCorpus(corpusDir, stagingDir);
  assert.throws(
    () => createGoldenCollectors(stagingDir),
    OPENCODE_DB_NAME_ERROR,
    "a mis-named opencode db must fail loudly, not import zero sessions"
  );
});

// ── Test 4: assertDisjoint ────────────────────────────────────────────────────

describe("stageGoldenCorpus assertDisjoint", () => {
  test("stagingDir inside corpusDir throws", () => {
    const corpusDir = makeTempDir("corpus-");
    const stagingDir = path.join(corpusDir, "staging");
    assert.throws(
      () => stageGoldenCorpus(corpusDir, stagingDir),
      DISJOINT_ERROR,
      "staging inside corpus must throw"
    );
  });

  test("corpusDir inside stagingDir throws", () => {
    const stagingDir = makeTempDir("staging-");
    const corpusDir = path.join(stagingDir, "corpus");
    assert.throws(
      () => stageGoldenCorpus(corpusDir, stagingDir),
      DISJOINT_ERROR,
      "corpus inside staging must throw"
    );
  });

  test("disjoint dirs do not throw", () => {
    const corpusDir = makeTempDir("corpus-");
    const stagingDir = makeTempDir("staging-");
    // Both dirs exist and are disjoint — should not throw even with an empty corpus
    assert.doesNotThrow(
      () => stageGoldenCorpus(corpusDir, stagingDir),
      "disjoint dirs must not throw"
    );
  });
});

// ── Test 5: createGoldenCollectors wiring ────────────────────────────────────

describe("createGoldenCollectors wiring", () => {
  test("returns exactly claude + codex collectors when no opencode dossier is present", () => {
    const corpusDir = makeTempDir("corpus-");
    const stagingDir = makeTempDir("staging-");

    makeClaudeDossier(corpusDir);
    makeCodexDossier(corpusDir);
    // No opencode dossier → opencode collector must not appear

    stageGoldenCorpus(corpusDir, stagingDir);
    const collectors = createGoldenCollectors(stagingDir);

    const keys = collectors.map((c) => c.key);
    assert.ok(keys.includes("claude"), "claude collector present");
    assert.ok(keys.includes("codex"), "codex collector present");
    assert.ok(!keys.includes("opencode"), "opencode collector absent");
    assert.ok(!keys.includes("cursor"), "cursor collector never present");
    assert.ok(!keys.includes("copilot"), "copilot collector never present");
  });

  test("claude collector listSources returns exactly the staged main files, not sidecars", () => {
    const corpusDir = makeTempDir("corpus-");
    const stagingDir = makeTempDir("staging-");

    makeClaudeDossier(corpusDir);
    stageGoldenCorpus(corpusDir, stagingDir);
    const collectors = createGoldenCollectors(stagingDir);

    const claudeCollector = collectors.find((c) => c.key === "claude");
    assert.ok(claudeCollector, "claude collector must exist");
    const sources = claudeCollector.listSources();

    assert.equal(sources.length, 1, "exactly one claude main source");
    assert.equal(
      sources[0],
      path.join(stagingDir, CLAUDE_SID, `${CLAUDE_SID}.jsonl`),
      "claude main file path matches"
    );
    // Subagent sidecar must NOT appear in listSources()
    for (const src of sources) {
      assert.ok(
        !src.includes("subagents"),
        `claude listSources must not include subagent sidecars, but got: ${src}`
      );
    }
  });

  test("codex collector listSources returns ALL staged rollouts (parent + child)", () => {
    const corpusDir = makeTempDir("corpus-");
    const stagingDir = makeTempDir("staging-");

    makeCodexDossier(corpusDir);
    stageGoldenCorpus(corpusDir, stagingDir);
    const collectors = createGoldenCollectors(stagingDir);

    const codexCollector = collectors.find((c) => c.key === "codex");
    assert.ok(codexCollector, "codex collector must exist");
    const sources = codexCollector.listSources().sort();

    assert.equal(sources.length, 2, "both parent and child rollouts listed");
    assert.ok(
      sources.some((s) => s.endsWith(CODEX_PARENT_ROLLOUT)),
      "parent rollout is in listSources()"
    );
    assert.ok(
      sources.some((s) => s.endsWith(CODEX_CHILD_ROLLOUT)),
      "child rollout is in listSources()"
    );
  });

  test("every listSources() and watchRoots() path from every collector is inside stagingDir", () => {
    const corpusDir = makeTempDir("corpus-");
    const stagingDir = makeTempDir("staging-");

    makeClaudeDossier(corpusDir);
    makeCodexDossier(corpusDir);
    makeOpencodeDossier(corpusDir);

    stageGoldenCorpus(corpusDir, stagingDir);
    const collectors = createGoldenCollectors(stagingDir);

    for (const collector of collectors) {
      for (const p of collector.listSources()) {
        assert.ok(
          p.startsWith(stagingDir + path.sep) || p === stagingDir,
          `${collector.key} listSources() path outside stagingDir: ${p}`
        );
      }
      for (const r of collector.watchRoots()) {
        assert.ok(
          r.startsWith(stagingDir + path.sep) || r === stagingDir,
          `${collector.key} watchRoots() path outside stagingDir: ${r}`
        );
      }
    }
  });
});

// ── Test 6: Source admission ──────────────────────────────────────────────────

test("every listSources() entry from every collector is admissible via isImportableCollectorSource", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");

  makeClaudeDossier(corpusDir);
  makeCodexDossier(corpusDir);
  makeOpencodeDossier(corpusDir);

  stageGoldenCorpus(corpusDir, stagingDir);
  const collectors = createGoldenCollectors(stagingDir);

  for (const collector of collectors) {
    for (const source of collector.listSources()) {
      assert.ok(
        isImportableCollectorSource(collector, source),
        `${collector.key} source not admissible: ${source}`
      );
    }
  }
});

// ── Test 7: Empty corpus ──────────────────────────────────────────────────────

test("createGoldenCollectors returns [] for an empty corpus (only scaffolding and stray files)", () => {
  const corpusDir = makeTempDir("corpus-");
  const stagingDir = makeTempDir("staging-");

  // Only non-dossier scaffolding — no actual dossiers
  mkdirSync(path.join(corpusDir, "_templates"), { recursive: true });
  writeFileSync(path.join(corpusDir, "README.md"), "not a dossier");

  stageGoldenCorpus(corpusDir, stagingDir);
  const collectors = createGoldenCollectors(stagingDir);

  assert.deepEqual(collectors, [], "empty corpus yields no collectors");
});

// ── CORPUS-SANITY (real read-only corpus) ────────────────────────────────────

test("real golden corpus: listDossierDirs matches the expectations.yaml inventory", () => {
  // Uses the human-owned corpus read-only — never stages in place, never writes.
  // Staging is done to a temp dir to avoid touching corpus state (the AGENTS.md
  // requirement). We only call listDossierDirs to count; no parse or write.
  const stagingDir = makeTempDir("real-corpus-staging-");

  stageGoldenCorpus(REAL_CORPUS_DIR, stagingDir);

  // Cross-check enumeration against an independent signal: every dossier dir
  // carries a human-signed expectations.yaml. A hardcoded count would go stale
  // every time the corpus grows (it moved 21→22 mid-build).
  const dossiers = listDossierDirs(REAL_CORPUS_DIR);
  const expectationsDirs = readdirSync(REAL_CORPUS_DIR).filter(
    (name) =>
      // _templates ships a template expectations.yaml — not a dossier.
      !name.startsWith("_") &&
      existsSync(path.join(REAL_CORPUS_DIR, name, "expectations.yaml"))
  );
  assert.ok(dossiers.length > 0, "corpus has at least one dossier");
  assert.deepEqual(
    dossiers.map((d) => d.sessionId).sort(),
    expectationsDirs.sort(),
    "listDossierDirs must return exactly the dirs carrying expectations.yaml"
  );

  // Quick kind-breakdown sanity: at least one dossier of each kind must appear.
  // This fails loudly if a whole collector family disappears from the corpus.
  const kindsSeen = new Set<string>();
  for (const { sessionId, dir } of listDossierDirs(stagingDir)) {
    const files = readdirSync(dir);
    if (files.some((f) => f.endsWith(".db"))) {
      kindsSeen.add("opencode");
    } else if (
      files.some((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
    ) {
      kindsSeen.add("codex");
    } else if (files.some((f) => f === `${sessionId}.jsonl`)) {
      kindsSeen.add("claude");
    }
  }
  assert.ok(kindsSeen.has("claude"), "at least one claude dossier in corpus");
  assert.ok(kindsSeen.has("codex"), "at least one codex dossier in corpus");
  assert.ok(
    kindsSeen.has("opencode"),
    "at least one opencode dossier in corpus"
  );
});
