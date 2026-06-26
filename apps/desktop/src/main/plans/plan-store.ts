/**
 * @file plan-store.ts
 * @description SQLite persistence + extraction for captured plans. Combines
 * the old plan-store.js, plan-extractor.js, and plan-backfill.js into a single
 * first-party ESM module for the design-system dashboard runtime.
 *
 * Schema lives in SQLITE_SCHEMA (sqlite.ts) — no schema creation here.
 * All DB calls use the SQLite async query API with positional $N params.
 *
 * Part of CLOSEDLOOP plan-extraction (FEA-1189 / PLN-613).
 */

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  PlanRecord,
  PlanVersionRecord,
} from "../../shared/agent-db-contract.js";
import type { DesktopPrisma } from "../database/prisma-client.js";

// The whole plan store runs on the single DesktopPrisma client. The write path
// (findExistingPlan/upsertPlan/upsertPlanVersion) keeps its hand-tuned SQL —
// null-safe lookups (IS NOT DISTINCT FROM), set-if-null COALESCE backfills, CASE
// ordering — verbatim via Prisma's raw escape hatch, run INSIDE `prisma.write`
// so the dedup read and every insert/update serialize through the shared write
// queue as one unit. `RawSqlClient` is the slice of the write-callback client
// those helpers use; confirm/reject use the typed `updateMany` delegate instead.
type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function uuid(): string {
  return randomUUID();
}

function sha256(text: string | null | undefined): string {
  return createHash("sha256")
    .update(String(text == null ? "" : text).trim())
    .digest("hex");
}

function nonEmpty(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Plan key derivation (from plan-store.js)
// ---------------------------------------------------------------------------

function firstPlanLine(markdown: string | null | undefined): string | null {
  if (typeof markdown !== "string") {
    return null;
  }
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s{0,3}#+\s*/, "").trim();
    if (line) {
      return line.slice(0, 120);
    }
  }
  return null;
}

function normalizePlanKeyPart(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized.length > 0 ? normalized : null;
}

export function planKeyFor(capture: PlanCapture): string {
  if (capture.file_path) {
    const base = String(capture.file_path)
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();
    if (base) {
      return base;
    }
  }
  const keyPart =
    normalizePlanKeyPart(firstPlanLine(capture.content_markdown)) ||
    normalizePlanKeyPart(capture.title) ||
    normalizePlanKeyPart(capture.source) ||
    "plan";
  const sessionKey = capture.created_from_session_id || "nosession";
  if (capture.harness === "codex") {
    return `${sessionKey}:codex:${keyPart}`;
  }
  return `${sessionKey}:${keyPart}`;
}

// ---------------------------------------------------------------------------
// Title extraction (from plan-extractor.js)
// ---------------------------------------------------------------------------

export function titleFromMarkdown(
  markdown: string | null | undefined,
  fallback: string
): string {
  if (typeof markdown === "string") {
    for (const rawLine of markdown.split("\n", 40)) {
      const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(rawLine);
      if (m?.[1].trim()) {
        return m[1].trim().slice(0, 200);
      }
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Plan file path detection (from plan-extractor.js)
// ---------------------------------------------------------------------------

function basenameNoExt(filePath: string | null | undefined): string | null {
  if (typeof filePath !== "string") {
    return null;
  }
  const base = filePath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  if (!base) {
    return null;
  }
  return base.replace(/\.mdx?$/i, "");
}

// ---------------------------------------------------------------------------
// PlanCapture shape (the normalized object that all extraction paths emit)
// ---------------------------------------------------------------------------

export type PlanCapture = {
  harness: string;
  source: string;
  capture_method: string;
  created_from_session_id: string | null;
  title: string;
  file_path: string | null;
  source_log_path: string | null;
  content_markdown: string;
  content_sha256: string;
  confidence: number;
  needs_confirmation: boolean;
  source_event_ref: string | null;
  captured_at: string | null;
};

export function makeCapture(opts: {
  harness: string;
  source: string;
  captureMethod: string;
  sessionId: string | null;
  content: string | null | undefined;
  filePath?: string | null;
  sourceLogPath?: string | null;
  confidence: number;
  sourceEventRef?: string | null;
  capturedAt?: string | null;
}): PlanCapture {
  const contentMarkdown = String(opts.content == null ? "" : opts.content);
  const title = titleFromMarkdown(
    contentMarkdown,
    basenameNoExt(opts.filePath ?? null) || `Plan (${opts.source})`
  );
  return {
    harness: opts.harness,
    source: opts.source,
    capture_method: opts.captureMethod,
    created_from_session_id: opts.sessionId || null,
    title,
    file_path: opts.filePath ?? null,
    source_log_path: opts.sourceLogPath ?? null,
    content_markdown: contentMarkdown,
    content_sha256: sha256(contentMarkdown),
    confidence: opts.confidence,
    needs_confirmation: opts.confidence < 0.9,
    source_event_ref: opts.sourceEventRef ?? null,
    captured_at: opts.capturedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Extraction: from ~/.claude/plans/ directory (file capture)
// ---------------------------------------------------------------------------

export function extractPlansFromPlansDir(plansDir: string): PlanCapture[] {
  const out: PlanCapture[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(plansDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!(ent.isFile() && /\.mdx?$/i.test(ent.name))) {
      continue;
    }
    const fp = join(plansDir, ent.name);
    let content: string;
    let capturedAt: string | null = null;
    try {
      content = readFileSync(fp, "utf8");
      capturedAt = new Date(statSync(fp).mtimeMs).toISOString();
    } catch {
      continue;
    }
    if (!nonEmpty(content)) {
      continue;
    }
    out.push(
      makeCapture({
        harness: "claude",
        source: "claude-plan-file",
        captureMethod: "file",
        sessionId: null,
        content,
        filePath: fp,
        confidence: 1.0,
        sourceEventRef: `plansdir:${ent.name}`,
        capturedAt,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB: find existing plan row
// ---------------------------------------------------------------------------

interface PlanRow extends Record<string, unknown> {
  id: string;
  plan_key: string | null;
  title: string | null;
  status: string;
  source: string | null;
  capture_method: string | null;
  harness: string | null;
  created_from_session_id: string | null;
  file_path: string | null;
  source_log_path: string | null;
  needs_confirmation: boolean;
  confidence: number;
  created_at: string | null;
  updated_at: string | null;
  latest_content?: string | null;
  version_count?: number | null;
}

async function findExistingPlan(
  client: RawSqlClient,
  capture: PlanCapture,
  planKey: string
): Promise<PlanRow | null> {
  const harness = capture.harness || null;
  const sessionId = capture.created_from_session_id || null;

  if (capture.file_path) {
    const rows = await client.$queryRawUnsafe<PlanRow[]>(
      `SELECT * FROM plans
       WHERE harness IS NOT DISTINCT FROM $1 AND plan_key = $2
         AND (file_path = $3 OR file_path IS NULL)
       ORDER BY CASE WHEN file_path = $4 THEN 0 ELSE 1 END,
                CASE WHEN created_from_session_id IS NULL THEN 1 ELSE 0 END,
                updated_at DESC
       LIMIT 1`,
      harness,
      planKey,
      capture.file_path,
      capture.file_path
    );
    return rows[0] ?? null;
  }

  const rows = await client.$queryRawUnsafe<PlanRow[]>(
    `SELECT * FROM plans
     WHERE harness IS NOT DISTINCT FROM $1
       AND created_from_session_id IS NOT DISTINCT FROM $2
       AND plan_key = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    harness,
    sessionId,
    planKey
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// DB: upsertPlan (upsertPlanCapture)
// ---------------------------------------------------------------------------

type UpsertPlanResult = {
  planId: string;
  versionId: string | null;
  version: number;
  deduped: boolean;
  created: boolean;
};

export function upsertPlan(
  prisma: DesktopPrisma,
  capture: PlanCapture
): Promise<UpsertPlanResult> {
  const planKey = planKeyFor(capture);
  const sessionId = capture.created_from_session_id || null;
  const ts = capture.captured_at || nowIso();

  // One serialized write unit: the dedup read plus every insert/update run on
  // the same client inside the write queue, so nothing interleaves between the
  // "is this a duplicate?" check and the writes that depend on it.
  return prisma.write(async (c) => {
    const existingPlan = await findExistingPlan(c, capture, planKey);

    let planId: string;
    let created = false;

    if (existingPlan) {
      planId = existingPlan.id;
      const latestRows = await c.$queryRawUnsafe<
        { content_sha256: string; version_number: number }[]
      >(
        `SELECT content_sha256, version_number
         FROM plan_versions WHERE plan_id = $1
         ORDER BY version_number DESC LIMIT 1`,
        planId
      );
      const latest = latestRows[0] ?? null;

      if (latest && latest.content_sha256 === capture.content_sha256) {
        // Identical content — no-op for versioning, backfill links if missing.
        if (capture.file_path || capture.source_log_path) {
          await c.$executeRawUnsafe(
            `UPDATE plans
               SET created_from_session_id = COALESCE(created_from_session_id, $1),
                   file_path = COALESCE(file_path, $2),
                   source_log_path = COALESCE(source_log_path, $3)
             WHERE id = $4`,
            sessionId,
            capture.file_path || null,
            capture.source_log_path || null,
            planId
          );
        } else if (sessionId) {
          await c.$executeRawUnsafe(
            `UPDATE plans
               SET created_from_session_id = COALESCE(created_from_session_id, $1)
             WHERE id = $2`,
            sessionId,
            planId
          );
        }
        return {
          planId,
          versionId: null,
          version: Number(latest.version_number),
          deduped: true,
          created: false,
        };
      }
    } else {
      planId = uuid();
      await c.$executeRawUnsafe(
        `INSERT INTO plans
          (id, title, status, source,
           capture_method, harness, created_from_session_id, created_from_event_id,
           plan_key, file_path, source_log_path, needs_confirmation, confidence,
           sync_state, metadata, created_at, updated_at)
         VALUES ($1, $2, 'active', 'captured', $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'local_only', NULL, $12, $13)`,
        planId,
        capture.title || null,
        capture.capture_method || null,
        capture.harness || null,
        sessionId,
        capture.source_event_ref || null,
        planKey,
        capture.file_path || null,
        capture.source_log_path || null,
        capture.needs_confirmation,
        capture.confidence,
        ts,
        ts
      );
      created = true;
    }

    // Determine next version number
    const nextRows = await c.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COALESCE(MAX(version_number), 0) AS n
       FROM plan_versions WHERE plan_id = $1`,
      planId
    );
    const versionNumber = Number(nextRows[0]?.n ?? 0) + 1;
    const versionId = uuid();

    await c.$executeRawUnsafe(
      `INSERT INTO plan_versions
        (id, plan_id, version_number, content_markdown, content_json,
         content_sha256, author_type, author_user_id, source_session_id,
         source_event_ref, capture_method, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5, 'agent', NULL, $6, $7, $8, $9)`,
      versionId,
      planId,
      versionNumber,
      capture.content_markdown,
      capture.content_sha256,
      sessionId,
      capture.source_event_ref || null,
      capture.capture_method || null,
      ts
    );

    // Refresh the plan's latest-capture signals.
    await c.$executeRawUnsafe(
      `UPDATE plans
         SET title = COALESCE($1, title),
             capture_method = COALESCE($2, capture_method),
             harness = COALESCE($3, harness),
             created_from_session_id = COALESCE(created_from_session_id, $4),
             file_path = COALESCE($5, file_path),
             source_log_path = COALESCE($6, source_log_path),
             needs_confirmation = $7,
             confidence = $8,
             updated_at = $9
       WHERE id = $10`,
      capture.title || null,
      capture.capture_method || null,
      capture.harness || null,
      sessionId,
      capture.file_path || null,
      capture.source_log_path || null,
      capture.needs_confirmation,
      capture.confidence,
      ts,
      planId
    );

    return {
      planId,
      versionId,
      version: versionNumber,
      deduped: false,
      created,
    };
  });
}

// ---------------------------------------------------------------------------
// DB: upsertPlanVersion
// ---------------------------------------------------------------------------

export type PlanVersionInput = {
  plan_id: string;
  content_markdown: string;
  content_sha256?: string;
  author_type?: string;
  author_user_id?: string | null;
  source_session_id?: string | null;
  source_event_ref?: string | null;
  capture_method?: string | null;
};

export function upsertPlanVersion(
  prisma: DesktopPrisma,
  version: PlanVersionInput
): Promise<{ versionId: string; versionNumber: number; deduped: boolean }> {
  const contentSha = version.content_sha256 ?? sha256(version.content_markdown);

  // One serialized write unit: dedup read + insert + updated_at refresh.
  return prisma.write(async (c) => {
    const latestRows = await c.$queryRawUnsafe<
      { content_sha256: string; version_number: number }[]
    >(
      `SELECT content_sha256, version_number
       FROM plan_versions WHERE plan_id = $1
       ORDER BY version_number DESC LIMIT 1`,
      version.plan_id
    );
    const latest = latestRows[0] ?? null;
    if (latest && latest.content_sha256 === contentSha) {
      return {
        versionId: "",
        versionNumber: Number(latest.version_number),
        deduped: true,
      };
    }

    const versionNumber = Number(latest?.version_number ?? 0) + 1;
    const versionId = uuid();
    const ts = nowIso();

    await c.$executeRawUnsafe(
      `INSERT INTO plan_versions
        (id, plan_id, version_number, content_markdown, content_json,
         content_sha256, author_type, author_user_id, source_session_id,
         source_event_ref, capture_method, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11)`,
      versionId,
      version.plan_id,
      versionNumber,
      version.content_markdown,
      contentSha,
      version.author_type ?? "agent",
      version.author_user_id ?? null,
      version.source_session_id ?? null,
      version.source_event_ref ?? null,
      version.capture_method ?? null,
      ts
    );

    // Refresh the plan's updated_at timestamp.
    await c.$executeRawUnsafe(
      "UPDATE plans SET updated_at = $1 WHERE id = $2",
      ts,
      version.plan_id
    );

    return { versionId, versionNumber, deduped: false };
  });
}

// ---------------------------------------------------------------------------
// DB: list / get / count
// ---------------------------------------------------------------------------

type PlanListFilters = {
  sessionId?: string | null;
  needsConfirmation?: boolean | null;
  limit?: number;
  offset?: number;
};

/**
 * Map a Prisma `plan` row (with its latest version + version count included)
 * to the renderer `PlanRecord` DTO. Replaces the old snake_case row mapper —
 * Prisma already returns camelCase via @map.
 */
function planRecordFromModel(plan: {
  id: string;
  title: string | null;
  status: string;
  source: string | null;
  captureMethod: string | null;
  harness: string | null;
  createdFromSessionId: string | null;
  filePath: string | null;
  sourceLogPath: string | null;
  needsConfirmation: boolean;
  confidence: number;
  createdAt: string | null;
  updatedAt: string | null;
  versions: { contentMarkdown: string | null }[];
  _count: { versions: number };
}): PlanRecord {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    source: plan.source,
    captureMethod: plan.captureMethod,
    harness: plan.harness,
    sessionId: plan.createdFromSessionId,
    filePath: plan.filePath,
    sourceLogPath: plan.sourceLogPath,
    needsConfirmation: plan.needsConfirmation,
    confidence: plan.confidence,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    latestContent: plan.versions[0]?.contentMarkdown ?? null,
    versionCount: plan._count.versions,
  };
}

export async function listPlans(
  prisma: DesktopPrisma,
  opts: PlanListFilters = {}
): Promise<PlanRecord[]> {
  const { limit = 100, offset = 0 } = opts;
  const rows = await prisma.client.plan.findMany({
    where: {
      ...(opts.sessionId ? { createdFromSessionId: opts.sessionId } : {}),
      ...(typeof opts.needsConfirmation === "boolean"
        ? { needsConfirmation: opts.needsConfirmation }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    skip: offset,
    // Inline include (not a shared const) so Prisma infers `versions`/`_count`
    // onto the result type.
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: { contentMarkdown: true },
      },
      _count: { select: { versions: true } },
    },
  });
  return rows.map(planRecordFromModel);
}

export async function getPlanVersions(
  prisma: DesktopPrisma,
  planId: string
): Promise<PlanVersionRecord[]> {
  const rows = await prisma.client.planVersion.findMany({
    where: { planId },
    orderBy: { versionNumber: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    planId: row.planId,
    versionNumber: row.versionNumber,
    contentMarkdown: row.contentMarkdown,
    contentSha256: row.contentSha256,
    authorType: row.authorType,
    captureMethod: row.captureMethod,
    createdAt: row.createdAt,
  }));
}

export async function getPlan(
  prisma: DesktopPrisma,
  id: string
): Promise<PlanRecord | null> {
  const plan = await prisma.client.plan.findUnique({
    where: { id },
    include: {
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: { contentMarkdown: true },
      },
      _count: { select: { versions: true } },
    },
  });
  return plan ? planRecordFromModel(plan) : null;
}

// ---------------------------------------------------------------------------
// DB: confirm / reject
// ---------------------------------------------------------------------------

// confirm/reject are single-statement UPDATEs, so they use the typed
// `updateMany` delegate (cleaner than raw) — still routed through `prisma.write`
// like the rest of the plan write path, so all plan writes share one
// serialization domain. `updateMany().count` preserves the prior
// `affectedRows > 0` "did a row match?" boolean.

export async function confirmPlan(
  prisma: DesktopPrisma,
  id: string
): Promise<boolean> {
  const result = await prisma.write((c) =>
    c.plan.updateMany({
      where: { id },
      data: {
        needsConfirmation: false,
        status: "confirmed",
        updatedAt: nowIso(),
      },
    })
  );
  return result.count > 0;
}

export async function rejectPlan(
  prisma: DesktopPrisma,
  id: string
): Promise<boolean> {
  const result = await prisma.write((c) =>
    c.plan.updateMany({
      where: { id },
      data: {
        needsConfirmation: false,
        status: "rejected",
        updatedAt: nowIso(),
      },
    })
  );
  return result.count > 0;
}
