/**
 * @file The upsert operations for ISS-7352 capture list C (MCP / auth / plugin
 * lifecycle), G (the counters we approximated but did not carry natively),
 * D's GA half (`active_time.total`) and F's identity half
 * (`claude_code_session_identity`).
 *
 * Split from `claude-code-persistence.ts` for the same reason the normalizer was
 * split when list A/B/E landed: six more tables would have pushed that file past
 * the 1,000-line ceiling. It keeps the persister owning validation and dispatch,
 * and gives the newly-captured tables one place that says how each row is keyed.
 *
 * Every operation here is an UPSERT on the table's natural key, because an OTLP
 * exporter retries a batch it did not see ACKed and the same export must not
 * produce a second row.
 */

import { effectiveDataRevision } from "../collectors/engine/effective-data-revision.js";
import { deterministicEventId } from "../database/deterministic-event-id.js";
import type { Prisma } from "../database/generated/client.js";
import { eventCorrelationColumns } from "./claude-code-otel-event-correlation.js";
import {
  authOccurrenceKeyOf,
  type ClaudeCodeActiveTimeSignal,
  type ClaudeCodeAuthEventSignal,
  type ClaudeCodeLinesOfCodeSignal,
  type ClaudeCodeLlmRequestSignal,
  type ClaudeCodeMcpServerConnectionSignal,
  ClaudeCodeOtelTableName,
  type ClaudeCodePluginEventSignal,
  type ClaudeCodeSessionIdentitySignal,
  type ClaudeCodeSessionStartSignal,
  type ClaudeCodeToolResultSignal,
  mcpConnectionKeyOf,
  pluginKeyOf,
  toolResultKeyOf,
} from "./claude-code-otel-signal-contract.js";

/**
 * The client every write below is built against.
 *
 * `Prisma.TransactionClient` rather than `PrismaClient` because the persister
 * runs these inside an interactive `$transaction`, alongside the session-level
 * rollup — which needs to READ before it decides, so it cannot be expressed as
 * an operation in a batch array. `PrismaClient` is assignable to this (the type
 * is an `Omit` of it), so nothing that already held a full client is narrowed by
 * the change.
 */
type ClaudeCodeOtelWriteClient = Prisma.TransactionClient;

export function createMcpServerConnectionOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeMcpServerConnectionSignal,
  now: string
) {
  const connectionKey = mcpConnectionKeyOf(event);
  const detail = {
    transportType: event.transportType ?? null,
    serverScope: event.serverScope ?? null,
    durationMs: event.durationMs ?? null,
    errorCode: event.errorCode ?? null,
    isPlugin: event.isPlugin ?? null,
    pluginIdHash: event.pluginIdHash ?? null,
    ...eventCorrelationColumns(event),
  };
  return client.claudeCodeMcpServerConnection.upsert({
    where: {
      sessionId_observedAt_status_connectionKey: {
        sessionId: event.sessionId,
        observedAt: event.observedAt,
        status: event.status,
        connectionKey,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.McpServerConnection,
        event.observedAt,
        event.status,
        connectionKey
      ),
      sessionId: event.sessionId,
      observedAt: event.observedAt,
      status: event.status,
      connectionKey,
      ...detail,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      ...detail,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

export function createAuthEventOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeAuthEventSignal,
  now: string
) {
  const occurrenceKey = authOccurrenceKeyOf(event);
  const detail = {
    success: event.success ?? null,
    authMethod: event.authMethod ?? null,
    errorCategory: event.errorCategory ?? null,
    statusCode: event.statusCode ?? null,
    ...eventCorrelationColumns(event),
  };
  return client.claudeCodeAuthEvent.upsert({
    where: {
      sessionId_observedAt_action_occurrenceKey: {
        sessionId: event.sessionId,
        observedAt: event.observedAt,
        action: event.action,
        occurrenceKey,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.AuthEvent,
        event.observedAt,
        event.action,
        occurrenceKey
      ),
      sessionId: event.sessionId,
      observedAt: event.observedAt,
      action: event.action,
      occurrenceKey,
      ...detail,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      ...detail,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

export function createPluginEventOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodePluginEventSignal,
  now: string
) {
  const pluginKey = pluginKeyOf(event);
  const detail = {
    pluginName: event.pluginName ?? null,
    pluginVersion: event.pluginVersion ?? null,
    marketplaceName: event.marketplaceName ?? null,
    marketplaceIsOfficial: event.marketplaceIsOfficial ?? null,
    installTrigger: event.installTrigger ?? null,
    ...eventCorrelationColumns(event),
  };
  return client.claudeCodePluginEvent.upsert({
    where: {
      sessionId_lifecycle_observedAt_pluginKey: {
        sessionId: event.sessionId,
        lifecycle: event.lifecycle,
        observedAt: event.observedAt,
        pluginKey,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.PluginEvent,
        event.observedAt,
        event.lifecycle,
        pluginKey
      ),
      sessionId: event.sessionId,
      lifecycle: event.lifecycle,
      observedAt: event.observedAt,
      pluginKey,
      ...detail,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      ...detail,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

/**
 * ISS-7352 item G — a lines-of-code delta point.
 *
 * The write REPLACES rather than adds, like every other operation here: delta
 * points that share this key are summed by the normalizer before they arrive,
 * so adding here as well would double-count a re-delivered export.
 */
export function createLinesOfCodeOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeLinesOfCodeSignal,
  now: string
) {
  return client.claudeCodeLinesOfCode.upsert({
    where: {
      sessionId_model_observedAt_changeType: {
        sessionId: event.sessionId,
        model: event.model,
        observedAt: event.observedAt,
        changeType: event.changeType,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.LinesOfCode,
        event.observedAt,
        event.model,
        event.changeType
      ),
      sessionId: event.sessionId,
      model: event.model,
      observedAt: event.observedAt,
      changeType: event.changeType,
      lineCount: event.lineCount,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      lineCount: event.lineCount,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

export function createSessionStartOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeSessionStartSignal,
  now: string
) {
  return client.claudeCodeSessionStart.upsert({
    where: {
      sessionId_observedAt_startType: {
        sessionId: event.sessionId,
        observedAt: event.observedAt,
        startType: event.startType,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.SessionStart,
        event.observedAt,
        event.startType
      ),
      sessionId: event.sessionId,
      observedAt: event.observedAt,
      startType: event.startType,
      sessionCount: event.sessionCount,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      sessionCount: event.sessionCount,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

/**
 * ISS-7352 item D — an active-time delta point.
 *
 * REPLACES rather than adds, for the same reason as the other delta writes: the
 * normalizer has already summed the points sharing this key, so adding here too
 * would double-count a re-delivered export.
 */
export function createActiveTimeOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeActiveTimeSignal,
  now: string
) {
  return client.claudeCodeActiveTime.upsert({
    where: {
      sessionId_observedAt_activityType: {
        sessionId: event.sessionId,
        observedAt: event.observedAt,
        activityType: event.activityType,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.ActiveTime,
        event.observedAt,
        event.activityType
      ),
      sessionId: event.sessionId,
      observedAt: event.observedAt,
      activityType: event.activityType,
      seconds: event.seconds.toString(),
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      seconds: event.seconds.toString(),
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

export function createToolResultOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeToolResultSignal,
  now: string
) {
  const resultKey = toolResultKeyOf(event);
  const detail = {
    toolUseId: event.toolUseId ?? null,
    success: event.success ?? null,
    errorType: event.errorType ?? null,
    toolInputSizeBytes: event.toolInputSizeBytes ?? null,
    toolResultSizeBytes: event.toolResultSizeBytes ?? null,
    mcpServerScope: event.mcpServerScope ?? null,
    ...eventCorrelationColumns(event),
  };
  return client.claudeCodeToolResult.upsert({
    where: {
      sessionId_toolName_observedAt_resultKey: {
        sessionId: event.sessionId,
        toolName: event.toolName,
        observedAt: event.observedAt,
        resultKey,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.ToolResult,
        event.observedAt,
        event.toolName,
        resultKey
      ),
      sessionId: event.sessionId,
      toolName: event.toolName,
      observedAt: event.observedAt,
      resultKey,
      ...detail,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      ...detail,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

/**
 * ISS-7352 item F — the one row that says WHOSE session this is.
 *
 * Keyed on `session_id` alone, unlike every other write here: identity is a
 * property of the session, not of an event it emitted.
 *
 * RAW `ON CONFLICT` rather than a Prisma `upsert`, because the conflict clause
 * has to say COALESCE and Prisma's `update` cannot. Every identity column is
 * FILL-ONLY: a later export supplies a column the row has not resolved yet and
 * can never rewrite one it has. That covers two different mistakes with one
 * rule. An absent identifier stays absent — a batch that saw no
 * `organization.id` must not NULL out one an earlier export did resolve — and a
 * PRESENT but DISAGREEING identifier cannot re-attribute a session either
 * (whitlockk/davetho on #7131); `mergeSessionIdentity` states the same
 * first-populated-wins rule in-batch, so the two halves of the merge agree.
 *
 * `observed_at` is fill-only for a related but distinct reason: it makes the
 * column first-ARRIVAL-wins. A re-delivered export cannot move it forward, and
 * an export that arrives later carrying an EARLIER instant cannot move it back
 * either — so the column means "first seen by this receiver", not the earliest
 * instant the producer ever stamped.
 */
export function createSessionIdentityOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeSessionIdentitySignal,
  now: string
) {
  return client.$executeRawUnsafe(
    SESSION_IDENTITY_UPSERT_SQL,
    event.sessionId,
    event.observedAt,
    event.organizationId ?? null,
    event.userAccountUuid ?? null,
    event.userAccountId ?? null,
    event.identitySource ?? null,
    event.terminalType ?? null,
    event.appVersion ?? null,
    event.appEntrypoint ?? null,
    effectiveDataRevision(),
    now
  );
}

/**
 * The measured columns of `claude_code_llm_request`, field → column.
 *
 * TOTAL over the persisted row: `LlmRequestRow` is derived from this map, so a
 * column added to the table without an entry here fails typecheck at the
 * `detail` literal below, and every entry joins the identical-row predicate in
 * {@link createLlmRequestOperation}. A hand-kept predicate is the shape the
 * in-batch collision guard already had to fix once (tamsinb, whitlockk, ISS-7352
 * review): the field it omits is the one two spans can differ on unnoticed.
 */
const LLM_REQUEST_COLUMNS = {
  sessionId: "session_id",
  parentSpanId: "parent_span_id",
  startedAt: "started_at",
  model: "model",
  querySource: "query_source",
  speed: "speed",
  requestContext: "request_context",
  durationMs: "duration_ms",
  ttftMs: "ttft_ms",
  stopReason: "stop_reason",
  finishReasons: "finish_reasons",
  responseHasToolCall: "response_has_tool_call",
  attempt: "attempt",
  success: "success",
  statusCode: "status_code",
  requestId: "request_id",
  clientRequestId: "client_request_id",
  responseId: "response_id",
  agentId: "agent_id",
  parentAgentId: "parent_agent_id",
  workflowRunId: "workflow_run_id",
  workflowName: "workflow_name",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens",
  cacheCreationTokens: "cache_creation_tokens",
} as const;

type LlmRequestField = keyof typeof LLM_REQUEST_COLUMNS;

/**
 * What SQLite is handed for each measured column. Booleans are bound as `0`/`1`
 * because the column's affinity is INTEGER and the predicate compares the bound
 * value against the stored one with `IS`; a driver that bound `true` as text
 * would read every retry as a conflict.
 */
type LlmRequestRow = Record<LlmRequestField, string | number | null>;

const LLM_REQUEST_FIELDS = Object.keys(
  LLM_REQUEST_COLUMNS
) as LlmRequestField[];

const LLM_REQUEST_IDENTICAL_PREDICATE = LLM_REQUEST_FIELDS.map(
  (field) =>
    `"${ClaudeCodeOtelTableName.LlmRequest}"."${LLM_REQUEST_COLUMNS[field]}" IS EXCLUDED."${LLM_REQUEST_COLUMNS[field]}"`
).join(" AND ");

const LLM_REQUEST_INSERT_SQL = `
  INSERT INTO "${ClaudeCodeOtelTableName.LlmRequest}" (
    "id", "trace_id", "span_id",
    ${LLM_REQUEST_FIELDS.map((field) => `"${LLM_REQUEST_COLUMNS[field]}"`).join(", ")},
    "data_revision", "created_at", "updated_at"
  )
  VALUES (
    $1, $2, $3,
    ${LLM_REQUEST_FIELDS.map((_, index) => `$${index + 4}`).join(", ")},
    $${LLM_REQUEST_FIELDS.length + 4}, $${LLM_REQUEST_FIELDS.length + 5}, $${LLM_REQUEST_FIELDS.length + 5}
  )
  ON CONFLICT ("trace_id", "span_id") DO UPDATE SET
    "data_revision" = EXCLUDED."data_revision",
    "updated_at" = EXCLUDED."updated_at"
  WHERE ${LLM_REQUEST_IDENTICAL_PREDICATE}
`;

function sqliteBoolean(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

/**
 * ISS-7352 item D — one beta `claude_code.llm_request` span. Resolves to the
 * number of rows written: `1` when the span was inserted or an identical row
 * was already stored, `0` when a DIFFERENT row holds the same key and was
 * preserved.
 *
 * Keyed on `(trace_id, span_id)` alone, unlike its siblings here: a span id is
 * unique within its trace by the OTel spec, so the producer has already given
 * the row an identity and no session/timestamp/occurrence tuple has to stand in
 * for one. A retried export therefore lands on the same row.
 *
 * The in-batch collision guard (`sameLlmRequestMeasurements`) only sees two
 * spans that arrive in ONE export. A later POST carrying the same key with a
 * different `ttft_ms` or finish reason reaches this write alone, and a plain
 * upsert would let it rewrite the stored observation (whitlockk, ISS-7352 review).
 * So the DO UPDATE is guarded: it fires only when every measured column of the
 * stored row IS the incoming one — an exact retry, which stays idempotent — and
 * a row that differs on any of them is left as it was, reported through the
 * `0` so the persister can count it rather than let the table silently lie
 * about which observation it holds. First write wins because neither export
 * carries anything that says which one is right.
 *
 * RAW (named blocker: conditional ON CONFLICT DO UPDATE): a DO-UPDATE predicate
 * over the stored row has no typed Prisma `upsert` form.
 *
 * Every measured column is written `?? null`, because the tier is beta and an
 * attribute it stops stamping must cost that column rather than the whole row.
 */
export function createLlmRequestOperation(
  client: ClaudeCodeOtelWriteClient,
  event: ClaudeCodeLlmRequestSignal,
  now: string
): Promise<number> {
  const detail: LlmRequestRow = {
    sessionId: event.sessionId,
    parentSpanId: event.parentSpanId ?? null,
    startedAt: event.startedAt,
    model: event.model ?? null,
    querySource: event.querySource ?? null,
    speed: event.speed ?? null,
    requestContext: event.requestContext ?? null,
    durationMs: event.durationMs ?? null,
    ttftMs: event.ttftMs ?? null,
    stopReason: event.stopReason ?? null,
    finishReasons: event.finishReasons ?? null,
    responseHasToolCall: sqliteBoolean(event.responseHasToolCall),
    attempt: event.attempt ?? null,
    success: sqliteBoolean(event.success),
    statusCode: event.statusCode ?? null,
    requestId: event.requestId ?? null,
    clientRequestId: event.clientRequestId ?? null,
    responseId: event.responseId ?? null,
    agentId: event.agentId ?? null,
    parentAgentId: event.parentAgentId ?? null,
    workflowRunId: event.workflowRunId ?? null,
    workflowName: event.workflowName ?? null,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
  };
  return client.$executeRawUnsafe(
    LLM_REQUEST_INSERT_SQL,
    deterministicEventId(
      event.sessionId,
      ClaudeCodeOtelTableName.LlmRequest,
      event.startedAt,
      event.traceId,
      event.spanId
    ),
    event.traceId,
    event.spanId,
    ...LLM_REQUEST_FIELDS.map((field) => detail[field]),
    effectiveDataRevision(),
    now
  );
}

const SESSION_IDENTITY_UPSERT_SQL = `INSERT INTO ${ClaudeCodeOtelTableName.SessionIdentity} (
     session_id, observed_at, organization_id, user_account_uuid,
     user_account_id, identity_source, terminal_type, app_version,
     app_entrypoint, data_revision, created_at, updated_at
   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
   ON CONFLICT(session_id) DO UPDATE SET
     organization_id = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.organization_id, excluded.organization_id),
     user_account_uuid = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.user_account_uuid, excluded.user_account_uuid),
     user_account_id = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.user_account_id, excluded.user_account_id),
     identity_source = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.identity_source, excluded.identity_source),
     terminal_type = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.terminal_type, excluded.terminal_type),
     app_version = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.app_version, excluded.app_version),
     app_entrypoint = COALESCE(${ClaudeCodeOtelTableName.SessionIdentity}.app_entrypoint, excluded.app_entrypoint),
     data_revision = excluded.data_revision,
     updated_at = excluded.updated_at`;
