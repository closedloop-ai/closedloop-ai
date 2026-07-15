import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import type { Prisma, PrismaClient } from "../database/generated/client.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import {
  CODEX_OTEL_MAX_ATTRIBUTE_COUNT,
  CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH,
  CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH,
  CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT,
  CODEX_OTEL_MAX_SPAN_NAME_LENGTH,
  CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH,
  type CodexOtelBatch,
  type CodexOtelSpan,
  CodexOtelTokenUsageSource,
} from "./codex-otel-contract.js";

type CodexOtelTokenUsage = CodexOtelBatch["tokenUsage"][number];

export type PersistCodexOtelBatchOptions = {
  prisma: DesktopPrisma;
  batch: CodexOtelBatch;
  now: string;
};

export async function persistCodexOtelBatch(
  options: PersistCodexOtelBatchOptions
): Promise<void> {
  const { batch, now } = options;
  if (batch.spans.length === 0 && batch.tokenUsage.length === 0) {
    return;
  }

  // One atomic batch on the single Prisma client, serialized through the shared
  // write queue (mirrors otel/claude-code-persistence.ts). Op ORDER is
  // load-bearing: codex_trace_span.session_id and token_usage.session_id both FK
  // to sessions.id (ON DELETE CASCADE), so the minimal session rows must be
  // upserted before the spans/usage that reference them. `$transaction([...])`
  // executes the array sequentially, preserving that order, and rolls the whole
  // batch back if any operation throws.
  await options.prisma.write((client) => {
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    for (const [sessionId, startedAt] of getSessionStartTimes(batch)) {
      operations.push(
        minimalCodexSessionUpsert(client, sessionId, startedAt, now)
      );
    }
    for (const span of batch.spans) {
      operations.push(codexTraceSpanUpsert(client, span, now));
    }
    for (const usage of batch.tokenUsage) {
      operations.push(tokenUsageUpsert(client, usage, now));
    }
    return client.$transaction(operations);
  });
}

function tokenUsageUpsert(
  client: PrismaClient,
  usage: CodexOtelTokenUsage,
  now: string
): Prisma.PrismaPromise<number> {
  // RAW (named blocker: `created_at = MIN(existing, excluded)` merge). The DO
  // UPDATE keeps the earliest created_at across re-ingests — a min-merge that
  // reads the existing row, which a Prisma `upsert` update cannot express. Runs
  // on the one client inside `write`.
  return client.$executeRawUnsafe(
    `
        INSERT INTO token_usage (
          session_id, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          raw_input, raw_output, raw_cache_read, raw_cache_write,
          usage_source, revision_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (session_id, model) DO UPDATE SET
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          cache_write_tokens = EXCLUDED.cache_write_tokens,
          raw_input = EXCLUDED.raw_input,
          raw_output = EXCLUDED.raw_output,
          raw_cache_read = EXCLUDED.raw_cache_read,
          raw_cache_write = EXCLUDED.raw_cache_write,
          usage_source = EXCLUDED.usage_source,
          revision_id = EXCLUDED.revision_id,
          created_at = MIN(token_usage.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at
      `,
    usage.sessionId,
    usage.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    CodexOtelTokenUsageSource.OtelLogPayload,
    DATA_REVISION,
    usage.observedAt,
    now
  );
}

export function sanitizeCodexOtelAttributes(
  attributes: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const redactedAttributes: string[] = [];
  const attributeEntries = Object.entries(attributes).slice(
    0,
    CODEX_OTEL_MAX_ATTRIBUTE_COUNT
  );
  for (const [key, value] of attributeEntries) {
    if (key.length > CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH) {
      continue;
    }
    if (isSensitiveAttribute(key)) {
      if (
        redactedAttributes.length < CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT &&
        hasNonEmptySensitiveValue(value)
      ) {
        redactedAttributes.push(key);
      }
      continue;
    }
    const storableValue = toStorableAttributeValue(value);
    if (ALLOWED_ATTRIBUTE_KEYS.has(key) && storableValue !== undefined) {
      sanitized[key] = storableValue;
    }
  }
  if (redactedAttributes.length > 0) {
    sanitized[REDACTED_ATTRIBUTES_KEY] = redactedAttributes.sort();
  }
  return sanitized;
}

export const CODEX_TRACE_SPAN_TABLE = "codex_trace_span";
export const REDACTED_ATTRIBUTES_KEY = "closedloop.redacted_attributes";
export const REDACTED_SPAN_NAME = "codex.otel.span";
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.system",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "code.function.name",
  "tool.name",
  "codex.tool.name",
  "session.id",
  "otel.trace_id",
  "otel.span_id",
] as const);

const CODEX_HARNESS = "codex";
const ACTIVE_SESSION_STATUS = "active";
const UNKNOWN_BILLING_MODE = "unknown";
const SENSITIVE_ATTRIBUTE_RE =
  /(^|[._-])(prompt|completion|body|env|environment|header|token|key|secret|password|authorization|input|output)([._-]|$)/i;
const SENSITIVE_FREEFORM_TEXT_RE =
  /(^|[\s._-])(prompt|completion|body|env|environment|header|token|key|secret|password|authorization|input|output)(\s*[:=]|[\s._-]|$)/i;

function getSessionStartTimes(batch: CodexOtelBatch): Map<string, string> {
  const starts = new Map<string, string>();
  for (const span of batch.spans) {
    setEarliest(starts, span.sessionId, span.startTime);
  }
  for (const usage of batch.tokenUsage) {
    setEarliest(starts, usage.sessionId, usage.observedAt);
  }
  return starts;
}

function setEarliest(
  starts: Map<string, string>,
  sessionId: string,
  timestamp: string
): void {
  const existing = starts.get(sessionId);
  if (!(existing && Date.parse(existing) <= Date.parse(timestamp))) {
    starts.set(sessionId, timestamp);
  }
}

function minimalCodexSessionUpsert(
  client: PrismaClient,
  sessionId: string,
  startedAt: string,
  now: string
): Prisma.PrismaPromise<number> {
  // RAW (named blocker: conditional ON CONFLICT). The DO UPDATE merges each
  // column via CASE/COALESCE expressions that read the EXISTING row — keep the
  // first non-empty harness, heal billing_mode away from 'unknown', keep the
  // earliest started_at, and advance updated_at monotonically — none of which a
  // Prisma `upsert` update can express. Runs on the one client inside `write`.
  return client.$executeRawUnsafe(
    `
      INSERT INTO sessions (
        id, name, status, cwd, model, started_at, updated_at, ended_at,
        harness, billing_mode, metadata, data_revision
      )
      VALUES ($1, NULL, $2, NULL, NULL, $3, $4, NULL, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        harness = CASE
          WHEN COALESCE(sessions.harness, '') = '' THEN EXCLUDED.harness
          ELSE sessions.harness
        END,
        billing_mode = CASE
          WHEN COALESCE(sessions.billing_mode, '') IN ('', $6) THEN EXCLUDED.billing_mode
          ELSE sessions.billing_mode
        END,
        started_at = COALESCE(sessions.started_at, EXCLUDED.started_at),
        updated_at = CASE
          WHEN sessions.updated_at IS NULL OR sessions.updated_at < EXCLUDED.updated_at
          THEN EXCLUDED.updated_at
          ELSE sessions.updated_at
        END
    `,
    sessionId,
    ACTIVE_SESSION_STATUS,
    startedAt,
    now,
    CODEX_HARNESS,
    UNKNOWN_BILLING_MODE,
    JSON.stringify({ source: "codex_otel" }),
    DATA_REVISION
  );
}

function codexTraceSpanUpsert(
  client: PrismaClient,
  span: CodexOtelSpan,
  now: string
): Prisma.PrismaPromise<unknown> {
  // TYPED: a plain full-column overwrite on the @@id([traceId, spanId]) key —
  // the DO UPDATE copies every non-key column from EXCLUDED, which is exactly a
  // Prisma `upsert` with matching create/update payloads.
  const fields = {
    parentSpanId: span.parentSpanId ?? null,
    sessionId: span.sessionId,
    name: sanitizePersistedCodexOtelText(
      span.name,
      CODEX_OTEL_MAX_SPAN_NAME_LENGTH,
      REDACTED_SPAN_NAME
    ),
    startTime: span.startTime,
    endTime: span.endTime,
    durationMs: span.durationMs,
    status: span.status,
    statusMessage: sanitizeOptionalCodexOtelText(
      span.statusMessage,
      CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH
    ),
    toolName: resolveToolName(span),
    attributes: toJsonInput(sanitizeCodexOtelAttributes(span.attributes)),
    resourceAttributes: toJsonInput(
      sanitizeCodexOtelAttributes(span.resourceAttributes)
    ),
    receivedAt: now,
    revisionId: DATA_REVISION,
  };
  return client.codexTraceSpan.upsert({
    where: {
      traceId_spanId: { traceId: span.traceId, spanId: span.spanId },
    },
    create: { traceId: span.traceId, spanId: span.spanId, ...fields },
    update: fields,
  });
}

/**
 * Round-trips a sanitized attribute record into a Prisma JSON input value (the
 * codebase idiom for dynamic Json columns; see packs/catalog-store.ts). The
 * record already holds only JSON-safe scalars/arrays from
 * {@link sanitizeCodexOtelAttributes}, so the round-trip just satisfies the
 * `Prisma.InputJsonValue` type without changing the stored shape.
 */
function toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isSensitiveAttribute(key: string): boolean {
  return SENSITIVE_ATTRIBUTE_RE.test(key);
}

function resolveToolName(span: CodexOtelSpan): string | null {
  if (span.toolName) {
    return sanitizeOptionalCodexOtelText(
      span.toolName,
      CODEX_OTEL_MAX_SPAN_NAME_LENGTH
    );
  }
  const codexToolName = span.attributes["codex.tool.name"];
  if (typeof codexToolName === "string" && codexToolName.length > 0) {
    return sanitizeOptionalCodexOtelText(
      codexToolName,
      CODEX_OTEL_MAX_SPAN_NAME_LENGTH
    );
  }
  const toolName = span.attributes["tool.name"];
  if (typeof toolName === "string" && toolName.length > 0) {
    return sanitizeOptionalCodexOtelText(
      toolName,
      CODEX_OTEL_MAX_SPAN_NAME_LENGTH
    );
  }
  return null;
}

function hasNonEmptySensitiveValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return value != null;
}

function toStorableAttributeValue(value: unknown): unknown {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value.slice(0, CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function sanitizeOptionalCodexOtelText(
  value: string | undefined,
  maxLength: number
): string | null {
  if (!value) {
    return null;
  }
  const sanitized = sanitizePersistedCodexOtelText(value, maxLength, null);
  return sanitized;
}

// A non-null fallback guarantees a non-null result (used for the required
// `name` column); a null fallback may return null (optional text columns).
function sanitizePersistedCodexOtelText(
  value: string,
  maxLength: number,
  sensitiveFallback: string
): string;
function sanitizePersistedCodexOtelText(
  value: string,
  maxLength: number,
  sensitiveFallback: null
): string | null;
function sanitizePersistedCodexOtelText(
  value: string,
  maxLength: number,
  sensitiveFallback: string | null
): string | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return sensitiveFallback;
  }
  if (SENSITIVE_FREEFORM_TEXT_RE.test(trimmedValue)) {
    return sensitiveFallback;
  }
  return trimmedValue.slice(0, maxLength);
}
