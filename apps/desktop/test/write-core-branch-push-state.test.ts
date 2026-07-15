import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ArtifactRefRecord } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { persistArtifactLinks } from "../src/main/database/write-core.js";
import { openTestDb } from "./agent-db-test-utils.js";

// FEA-2531: persistArtifactLinks stamps set-once, earliest-wins push state on the
// canonical artifacts row (never the reparse-wiped link row) for push-method
// branch links. These tests exercise the real SQLite MIN()/COALESCE marker.

const REPO = "closedloop-ai/symphony-alpha";
const NOW = "2026-06-07T12:00:00.000Z";
const DROPPED_REF_WARNING = /dropped artifact ref for session missing-session/;
const BATCH_FALLBACK_WARNING =
  /batched upsert failed for session missing-session/;

function branchRef(input: {
  branchName: string;
  method: string;
  observedAt: string;
  relation?: ArtifactRefRecord["relation"];
}): ArtifactRefRecord {
  return {
    targetKind: "branch",
    targetIdentity: `${REPO}:${input.branchName}`,
    relation: input.relation ?? "created",
    method: input.method,
    evidence: "{}",
    observedAt: input.observedAt,
    confidence: "url_match",
    extractorVersion: 7,
    isPrimary: false,
    repoFullName: REPO,
    branchName: input.branchName,
  };
}

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

async function insertSession(db: TestDb, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
    sessionId,
    NOW
  );
}

async function persist(
  db: TestDb,
  sessionId: string,
  refs: ArtifactRefRecord[]
): Promise<void> {
  await db.prisma.write((client) =>
    client.$transaction((tx) =>
      persistArtifactLinks(tx, sessionId, refs, NOW, () => {
        // These push-state/PR-head tests exercise the happy path; no warning is
        // expected, so the required logger is a no-op here.
      })
    )
  );
}

async function readPushState(
  db: TestDb,
  branchName: string
): Promise<{ first_pushed_at: string | null; push_source: string | null }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { first_pushed_at: string | null; push_source: string | null }[]
  >(
    "SELECT first_pushed_at, push_source FROM artifacts WHERE kind = 'branch' AND branch_name = $1",
    branchName
  );
  if (rows.length !== 1) {
    throw new Error(`expected one branch artifact for ${branchName}`);
  }
  return rows[0];
}

test("push-method branch link sets first_pushed_at + push_source='session', earliest push wins, later never advances, reparse is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-push-state-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "push-a");
    await insertSession(db, "push-b");

    // First push at T2 stamps the marker.
    await persist(db, "push-a", [
      branchRef({
        branchName: "feat/x",
        method: "git_push",
        observedAt: "2026-06-07T12:02:00.000Z",
      }),
    ]);
    let state = await readPushState(db, "feat/x");
    assert.equal(state.first_pushed_at, "2026-06-07T12:02:00.000Z");
    assert.equal(state.push_source, "session");

    // An EARLIER push from another session rewinds first_pushed_at.
    await persist(db, "push-b", [
      branchRef({
        branchName: "feat/x",
        method: "git_push",
        observedAt: "2026-06-07T12:01:00.000Z",
      }),
    ]);
    state = await readPushState(db, "feat/x");
    assert.equal(state.first_pushed_at, "2026-06-07T12:01:00.000Z");
    assert.equal(state.push_source, "session");

    // A LATER push does not advance the earliest-wins marker.
    await persist(db, "push-a", [
      branchRef({
        branchName: "feat/x",
        method: "gh_pr_create",
        observedAt: "2026-06-07T12:09:00.000Z",
      }),
    ]);
    state = await readPushState(db, "feat/x");
    assert.equal(state.first_pushed_at, "2026-06-07T12:01:00.000Z");

    // Reparse: delete the session's links (as importPhaseArtifactLinks does) and
    // re-persist the same refs. The artifacts marker must survive unchanged.
    await db.run(
      "DELETE FROM session_artifact_links WHERE session_id = $1",
      "push-b"
    );
    await persist(db, "push-b", [
      branchRef({
        branchName: "feat/x",
        method: "git_push",
        observedAt: "2026-06-07T12:01:00.000Z",
      }),
    ]);
    state = await readPushState(db, "feat/x");
    assert.equal(state.first_pushed_at, "2026-06-07T12:01:00.000Z");
    assert.equal(state.push_source, "session");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FEA-2788: a swallowed row-level upsert failure emits one warning per dropped ref instead of failing silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-swallow-log-"));
  const db = await openTestDb(dir);
  try {
    // No `sessions` row is inserted, so the session_artifact_links FK to
    // sessions(id) rejects every link insert: the batched path throws and the
    // row-by-row fallback then fails one link upsert per ref. Each swallowed ref
    // must now emit a warning through the threaded logger — previously the catch
    // was empty, so links vanished from the Branches surface with no telemetry.
    const warnings: string[] = [];
    const refs = [
      branchRef({
        branchName: "feat/orphan-a",
        method: "git_push",
        observedAt: NOW,
      }),
      branchRef({
        branchName: "feat/orphan-b",
        method: "git_push",
        observedAt: NOW,
      }),
    ];
    const { captured } = await db.prisma.write((client) =>
      client.$transaction((tx) =>
        persistArtifactLinks(tx, "missing-session", refs, NOW, (msg) =>
          warnings.push(msg)
        )
      )
    );
    // Nothing persisted. Telemetry surfaces the systematic failure twice over:
    // once when the batched fast path throws and falls back, then once per ref
    // the row-by-row fallback also has to drop — each naming the session so it
    // is traceable.
    assert.equal(captured, 0);
    const batchWarnings = warnings.filter((w) =>
      BATCH_FALLBACK_WARNING.test(w)
    );
    const droppedWarnings = warnings.filter((w) => DROPPED_REF_WARNING.test(w));
    assert.equal(batchWarnings.length, 1);
    assert.equal(droppedWarnings.length, refs.length);
    assert.equal(
      warnings.length,
      batchWarnings.length + droppedWarnings.length
    );
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit-only branch link never sets push state (marker stays null)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-commit-only-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "commit-only");
    await persist(db, "commit-only", [
      branchRef({
        branchName: "feat/commit-only",
        method: "git_commit",
        observedAt: "2026-06-07T12:03:00.000Z",
      }),
    ]);
    const state = await readPushState(db, "feat/commit-only");
    assert.equal(state.first_pushed_at, null);
    assert.equal(state.push_source, null);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FEA-2531 (v9): created-PR head refs re-derived by the BACKFILL must reach
// pull_requests.branch_name — the import path writes them via
// persistNormalizedPullRequests, but historical re-derivation flows only
// through persistArtifactLinks, and the Branches page joins branch↔PR on
// pull_requests.branch_name. Fill-only: never clobber an existing value.
// ---------------------------------------------------------------------------

const PR_URL = `https://github.com/${REPO}/pull/2302`;

function createdPrRef(input: {
  branchName?: string;
  relation?: ArtifactRefRecord["relation"];
}): ArtifactRefRecord {
  return {
    targetKind: "pull_request",
    targetIdentity: `${REPO}#2302`,
    relation: input.relation ?? "created",
    method:
      input.relation === "referenced"
        ? "pr_url_in_tool_use"
        : "pr_create_output",
    evidence: "{}",
    observedAt: NOW,
    confidence: "url_match",
    extractorVersion: 9,
    isPrimary: false,
    repoFullName: REPO,
    prNumber: 2302,
    prUrl: PR_URL,
    branchName: input.branchName,
  };
}

async function insertPullRequestRow(
  db: TestDb,
  sessionId: string,
  branchName: string | null
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
        harness, observed_at, created_at)
     VALUES ($1, $2, $3, 2302, $4, $5, 'claude', $6, $6)`,
    `pr-row-${sessionId}`,
    sessionId,
    PR_URL,
    REPO,
    branchName,
    NOW
  );
}

async function readPrBranch(
  db: TestDb,
  sessionId: string
): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { branch_name: string | null }[]
  >(
    "SELECT branch_name FROM pull_requests WHERE session_id = $1 AND pr_url = $2",
    sessionId,
    PR_URL
  );
  if (rows.length !== 1) {
    throw new Error(`expected one pull_requests row for ${sessionId}`);
  }
  return rows[0].branch_name;
}

test("backfill fills a null pull_requests.branch_name from the re-derived created-PR head ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-pr-head-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "worktree-creator");
    await insertPullRequestRow(db, "worktree-creator", null);
    await persist(db, "worktree-creator", [
      createdPrRef({ branchName: "feat/fea-2430" }),
    ]);
    assert.equal(await readPrBranch(db, "worktree-creator"), "feat/fea-2430");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fill-only: an existing pull_requests.branch_name is never clobbered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-pr-head-keep-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "already-attributed");
    await insertPullRequestRow(db, "already-attributed", "feat/enriched-truth");
    await persist(db, "already-attributed", [
      createdPrRef({ branchName: "feat/rederived-differs" }),
    ]);
    assert.equal(
      await readPrBranch(db, "already-attributed"),
      "feat/enriched-truth"
    );
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("referenced PR refs and headless/default-branch created refs never fill", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-pr-head-skip-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "referencer");
    await insertPullRequestRow(db, "referencer", null);
    await persist(db, "referencer", [
      createdPrRef({ relation: "referenced", branchName: "feat/not-mine" }),
      createdPrRef({ branchName: undefined }),
      createdPrRef({ branchName: "main" }),
    ]);
    assert.equal(await readPrBranch(db, "referencer"), null);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another session's pull_requests row for the same PR is untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "write-core-pr-head-scope-"));
  const db = await openTestDb(dir);
  try {
    await insertSession(db, "creator");
    await insertSession(db, "bystander");
    await insertPullRequestRow(db, "creator", null);
    await insertPullRequestRow(db, "bystander", null);
    await persist(db, "creator", [
      createdPrRef({ branchName: "feat/fea-2430" }),
    ]);
    assert.equal(await readPrBranch(db, "creator"), "feat/fea-2430");
    assert.equal(await readPrBranch(db, "bystander"), null);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
