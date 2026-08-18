/**
 * PLN-1389 Phase 1 — Frozen cloud-payload regen for golden dossiers (PRD-522 R5).
 *
 * Usage (from apps/desktop):
 *   pnpm run regen:golden-sync-payloads                 # regen the default dossier set
 *   pnpm run regen:golden-sync-payloads <sessionId>...  # regen specific dossiers
 *   pnpm exec tsx scripts/regen-golden-sync-payloads.ts <sessionId>...
 *
 * WHY THIS EXISTS (the design crux, see PLN-1389 "Design decision"):
 * There is no `normalized.json -> SyncedAgentSession` transform anywhere. The
 * production payload builder (`sync-source.ts`) reads SQLite and cannot be
 * imported into an `apps/api` vitest run. Hand-writing a transform at test time
 * would put UNTRUSTED code between the oracle and the parity
 * assertion. Instead we run the REAL production path once, offline:
 *
 *   1. Import a golden dossier's `normalized.json` into a temp SQLite via the
 *      production importer (`db.importer.importSession` — the same path golden
 *      Layer 2 exercises), using the identical Layer-2 input normalization
 *      (`loadLayer2Input`) so status/tokens are deterministic.
 *   2. Let the production sync-source build the genuine `SyncedAgentSession`
 *      (`db.syncSource.loadSyncedSessions`) and slim it exactly as the transport
 *      does (`sanitizeSessionForSync`).
 *   3. Commit that payload as a reviewable, diffable DERIVED fixture, OUTSIDE the
 *      oracle dirs, under `apps/api/__tests__/fixtures/golden-web-sync/`.
 *
 * The `apps/api` parity test (PLN-1389 Phase 2) then ingests this frozen payload
 * through the real cloud contract and asserts the read-back equals the dossier's
 * oracle `expectations.yaml`. Production code produced the payload; the test
 * contains no bespoke mapping.
 *
 * The derived fixture is DERIVED, NOT AN ORACLE: it is reproduced by re-running
 * this script and MUST be regenerated (never hand-edited) whenever
 * `AGENT_SESSION_SYNC_SCHEMA_VERSION` bumps or the sync-source/importer changes.
 * It never touches `packages/golden-sessions/**` (raw/normalized/expectations
 * are oracle files — see packages/golden-sessions/AGENTS.md).
 *
 * DETERMINISM: `deviceTimeZone` is resolved from the host `Intl` default at
 * capture, so output is only byte-stable under a fixed process timezone. The
 * `regen:golden-sync-payloads` npm alias pins `TZ=UTC` for this reason — always
 * regenerate through the alias, never bare `tsx` under an ambient TZ.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { SessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { sanitizeSessionForSync } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { openTestDb } from "../test/agent-db-test-utils.js";
import type {
  DossierExpectations,
  GoldenDossier,
} from "../test/golden/golden-corpus.js";
import { loadLayer2Input } from "../test/golden/golden-layer2-input.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const GOLDEN_DIR = resolve(REPO_ROOT, "packages/golden-sessions");
const FIXTURES_DIR = resolve(
  REPO_ROOT,
  "apps/api/__tests__/fixtures/golden-web-sync"
);
const REGEN_COMMAND = "pnpm --filter desktop run regen:golden-sync-payloads";

/**
 * A dossier id is a single directory name under `packages/golden-sessions/` and
 * the basename of a fixture file. Reject anything that could escape either dir
 * (path separators / `..`) so a mistyped or path-like CLI arg fails fast instead
 * of reading or writing outside the golden/fixtures roots.
 */
function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    throw new Error(
      `Unsafe dossier id ${JSON.stringify(sessionId)}: expected a bare directory name (no path separators or "..").`
    );
  }
}

/**
 * Default dossier set frozen for the cloud parity test. v1 is a single bounded,
 * representative dossier (PLN-1389 Phase 1.2): `f9830b64` is the smallest priced
 * single-model claude dossier with real cache tokens, so it exercises token-by-
 * model serialization (the drift class R5 targets) while staying well under the
 * 262 KB sync route cap. Its `gitBranch` is only a metadata string — golden
 * import resolves no repository, so NO Branch entity is linked (the parity test
 * asserts exactly that; see golden-web-sync.integration.test.ts assertion 4).
 * Positive branch-rollup coverage lives in the Phase 0 repo-bearing fixture.
 */
const DEFAULT_DOSSIERS = ["f9830b64-52fb-47c7-a115-07fc17372bb5"] as const;

/**
 * Provenance header stamped on every derived fixture so reviewers can tell it is
 * generated, not authored (PLN-1389 Phase 1.3).
 */
type FixtureProvenance = {
  warning: string;
  sourceSessionId: string;
  harness: string;
  schemaVersion: number;
  generatedBy: string;
  regenCommand: string;
  oracle: string;
};

type GoldenSyncFixture = {
  provenance: FixtureProvenance;
  /** Mirrors the payload envelope's schemaVersion so a schema bump is diffable. */
  schemaVersion: number;
  /**
   * The production-built, transport-sanitized sessions. The parity test wraps
   * these in a `DesktopAgentSessionsPayload` envelope (batchId/syncMode are
   * per-batch concerns the test owns, kept out of the byte-stable fixture).
   */
  sessions: SyncedAgentSession[];
};

/** Load a single dossier's frozen files into the shape `loadLayer2Input` needs. */
function loadDossier(sessionId: string): GoldenDossier {
  assertSafeSessionId(sessionId);
  const dir = join(GOLDEN_DIR, sessionId);
  const normalizedText = readFileSync(join(dir, "normalized.json"), "utf8");
  const normalized = JSON.parse(normalizedText) as Record<
    string,
    unknown
  > | null;
  if (normalized === null) {
    throw new Error(
      `${sessionId}: normalized.json is null (empty-session drop case) — not a syncable dossier`
    );
  }
  const expectations = parseYaml(
    readFileSync(join(dir, "expectations.yaml"), "utf8")
  ) as DossierExpectations;
  return { sessionId, dir, rawDir: join(dir, "raw"), normalized, expectations };
}

/**
 * Reproduce the production sync payload for one dossier and write it to the
 * derived fixtures dir. Returns the fixture path.
 */
async function regenDossier(sessionId: string): Promise<string> {
  const dossier = loadDossier(sessionId);
  // Same normalization the golden Layer-2 suite uses: clone, null fileModifiedAt
  // (deterministic "completed" status), default prLinks, and a per-dossier clock.
  const { input, nowD, harness } = loadLayer2Input(dossier);

  const tmp = mkdtempSync(join(tmpdir(), "regen-golden-sync-"));
  const db = await openTestDb(tmp, { now: () => nowD });
  try {
    const result = await db.importer.importSession(input, harness);
    if (result.skipped || result.failed || result.incomplete === true) {
      throw new Error(
        `${sessionId}: importSession did not persist a complete session (${JSON.stringify(result)})`
      );
    }

    // Discover the imported session id from the store rather than assuming
    // sessions.id === normalized.sessionId. A fresh temp DB holds exactly one.
    const cursorRows = await db.syncSource.listAllSessionCursorRows();
    const ids = cursorRows.map((row) => row.id);
    if (ids.length !== 1) {
      throw new Error(
        `${sessionId}: expected exactly one imported session, found ${ids.length}`
      );
    }

    // Production hydration options (matches agent-session-sync-service.syncOnce):
    // omit desktop-local event `data`, include component usage.
    const cache: SessionAttributionResolverCache = {
      attributionByCwd: new Map(),
      launchMetadataRootByCwd: new Map(),
      repoFullNameByPath: new Map(),
    };
    const hydrated = await db.syncSource.loadSyncedSessions(ids, cache, {
      omitEventData: true,
      includeComponentUsage: true,
    });

    // Slim to exactly what the transport ships / the cloud persists (FEA-2718).
    const sessions = hydrated.map((session) => sanitizeSessionForSync(session));

    const fixture: GoldenSyncFixture = {
      provenance: {
        warning:
          "DERIVED fixture — regenerated, never hand-edited. Regenerate on an AGENT_SESSION_SYNC_SCHEMA_VERSION bump or a sync-source/importer change. Not an oracle.",
        sourceSessionId: sessionId,
        harness,
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        generatedBy: "apps/desktop/scripts/regen-golden-sync-payloads.ts",
        regenCommand: REGEN_COMMAND,
        oracle: `packages/golden-sessions/${sessionId}/expectations.yaml`,
      },
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      sessions,
    };

    mkdirSync(FIXTURES_DIR, { recursive: true });
    const outPath = join(FIXTURES_DIR, `${sessionId}.synced-session.json`);
    // Two-space, trailing-newline JSON. Deterministic: identical code + frozen
    // input + fixed clock => byte-stable output on re-run (Phase 1 acceptance).
    writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    return outPath;
  } finally {
    try {
      await db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  // Determinism guard: `deviceTimeZone` is resolved from the host `Intl` default,
  // so byte-stable output requires a fixed process timezone. The regen npm alias
  // pins TZ=UTC; fail fast (rather than silently committing a host-TZ fixture) if
  // the script is invoked another way — e.g. bare `tsx` — under a different TZ.
  if (process.env.TZ !== "UTC") {
    throw new Error(
      `regen requires TZ=UTC for byte-stable output (deviceTimeZone is host-derived); got TZ=${JSON.stringify(
        process.env.TZ ?? null
      )}. Run via \`${REGEN_COMMAND}\`.`
    );
  }

  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const sessionIds = requested.length > 0 ? requested : [...DEFAULT_DOSSIERS];

  for (const sessionId of sessionIds) {
    const outPath = await regenDossier(sessionId);
    process.stdout.write(
      `regenerated ${sessionId} -> ${outPath.replace(`${REPO_ROOT}/`, "")}\n`
    );
  }
  process.stdout.write(
    `done: ${sessionIds.length} derived golden-web-sync payload(s)\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
