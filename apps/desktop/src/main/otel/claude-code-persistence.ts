import { z } from "zod";
import { effectiveDataRevision } from "../collectors/engine/effective-data-revision.js";
import { deterministicEventId } from "../database/deterministic-event-id.js";
import type { Prisma } from "../database/generated/client.js";
import { refreshOtelInvocationAttribution } from "../database/otel-invocation-attribution-refresh.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import {
  distinctCostEventSessionIds,
  rollUpSessionAuthoritativeCost,
} from "../database/session-authoritative-cost.js";
import {
  attributionKeyOf,
  attributionSourceOf,
} from "./claude-code-otel-attribution.js";
import {
  createActiveTimeOperation,
  createAuthEventOperation,
  createLinesOfCodeOperation,
  createLlmRequestOperation,
  createMcpServerConnectionOperation,
  createPluginEventOperation,
  createSessionIdentityOperation,
  createSessionStartOperation,
  createToolResultOperation,
} from "./claude-code-otel-capture-writes.js";
import { eventCorrelationColumns } from "./claude-code-otel-event-correlation.js";
import {
  type ClaudeCodeCostUsageSignal,
  type ClaudeCodeErrorEventSignal,
  type ClaudeCodeLlmRequestSignal,
  type ClaudeCodeOtelSignal,
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
  ClaudeCodeOtelWarningSignalType,
  type ClaudeCodePermissionModeChangeSignal,
  claudeCodeOtelSignalTypeSchema,
  errorOccurrenceKeyOf,
  parseClaudeCodeOtelSignal,
} from "./claude-code-otel-signal-contract.js";

export type ClaudeCodeOtelPersistenceSummary = {
  accepted: number;
  rejected: number;
};

export const ClaudeCodeOtelPersistenceWarningKind = {
  ValidationFailed: "validation_failed",
  /**
   * An `llm_request` span reached the write under a `(trace_id, span_id)` a
   * DIFFERENT row already holds. The stored observation was preserved and this
   * one was not written — see `createLlmRequestOperation`.
   */
  LlmRequestConflict: "llm_request_conflict",
} as const;
export type ClaudeCodeOtelPersistenceWarningKind =
  (typeof ClaudeCodeOtelPersistenceWarningKind)[keyof typeof ClaudeCodeOtelPersistenceWarningKind];

export type ClaudeCodeOtelPersistenceWarning = {
  kind: ClaudeCodeOtelPersistenceWarningKind;
  index: number;
  signalType: ClaudeCodeOtelWarningSignalType | null;
  issues: string[];
};

export type ClaudeCodeOtelPersistenceOptions = {
  warn?: (warning: ClaudeCodeOtelPersistenceWarning) => void;
  now?: () => string;
  /**
   * ISS-10720: the diagnostic channel the invocation-attribution refresh
   * reports its per-session tally on. OPTIONAL, unlike the reporters
   * `insertInvocationRows` requires, because nothing here is DROPPED when it is
   * absent — the refresh runs and writes either way, and the line is a tally of
   * what resolved, not the record of a discarded value. The production caller
   * (`sqlite.ts`) wires it to the same `log` its `warn` uses.
   */
  log?: (message: string) => void;
};

export type PersistClaudeCodeOtelSignalsInput = {
  /**
   * Only the queue-serialized write seam is used — the batch never reads. Kept
   * narrow so callers (and doubles) do not have to materialize the whole
   * {@link DesktopPrisma} surface to persist a batch.
   */
  prisma: Pick<DesktopPrisma, "write">;
  events: unknown[];
};

/**
 * Whether an unvalidated payload claims to be a `token_usage` signal, for the
 * IPC/db-host boundary where `unknown` arrives from another process and the
 * `ClaudeCodeOtelSideTableSignal` type guarantees nothing.
 *
 * Only the discriminant is read; the full Zod contract in
 * `parseClaudeCodeOtelSignal` still decides whether the rest of a record is
 * admissible. This exists so a transcript-owned `token_usage` write is refused
 * BEFORE reaching a persister that would accept it.
 */
export function isTokenUsageOtelSignal(signal: unknown): boolean {
  if (typeof signal !== "object" || signal === null || !("type" in signal)) {
    return false;
  }
  return signal.type === ClaudeCodeOtelSignalType.TokenUsage;
}

export async function persistClaudeCodeOtelSignals(
  input: PersistClaudeCodeOtelSignalsInput,
  options: ClaudeCodeOtelPersistenceOptions = {}
): Promise<ClaudeCodeOtelPersistenceSummary> {
  // FEA-1842 owns OTLP protobuf decoding, receiver networking, and harness
  // discrimination. This boundary owns validation and persistence after a
  // Claude-normalized signal exists.
  const accepted: ClaudeCodeOtelSignal[] = [];
  const acceptedIndexes: number[] = [];
  let rejected = 0;

  input.events.forEach((event, index) => {
    const result = parseClaudeCodeOtelSignal(event);
    if (result.success) {
      accepted.push(result.data);
      acceptedIndexes.push(index);
      return;
    }
    rejected += 1;
    options.warn?.({
      kind: ClaudeCodeOtelPersistenceWarningKind.ValidationFailed,
      index,
      signalType: readWarningSignalType(event),
      issues: summarizeIssues(result.error),
    });
  });

  if (accepted.length === 0) {
    return { accepted: 0, rejected };
  }

  const now = options.now?.() ?? new Date().toISOString();
  // ISS-7229: the session-level rollup rides the SAME batch as the events it
  // summarizes, appended after them so it sees their writes. Atomicity is the
  // point — a crash between the two would otherwise leave
  // `sessions.authoritative_cost_usd` describing a set of rows that was never
  // stored, and the column carries no marker that would let a reader tell.
  //
  // Only sessions this batch reported COST for are rolled up. A batch of
  // tool-result or auth signals changes no cost total, so re-running it would
  // be N writes to reach the value already there.
  const costEventSessionIds = distinctCostEventSessionIds(
    accepted.filter(
      (event): event is ClaudeCodeCostUsageSignal =>
        event.type === ClaudeCodeOtelSignalType.CostUsage
    )
  );
  // AN INTERACTIVE `$transaction`, not the batch-array form it used to be. The
  // rollup advances the shared `sessions.updated_at` cursor through
  // `advanceSessionSyncWatermark`, which must READ the stored watermark before
  // it can decide what advancing means — and a batch array has no point at
  // which a read's result can steer the next statement. The alternative was a
  // second, SQL-side spelling of semantics ISS-8758 already settled once, which
  // is the defect rather than the fix. Atomicity is unchanged and is still the
  // point: a crash between the events and their total would leave a figure
  // describing rows nobody stored, and the column carries no marker that would
  // let a reader tell.
  const preserved = await input.prisma.write((client) =>
    client.$transaction(async (tx) => {
      const conflicts = await writeAcceptedSignals(
        tx,
        accepted,
        acceptedIndexes,
        now,
        options
      );
      for (const sessionId of costEventSessionIds) {
        await rollUpSessionAuthoritativeCost(tx, sessionId, now);
        /* ISS-10720 (codex P1 on #7731): the attribution join runs on
           CANDIDATES inside the two derivation paths, so it only ever sees the
           counters already stored when a session was last imported — and this
           batch IS the counters arriving afterwards, which the rollup above
           documents as the normal order. Re-stamping the stored rows here is
           what makes the join reach that ordering; it writes only rows whose
           value moved and re-enqueues only when one did. */
        await refreshOtelInvocationAttribution(
          tx,
          sessionId,
          now,
          options.log ?? (() => undefined)
        );
      }
      return conflicts;
    })
  );

  // A preserved conflict is a signal this batch did not write, so it is
  // reported the way a refused one is: the receiver's `rejected > 0` log is the
  // monitored path, and a count of "accepted" that included a row the table
  // does not hold would be the confident-but-wrong number this lane refuses to
  // emit.
  return {
    accepted: accepted.length - preserved,
    rejected: rejected + preserved,
  };
}

/**
 * Writes every accepted signal and returns how many `llm_request` spans were
 * PRESERVED rather than written — a key collision with a row that differs,
 * which only that table's write can detect because only that table's key is
 * the producer's own (see `createLlmRequestOperation`).
 */
async function writeAcceptedSignals(
  tx: Prisma.TransactionClient,
  accepted: readonly ClaudeCodeOtelSignal[],
  acceptedIndexes: readonly number[],
  now: string,
  options: ClaudeCodeOtelPersistenceOptions
): Promise<number> {
  let preserved = 0;
  for (const [position, event] of accepted.entries()) {
    if (event.type !== ClaudeCodeOtelSignalType.LlmRequest) {
      await createPersistenceOperation(tx, event, now);
      continue;
    }
    const written = await createLlmRequestOperation(tx, event, now);
    if (written > 0) {
      continue;
    }
    preserved += 1;
    options.warn?.({
      kind: ClaudeCodeOtelPersistenceWarningKind.LlmRequestConflict,
      index: acceptedIndexes[position] ?? position,
      signalType: ClaudeCodeOtelSignalType.LlmRequest,
      issues: [
        `a different llm_request row already holds trace ${event.traceId} span ${event.spanId}; the stored observation was preserved`,
      ],
    });
  }
  return preserved;
}

function createPersistenceOperation(
  client: Prisma.TransactionClient,
  // `llm_request` is dispatched by `writeAcceptedSignals`, which reads the
  // write's result; excluded here so the fall-through at the bottom cannot
  // receive it.
  event: Exclude<ClaudeCodeOtelSignal, ClaudeCodeLlmRequestSignal>,
  now: string
) {
  if (event.type === ClaudeCodeOtelSignalType.CostUsage) {
    return createCostEventOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.ErrorEvent) {
    return createErrorEventOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.PermissionModeChange) {
    return createPermissionModeChangeOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.McpServerConnection) {
    return createMcpServerConnectionOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.AuthEvent) {
    return createAuthEventOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.PluginEvent) {
    return createPluginEventOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.LinesOfCode) {
    return createLinesOfCodeOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.SessionStart) {
    return createSessionStartOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.ToolResult) {
    return createToolResultOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.ActiveTime) {
    return createActiveTimeOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.SessionIdentity) {
    return createSessionIdentityOperation(client, event, now);
  }

  if (event.type === ClaudeCodeOtelSignalType.PermissionDecision) {
    // ISS-7481: the natural key stays `(session, tool_name, observed_at)` and
    // this write still REPLACES on conflict, so two decisions that collide
    // across separate exports remain last-write-wins. What changed is that a
    // collision the producer proved distinct — a differing `tool_use_id` — no
    // longer reaches this upsert at all: the batch's collision guard refuses it
    // and counts it in `unusable`, so the truncation announces itself instead
    // of one allow/deny silently erasing the other.
    const detail = {
      decision: event.decision,
      source: event.source,
      toolUseId: event.toolUseId ?? null,
      ...eventCorrelationColumns(event),
    };
    return client.claudeCodePermissionEvent.upsert({
      where: {
        sessionId_toolName_observedAt: {
          sessionId: event.sessionId,
          toolName: event.toolName,
          observedAt: event.observedAt,
        },
      },
      create: {
        id: deterministicEventId(
          event.sessionId,
          ClaudeCodeOtelTableName.PermissionEvent,
          event.observedAt,
          event.toolName
        ),
        sessionId: event.sessionId,
        toolName: event.toolName,
        observedAt: event.observedAt,
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

  // The `update` branch rewrites EVERY measured column, `cost_usd_micros`
  // included, so the row always describes ONE observation whole. That is why an
  // absent micros clears the column instead of preserving what is stored:
  // `started_at` is derived (completion less duration, at ms resolution), so a
  // later export reaching this key is either the same record re-sent — same
  // attributes, nothing lost — or a DIFFERENT request that collided on it, and
  // keeping the previous exact cost beside this one's float would pair two
  // observations in one row and manufacture the very cost disagreement the
  // batch's collision guard exists to refuse. NULL here is UNKNOWN, never 0.
  if (event.type === ClaudeCodeOtelSignalType.ApiRequest) {
    const detail = {
      tokensInput: event.inputTokens,
      tokensOutput: event.outputTokens,
      tokensCacheRead: event.cacheReadTokens,
      tokensCacheCreation: event.cacheCreationTokens,
      costUsd: event.costUsd.toString(),
      costUsdMicros: event.costUsdMicros ?? null,
      durationMs: event.durationMs,
      // ISS-7352 item F — the join back to Anthropic's own record of this
      // request, rewritten with the rest of the observation for the reason the
      // comment above gives.
      requestId: event.requestId ?? null,
      clientRequestId: event.clientRequestId ?? null,
      ...eventCorrelationColumns(event),
    };
    return client.claudeCodeApiRequest.upsert({
      where: {
        sessionId_startedAt_model: {
          sessionId: event.sessionId,
          startedAt: event.startedAt,
          model: event.model,
        },
      },
      create: {
        id: deterministicEventId(
          event.sessionId,
          ClaudeCodeOtelTableName.ApiRequest,
          event.startedAt,
          event.model
        ),
        sessionId: event.sessionId,
        model: event.model,
        startedAt: event.startedAt,
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

  return client.tokenUsage.upsert({
    where: {
      sessionId_model: {
        sessionId: event.sessionId,
        model: event.model,
      },
    },
    create: {
      sessionId: event.sessionId,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheCreationTokens,
      rawInput: event.inputTokens,
      rawOutput: event.outputTokens,
      rawCacheRead: event.cacheReadTokens,
      rawCacheWrite: event.cacheCreationTokens,
      createdAt: event.observedAt ?? now,
      updatedAt: now,
    },
    update: {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheCreationTokens,
      rawInput: event.inputTokens,
      rawOutput: event.outputTokens,
      rawCacheRead: event.cacheReadTokens,
      rawCacheWrite: event.cacheCreationTokens,
      updatedAt: now,
    },
  });
}

function readWarningSignalType(
  event: unknown
): ClaudeCodeOtelWarningSignalType | null {
  const result = z.object({ type: z.string() }).safeParse(event);
  if (!result.success) {
    return null;
  }

  const signalType = claudeCodeOtelSignalTypeSchema.safeParse(result.data.type);
  if (signalType.success) {
    return signalType.data;
  }
  return ClaudeCodeOtelWarningSignalType.Unknown;
}

function summarizeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join(".");
    if (path) {
      return `${path}: ${issue.message}`;
    }
    return issue.message;
  });
}

function createCostEventOperation(
  client: Prisma.TransactionClient,
  event: ClaudeCodeCostUsageSignal,
  now: string
) {
  const attributionKey = attributionKeyOf(event);
  const attribution = {
    attributionKey,
    attributionSource: attributionSourceOf(event),
    agentName: event.agentName ?? null,
    skillName: event.skillName ?? null,
    pluginName: event.pluginName ?? null,
    marketplaceName: event.marketplaceName ?? null,
    mcpServerName: event.mcpServerName ?? null,
    mcpToolName: event.mcpToolName ?? null,
    querySource: event.querySource ?? null,
    speed: event.speed ?? null,
    effort: event.effort ?? null,
  };
  return client.claudeCodeCostEvent.upsert({
    where: {
      sessionId_model_observedAt_attributionKey: {
        sessionId: event.sessionId,
        model: event.model,
        observedAt: event.observedAt,
        attributionKey,
      },
    },
    create: {
      // `deterministicEventId` ignores a falsy discriminator, so an
      // unattributed row keeps the exact id it had before item E existed —
      // rows written by the shipped build are updated in place rather than
      // duplicated under a new identity.
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.CostEvent,
        event.observedAt,
        event.model,
        attributionKey
      ),
      sessionId: event.sessionId,
      model: event.model,
      observedAt: event.observedAt,
      costUsd: event.costUsd.toString(),
      ...attribution,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      costUsd: event.costUsd.toString(),
      ...attribution,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

function createErrorEventOperation(
  client: Prisma.TransactionClient,
  event: ClaudeCodeErrorEventSignal,
  now: string
) {
  const occurrenceKey = errorOccurrenceKeyOf(event);
  const taxonomy = {
    model: event.model ?? null,
    statusCode: event.statusCode ?? null,
    attempt: event.attempt ?? null,
    errorCategory: event.errorCategory ?? null,
    durationMs: event.durationMs ?? null,
    requestId: event.requestId ?? null,
    clientRequestId: event.clientRequestId ?? null,
    refusalCategory: event.refusalCategory ?? null,
    serverFallbackHop: event.serverFallbackHop ?? null,
    hasCategory: event.hasCategory ?? null,
    hasExplanation: event.hasExplanation ?? null,
    errorName: event.errorName ?? null,
    errorCode: event.errorCode ?? null,
    ...eventCorrelationColumns(event),
  };
  return client.claudeCodeErrorEvent.upsert({
    where: {
      sessionId_errorKind_observedAt_occurrenceKey: {
        sessionId: event.sessionId,
        errorKind: event.errorKind,
        observedAt: event.observedAt,
        occurrenceKey,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.ErrorEvent,
        event.observedAt,
        event.errorKind,
        occurrenceKey
      ),
      sessionId: event.sessionId,
      errorKind: event.errorKind,
      observedAt: event.observedAt,
      occurrenceKey,
      ...taxonomy,
      dataRevision: effectiveDataRevision(),
      createdAt: now,
      updatedAt: now,
    },
    update: {
      ...taxonomy,
      dataRevision: effectiveDataRevision(),
      updatedAt: now,
    },
  });
}

function createPermissionModeChangeOperation(
  client: Prisma.TransactionClient,
  event: ClaudeCodePermissionModeChangeSignal,
  now: string
) {
  const detail = {
    trigger: event.trigger ?? null,
    ...eventCorrelationColumns(event),
  };
  return client.claudeCodePermissionModeChange.upsert({
    where: {
      sessionId_observedAt_fromMode_toMode: {
        sessionId: event.sessionId,
        observedAt: event.observedAt,
        fromMode: event.fromMode,
        toMode: event.toMode,
      },
    },
    create: {
      id: deterministicEventId(
        event.sessionId,
        ClaudeCodeOtelTableName.PermissionModeChange,
        event.observedAt,
        event.toMode,
        event.fromMode
      ),
      sessionId: event.sessionId,
      observedAt: event.observedAt,
      fromMode: event.fromMode,
      toMode: event.toMode,
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
