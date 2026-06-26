/**
 * @file pr-store.ts
 * @description SQLite persistence, extraction, and backfill for captured pull
 * requests. Combines the old pull-request-store.js, pr-extractor.js,
 * pr-parsers.js, and pr-backfill.js into a single first-party ESM module for
 * the design-system dashboard runtime.
 *
 * Schema lives in SQLITE_SCHEMA (sqlite.ts) — no schema creation here.
 * The READ functions run on the single DesktopPrisma client via typed delegates
 * (one raw GROUP BY remains in listPrSessions). FEA-1791: the write path
 * (`upsertPullRequest`) is converted onto that client — it takes a
 * `Prisma.TransactionClient` and runs its COALESCE-preserve UPDATE + INSERT on
 * `$executeRawUnsafe` (a named blocker; see the note below). The remaining
 * backfill/store helpers still use the raw SQLite async query API with
 * positional $N params until their own conversion.
 *
 * Part of CLOSEDLOOP engineer GitHub activity capture (FEA-1226).
 */

import { createHash } from "node:crypto";
import type {
  PrRecord,
  PrSessionGroup,
  PrStats,
} from "../../shared/agent-db-contract.js";
import { isRecord } from "../../shared/type-guards.js";
import type { Prisma } from "../database/generated/client.js";
import type { DesktopPrisma } from "../database/prisma-client.js";

// FEA-1791: upsertPullRequest runs inside the importer / lifecycle / sync
// `$transaction` on the single DesktopPrisma client, so it takes a
// `Prisma.TransactionClient`; its hand-written COALESCE-preserve UPDATE + the
// INSERT stay raw on `$executeRawUnsafe` (named blocker — not expressible via a
// Prisma upsert). The remaining backfill helpers stay on the raw store handle
// until their own conversion.
//
// The READ functions run on the single DesktopPrisma client via typed delegates
// (`artifact`/`sessionArtifactLink` findMany/count/groupBy, using the
// `artifactLinks`/`artifact` relation filters to express the prior
// session_artifact_links join). Only the listPrSessions OUTER query stays on
// `prisma.client.$queryRawUnsafe`: it GROUP BYs link rows while aggregating
// MAX(observed_at)/MIN(harness) off the joined artifact and pulling session
// columns — a cross-table grouped aggregation no single typed delegate expresses.

/** Every PR read scopes to artifacts of this kind. */
const PR_KIND = "pull_request";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic 16-hex id — same PR in the same session dedups to one row. */
function pullRequestId(
  harness: string,
  sessionId: string,
  prUrl: string
): string {
  return createHash("sha256")
    .update(`${harness}|${sessionId}|${prUrl}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// PR URL parsing (from pr-parsers.js)
// ---------------------------------------------------------------------------

const GITHUB_PR_URL_RE =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(?!new\b)(\d+)/g;

const FIXTURE_OWNER_RE =
  /^(?:owner|acme|org|example|test-org|sample|fixtures?|placeholder|repo)$/i;

const PENDING_COMMAND_CAP = 256;

export function isFixtureOwner(owner: string): boolean {
  return FIXTURE_OWNER_RE.test(owner);
}

type PrUrlRef = {
  prUrl: string;
  prNumber: number;
  repoFullName: string;
  owner: string;
};

export function extractPrUrlsFromText(text: unknown): PrUrlRef[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const refs: PrUrlRef[] = [];
  for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
    const owner = match[1];
    const repo = match[2];
    const prNumberRaw = match[3];
    if (!(owner && repo && prNumberRaw)) {
      continue;
    }
    if (isFixtureOwner(owner)) {
      continue;
    }
    const prNumber = Number.parseInt(prNumberRaw, 10);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      continue;
    }
    const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    if (seen.has(prUrl)) {
      continue;
    }
    seen.add(prUrl);
    refs.push({ prUrl, prNumber, repoFullName: `${owner}/${repo}`, owner });
  }
  return refs;
}

export function isPrCreateCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") {
    return false;
  }
  return /(?:^|[;&|(\n\t])\s*(?:\S+=\S+\s+)*gh\s+pr\s+create(?:$|[\s'")])/.test(
    cmd
  );
}

export function safeParseLine(line: unknown): Record<string, unknown> | null {
  if (typeof line !== "string") {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session parser state + line parser (from pr-parsers.js)
// ---------------------------------------------------------------------------

type SessionParserState = {
  claudeBashCommands: Map<string, string>;
  codexCallCommands: Map<string, string>;
  codexSessionId: string | null;
};

export function createSessionParserState(): SessionParserState {
  return {
    claudeBashCommands: new Map(),
    codexCallCommands: new Map(),
    codexSessionId: null,
  };
}

function flattenContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (isRecord(item)) {
        for (const key of ["text", "output", "content", "result"]) {
          if (typeof item[key] === "string") {
            parts.push(item[key] as string);
          }
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function rememberCommand(
  map: Map<string, string>,
  key: string,
  command: string
): void {
  map.delete(key);
  map.set(key, command);
  if (map.size > PENDING_COMMAND_CAP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

function extractCodexCommand(args: unknown): string {
  if (typeof args !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(args);
    if (isRecord(parsed) && typeof parsed.cmd === "string") {
      return parsed.cmd;
    }
  } catch {
    /* arguments not JSON — fall through */
  }
  return args;
}

function extractParsedCmd(parsedCmd: unknown): string {
  if (!Array.isArray(parsedCmd)) {
    return "";
  }
  return parsedCmd
    .map((entry: unknown) =>
      isRecord(entry) && typeof entry.cmd === "string" ? entry.cmd : ""
    )
    .filter((c: string) => c.length > 0)
    .join(" && ");
}

function extractHeadBranch(command: string): string | null {
  const match = /--head[=\s]+(\S+)/.exec(command);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Per-harness line parsers (from pr-parsers.js)
// ---------------------------------------------------------------------------

type PrDraft = {
  prUrl: string;
  prNumber: number;
  repoFullName: string;
  branchName: string | null;
  headSha: string | null;
  harness: string;
  externalSessionId: string;
  observedAt?: string;
  title?: string | null;
};

function loopEvent(
  parsed: Record<string, unknown>,
  fallbackSessionId: string
): PrDraft[] {
  const prUrl = typeof parsed.prUrl === "string" ? parsed.prUrl : null;
  if (!prUrl) {
    return [];
  }
  const refs = extractPrUrlsFromText(prUrl);
  if (refs.length === 0) {
    return [];
  }
  const ref = refs[0];
  const sessionId =
    typeof parsed.sessionId === "string" && parsed.sessionId
      ? parsed.sessionId
      : fallbackSessionId;
  return [
    {
      prUrl: ref.prUrl,
      prNumber: ref.prNumber,
      repoFullName: ref.repoFullName,
      branchName:
        typeof parsed.branchName === "string" ? parsed.branchName : null,
      headSha: typeof parsed.commitSha === "string" ? parsed.commitSha : null,
      harness: "closedloop-loop",
      externalSessionId: sessionId,
    },
  ];
}

function claudeEvents(
  parsed: Record<string, unknown>,
  fallbackSessionId: string,
  state: SessionParserState
): PrDraft[] {
  const message = isRecord(parsed.message) ? parsed.message : null;
  const content =
    message && Array.isArray(message.content) ? message.content : [];

  if (parsed.type === "assistant") {
    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== "tool_use" ||
        block.name !== "Bash"
      ) {
        continue;
      }
      const id = typeof block.id === "string" ? block.id : null;
      const input = isRecord(block.input) ? block.input : null;
      const command =
        input && typeof input.command === "string" ? input.command : "";
      if (id) {
        rememberCommand(state.claudeBashCommands, id, command);
      }
    }
    return [];
  }

  const sessionId =
    typeof parsed.sessionId === "string" && parsed.sessionId
      ? parsed.sessionId
      : fallbackSessionId;
  const events: PrDraft[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const toolUseId =
      typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    const command = toolUseId
      ? state.claudeBashCommands.get(toolUseId)
      : undefined;
    if (toolUseId) {
      state.claudeBashCommands.delete(toolUseId);
    }
    if (!isPrCreateCommand(command)) {
      continue;
    }
    const body = flattenContent(block.content);
    for (const ref of extractPrUrlsFromText(body)) {
      events.push({
        prUrl: ref.prUrl,
        prNumber: ref.prNumber,
        repoFullName: ref.repoFullName,
        branchName: null,
        headSha: null,
        harness: "claude-code",
        externalSessionId: sessionId,
      });
    }
  }
  return events;
}

function codexEventsFor(
  body: string,
  command: string,
  sessionId: string
): PrDraft[] {
  const branchName = extractHeadBranch(command);
  return extractPrUrlsFromText(body).map((ref) => ({
    prUrl: ref.prUrl,
    prNumber: ref.prNumber,
    repoFullName: ref.repoFullName,
    branchName,
    headSha: null,
    harness: "codex",
    externalSessionId: sessionId,
  }));
}

function codexEvents(
  parsed: Record<string, unknown>,
  fallbackSessionId: string,
  state: SessionParserState
): PrDraft[] {
  const payload = isRecord(parsed.payload) ? parsed.payload : null;
  if (!payload) {
    return [];
  }
  const sessionId = state.codexSessionId || fallbackSessionId;

  switch (payload.type) {
    case "function_call": {
      const callId =
        typeof payload.call_id === "string" ? payload.call_id : null;
      const command = extractCodexCommand(payload.arguments);
      if (callId) {
        rememberCommand(state.codexCallCommands, callId, command);
      }
      return [];
    }
    case "function_call_output": {
      const callId =
        typeof payload.call_id === "string" ? payload.call_id : null;
      const command = callId ? state.codexCallCommands.get(callId) : undefined;
      if (callId) {
        state.codexCallCommands.delete(callId);
      }
      if (!isPrCreateCommand(command)) {
        return [];
      }
      return codexEventsFor(
        flattenContent(payload.output),
        command || "",
        sessionId
      );
    }
    case "exec_command_end": {
      const command = extractParsedCmd(payload.parsed_cmd);
      if (!isPrCreateCommand(command)) {
        return [];
      }
      return codexEventsFor(
        flattenContent(payload.aggregated_output),
        command,
        sessionId
      );
    }
    default:
      return [];
  }
}

export function parseSessionLine(
  parsed: Record<string, unknown>,
  fallbackSessionId: string,
  state: SessionParserState
): PrDraft[] {
  if (!isRecord(parsed)) {
    return [];
  }
  switch (parsed.type) {
    case "pr-link":
      return loopEvent(parsed, fallbackSessionId);
    case "assistant":
    case "user":
      return claudeEvents(parsed, fallbackSessionId, state);
    case "event_msg":
    case "response_item":
      return codexEvents(parsed, fallbackSessionId, state);
    case "session_meta": {
      const payload = isRecord(parsed.payload) ? parsed.payload : null;
      if (payload && typeof payload.id === "string") {
        state.codexSessionId = payload.id;
      }
      return [];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Extraction: from pre-read JSONL text (from pr-extractor.js)
// ---------------------------------------------------------------------------

export function extractPullRequestsFromText(
  text: string,
  sessionId: string | null
): PrDraft[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const canonicalSessionId = typeof sessionId === "string" ? sessionId : null;
  const state = createSessionParserState();
  const observedAt = new Date().toISOString();
  const out: PrDraft[] = [];

  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    const parsed = safeParseLine(line);
    if (!parsed) {
      continue;
    }
    for (const ev of parseSessionLine(
      parsed,
      canonicalSessionId || "",
      state
    )) {
      out.push({
        prUrl: ev.prUrl,
        prNumber: ev.prNumber,
        repoFullName: ev.repoFullName,
        branchName: ev.branchName,
        headSha: ev.headSha,
        harness: ev.harness,
        externalSessionId: canonicalSessionId || ev.externalSessionId,
        observedAt,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB: upsertPullRequest
// ---------------------------------------------------------------------------

type PullRequestInput = {
  externalSessionId: string;
  prUrl: string;
  prNumber: number;
  repoFullName: string;
  branchName?: string | null;
  headSha?: string | null;
  title?: string | null;
  state?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  harness: string;
  observedAt?: string;
};

export async function upsertPullRequest(
  tx: Prisma.TransactionClient,
  pr: PullRequestInput
): Promise<{ id: string; created: boolean }> {
  const id = pullRequestId(pr.harness, pr.externalSessionId, pr.prUrl);
  const existingResult = await tx.$queryRawUnsafe<{ id: string }[]>(
    "SELECT id FROM pull_requests WHERE id = $1",
    id
  );

  if (existingResult.length > 0) {
    await tx.$executeRawUnsafe(
      // branch_name is AUTHORITATIVE from the import (not COALESCE-preserved):
      // it is the per-session head ref for a PR this session created, or null for
      // a merely-referenced PR. The import is the sole writer of this per-session
      // row, so "latest import wins" is correct AND lets a re-derive clear rows
      // mis-stamped by the prior session-branch behavior. The remaining fields
      // stay COALESCE — enrichment fills state/closed_at/merged_at later.
      `UPDATE pull_requests
         SET branch_name = $1,
             head_sha    = COALESCE(head_sha, $2),
             title       = COALESCE(title, $3),
             state       = COALESCE($4, state),
             closed_at   = COALESCE($5, closed_at),
             merged_at   = COALESCE($6, merged_at)
       WHERE id = $7`,
      pr.branchName || null,
      pr.headSha || null,
      pr.title || null,
      pr.state || null,
      pr.closedAt || null,
      pr.mergedAt || null,
      id
    );
    return { id, created: false };
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO pull_requests
       (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
        head_sha, title, state, closed_at, merged_at, harness, observed_at,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    id,
    pr.externalSessionId || null,
    pr.prUrl,
    pr.prNumber,
    pr.repoFullName,
    pr.branchName || null,
    pr.headSha || null,
    pr.title || null,
    pr.state || null,
    pr.closedAt || null,
    pr.mergedAt || null,
    pr.harness,
    pr.observedAt || nowIso(),
    nowIso()
  );
  return { id, created: true };
}

// ---------------------------------------------------------------------------
// DB: list / count / stats
// ---------------------------------------------------------------------------

type PrListFilters = {
  sessionId?: string | null;
  repo?: string | null;
  limit?: number;
  offset?: number;
};

/**
 * Shared WHERE for PR-artifact reads: always scope to PR artifacts, optionally
 * to a repo and/or a session. The `artifactLinks.some` session filter expresses
 * the prior `session_artifact_links` JOIN WITHOUT row-multiplication — each
 * artifact matches once — so it serves the list, the count, and the per-session
 * list alike, retiring both the `SELECT DISTINCT` and the `IS NOT DISTINCT FROM`
 * per-session subquery the prior raw reads used.
 */
function buildPrWhere(opts: {
  sessionId?: string | null;
  repo?: string | null;
}) {
  return {
    kind: PR_KIND,
    ...(opts.repo ? { repoFullName: opts.repo } : {}),
    ...(opts.sessionId
      ? { artifactLinks: { some: { sessionId: opts.sessionId } } }
      : {}),
  };
}

/**
 * Shared typed read for `pull_request` artifacts. `sessionId` is echoed onto
 * each DTO from the scoping value (the artifact has no session column), matching
 * the prior `SELECT sal.session_id AS session_id` / NULL-when-unscoped.
 */
async function findPrArtifacts(
  prisma: DesktopPrisma,
  opts: PrListFilters = {}
): Promise<PrRecord[]> {
  const sessionId = opts.sessionId ?? null;
  const rows = await prisma.client.artifact.findMany({
    where: buildPrWhere(opts),
    select: {
      id: true,
      url: true,
      prNumber: true,
      repoFullName: true,
      branchName: true,
      headSha: true,
      title: true,
      harness: true,
      observedAt: true,
      createdAt: true,
    },
    orderBy: { observedAt: "desc" },
    ...(opts.limit === undefined ? {} : { take: opts.limit }),
    ...(opts.offset ? { skip: opts.offset } : {}),
  });
  return rows.map((row) => ({
    id: row.id,
    sessionId,
    prUrl: row.url ?? "",
    prNumber: row.prNumber,
    repoFullName: row.repoFullName,
    branchName: row.branchName,
    headSha: row.headSha,
    title: row.title,
    harness: row.harness,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  }));
}

export function listPullRequests(
  prisma: DesktopPrisma,
  opts: PrListFilters = {}
): Promise<PrRecord[]> {
  const { limit = 100, offset = 0 } = opts;
  return findPrArtifacts(prisma, {
    sessionId: opts.sessionId,
    repo: opts.repo,
    limit,
    offset,
  });
}

export function countPullRequests(
  prisma: DesktopPrisma,
  opts: Omit<PrListFilters, "limit" | "offset"> = {}
): Promise<number> {
  // The `some` relation filter (see buildPrWhere) counts each PR artifact once,
  // so a plain `count` reproduces the prior `COUNT(DISTINCT a.id)`.
  return prisma.client.artifact.count({ where: buildPrWhere(opts) });
}

/**
 * Distinct PR repos = `COUNT(DISTINCT repo_full_name)`. groupBy yields one row
 * per distinct value; `repoFullName: { not: null }` drops the NULL group to
 * match SQL `COUNT(DISTINCT …)`, which never counts NULL.
 */
export async function countRepos(prisma: DesktopPrisma): Promise<number> {
  const groups = await prisma.client.artifact.groupBy({
    by: ["repoFullName"],
    where: { kind: PR_KIND, repoFullName: { not: null } },
  });
  return groups.length;
}

export async function getPrStats(prisma: DesktopPrisma): Promise<PrStats> {
  // Three typed counts over the in-process SQLite handle; the prior single raw
  // query only fused them via a correlated subquery for the session count.
  const totalPrs = await prisma.client.artifact.count({
    where: { kind: PR_KIND },
  });
  const repos = await countRepos(prisma);
  const sessionsWithPrs = await countSessionsWithPullRequests(prisma);
  return { totalPrs, repos, sessionsWithPrs };
}

// ---------------------------------------------------------------------------
// DB: session-grouped PR listing
// ---------------------------------------------------------------------------

export async function listPrSessions(
  prisma: DesktopPrisma,
  opts: { limit?: number; offset?: number } = {}
): Promise<PrSessionGroup[]> {
  const { limit = 100, offset = 0 } = opts;
  const groups = await prisma.client.$queryRawUnsafe<
    {
      session_id: string | null;
      session_name: string | null;
      session_started_at: string | null;
      session_cwd: string | null;
      pr_count: number;
      last_pr_at: string | null;
      harness: string | null;
    }[]
  >(
    `SELECT
       sal.session_id                        AS session_id,
       s.name                                AS session_name,
       s.started_at                          AS session_started_at,
       s.cwd                                 AS session_cwd,
       COUNT(*)                              AS pr_count,
       MAX(a.observed_at)                    AS last_pr_at,
       MIN(a.harness)                        AS harness
     FROM session_artifact_links sal
     JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'pull_request'
     LEFT JOIN sessions s ON s.id = sal.session_id
     GROUP BY sal.session_id, s.name, s.started_at, s.cwd
     ORDER BY last_pr_at DESC
     LIMIT $1 OFFSET $2`,
    limit,
    offset
  );

  const rows: PrSessionGroup[] = [];
  for (const row of groups) {
    // Per-session PR list via the same typed read the unscoped list uses. The
    // outer GROUP BY is on the NOT-NULL `sal.session_id`, so `row.session_id` is
    // always a concrete id here and the `some` filter scopes exactly to it.
    const prs = await findPrArtifacts(prisma, { sessionId: row.session_id });
    rows.push({
      sessionId: row.session_id ?? "unknown",
      sessionName: row.session_name,
      cwd: row.session_cwd,
      harness: row.harness,
      startedAt: row.session_started_at,
      prs,
    });
  }
  return rows;
}

export async function countSessionsWithPullRequests(
  prisma: DesktopPrisma
): Promise<number> {
  // COUNT(DISTINCT session_id) over links to PR artifacts → one groupBy row per
  // distinct session. `session_id` is non-null in the model, so there is no NULL
  // group to exclude.
  const groups = await prisma.client.sessionArtifactLink.groupBy({
    by: ["sessionId"],
    where: { artifact: { kind: PR_KIND } },
  });
  return groups.length;
}

export async function sessionIdsWithPullRequests(
  prisma: DesktopPrisma
): Promise<{ session_id: string; c: number }[]> {
  // Per-session link counts (the prior `COUNT(*)` per session_id over links to
  // PR artifacts). `_count._all` returns a real JS number through the typed
  // delegate — no bigint coercion needed, unlike the COUNT(*)::int the raw
  // $queryRawUnsafe path could surface.
  const groups = await prisma.client.sessionArtifactLink.groupBy({
    by: ["sessionId"],
    where: { artifact: { kind: PR_KIND } },
    _count: { _all: true },
  });
  return groups.map((g) => ({ session_id: g.sessionId, c: g._count._all }));
}
