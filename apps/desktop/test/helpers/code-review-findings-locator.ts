/**
 * @file code-review-findings-locator.ts
 * @description The production-path fixtures both code-review findings locators
 * drive: a real SQLite store, a session that names a run directory, envelopes of
 * each interesting shape, and the read-back of the persisted funnel columns.
 *
 * Extracted from `component-invocations-findings-attribution.test.ts` by
 * ISS-11325, which needed the same fixtures for the DISPOSITION states and found
 * that file 155 logical lines under the 1,000-line ceiling — too close to carry a
 * second set of cases. Every consumer imports `db.importer.importSession`
 * through these, so the two suites cannot drift into testing different paths.
 *
 * WORKER_COMPONENT_KEY is spelled as a literal and NOT imported from the
 * attributor's own reviewer map, so a fixture cannot be satisfied by the very
 * table it is policing.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import { makeSession } from "../normalized-session-test-utils.js";

export const NOW = "2026-09-26T12:00:00.000Z";
export const RUN_ID = "cr-60054";
/* The subagent type the plugin spawns every non-graph reviewer role as. Spelled
   as the literal the envelope's reviewer ids resolve to, NOT imported from the
   attributor's own map, so a test fixture cannot be satisfied by the very
   table it is policing. */
export const WORKER_COMPONENT_KEY = "code-review:code-review-worker";

export type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

export type StoredFindingsRow = {
  component_key: string;
  findings_emitted: bigint | number | null;
  findings_invalidated: bigint | number | null;
  /** ISS-11325: WHY that pair reads what it reads, as the column holds it. */
  findings_disposition: string | null;
};

export function openDb(
  dir: string,
  log?: (message: string) => void
): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
    log,
  });
}

/**
 * A session that ran one code-review, naming the run directory it worked in.
 * One subagent invocation per entry in `workerKeys`, in that order.
 */
export function reviewSession(
  sessionId: string,
  cwd: string,
  workerKeys: readonly string[] = [WORKER_COMPONENT_KEY]
) {
  return makeSession({
    sessionId,
    cwd,
    startedAt: NOW,
    endedAt: "2026-09-26T12:30:00.000Z",
    toolUses: [
      {
        id: "toolu_read_envelope",
        providerToolUseId: "toolu_read_envelope",
        name: "Read",
        kind: "builtin",
        timestamp: NOW,
        input: {
          file_path: path.join(
            cwd,
            ".closedloop-ai",
            "code-review",
            RUN_ID,
            "review_result.json"
          ),
        },
      },
    ],
    subagents: workerKeys.map((componentKey, index) => ({
      id: `sub-reviewer-${index + 1}`,
      name: componentKey,
      type: componentKey,
      normalizedName: componentKey,
      rawName: componentKey,
      startedAt: NOW,
    })),
  });
}

export async function writeEnvelope(cwd: string, body: string): Promise<void> {
  const runDir = path.join(cwd, ".closedloop-ai", "code-review", RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "review_result.json"), body, "utf8");
}

/**
 * One REJECTED plus i+1 CONFIRMED findings for the i-th named reviewer, plus one
 * that never reached a verdict — so the first producer's `emitted` is 2 and not
 * 3, and the second's is 3.
 */
export function envelopeNaming(...reviewers: readonly string[]): string {
  return JSON.stringify({
    review_id: "review-11238",
    /* Reviewer i gets i+1 CONFIRMED findings, so two producers resolving to one
       component key carry DIFFERENT funnels and a test can tell which row took
       which. Equal counts would pass whatever the placement did. */
    verified: reviewers.flatMap((reviewer, index) => [
      ...Array.from({ length: index + 1 }, (_unused, ordinal) => ({
        reviewer,
        verifier_verdict: "CONFIRMED",
        issue: `a-${reviewer}-${ordinal}`,
      })),
      { reviewer, verifier_verdict: null, issue: `pending-${reviewer}` },
    ]),
    justified: [],
    rejected: reviewers.map((reviewer) => ({
      reviewer,
      verifier_verdict: "REJECTED",
      issue: `b-${reviewer}`,
    })),
    pending_verification: [],
  });
}

export function findingsRows(
  db: Db,
  sessionId: string
): Promise<StoredFindingsRow[]> {
  return db.prisma.client.$queryRawUnsafe<StoredFindingsRow[]>(
    `SELECT component_key, findings_emitted, findings_invalidated,
            findings_disposition
       FROM agent_component_invocations
      WHERE session_id = $1
      ORDER BY sequence`,
    sessionId
  );
}

export async function importWithEnvelope(
  dir: string,
  db: Db,
  sessionId: string,
  envelope: string | null,
  workerKeys?: readonly string[]
): Promise<StoredFindingsRow[]> {
  const cwd = path.join(dir, "repo");
  await mkdir(cwd, { recursive: true });
  if (envelope !== null) {
    await writeEnvelope(cwd, envelope);
  }
  await db.importer.importSession(
    reviewSession(sessionId, cwd, workerKeys),
    "claude"
  );
  return await findingsRows(db, sessionId);
}

/**
 * One reviewer, `confirmed` CONFIRMED findings and exactly one REJECTED — so
 * `emitted` is `confirmed + 1` and `invalidated` is 1.
 *
 * Distinct from {@link envelopeNaming} because the cases below need two runs
 * carrying DIFFERENT funnels: a placement bug is invisible when both slots hold
 * the same pair.
 */
export function envelopeWithConfirmedCount(
  reviewer: string,
  confirmed: number,
  padding = ""
): string {
  return JSON.stringify({
    review_id: `review-${reviewer}`,
    verified: Array.from({ length: confirmed }, (_unused, ordinal) => ({
      reviewer,
      verifier_verdict: "CONFIRMED",
      issue: `${reviewer}-confirmed-${ordinal}`,
    })),
    justified: [],
    rejected: [
      { reviewer, verifier_verdict: "REJECTED", issue: `${reviewer}-rejected` },
    ],
    pending_verification: [],
    ...(padding === "" ? {} : { note: padding }),
  });
}

/** A session that worked in two named run directories, with two subagents. */
export function twoRunSession(
  sessionId: string,
  cwd: string,
  runIds: readonly string[]
) {
  return makeSession({
    sessionId,
    cwd,
    startedAt: NOW,
    endedAt: "2026-09-26T12:30:00.000Z",
    toolUses: runIds.map((runId) => ({
      id: `toolu_${runId}`,
      providerToolUseId: `toolu_${runId}`,
      name: "Read",
      kind: "builtin" as const,
      timestamp: NOW,
      input: {
        file_path: path.join(
          cwd,
          ".closedloop-ai",
          "code-review",
          runId,
          "review_result.json"
        ),
      },
    })),
    subagents: runIds.map((_unused, index) => ({
      id: `sub-reviewer-${index + 1}`,
      name: WORKER_COMPONENT_KEY,
      type: WORKER_COMPONENT_KEY,
      normalizedName: WORKER_COMPONENT_KEY,
      rawName: WORKER_COMPONENT_KEY,
      startedAt: NOW,
    })),
  });
}

/**
 * One reviewer's two adjudicated findings padded to `entries` total entries with
 * verdict-less filler the attributor counts and never folds.
 *
 * Small in BYTES and large in ENTRIES, which is the only shape that reaches the
 * count gate without first tripping the byte gate.
 */
export function paddedEnvelope(reviewer: string, entries: number): string {
  return JSON.stringify({
    review_id: `review-${reviewer}`,
    verified: [{ reviewer, verifier_verdict: "CONFIRMED" }],
    rejected: [{ reviewer, verifier_verdict: "REJECTED" }],
    pending_verification: Array.from(
      { length: Math.max(0, entries - 2) },
      () => 0
    ),
  });
}

export async function writeRunEnvelope(
  cwd: string,
  runId: string,
  body: string
): Promise<void> {
  const runDir = path.join(cwd, ".closedloop-ai", "code-review", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "review_result.json"), body, "utf8");
}

/** A fresh temp directory for one case, named after the ticket it belongs to. */
export function locatorTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
