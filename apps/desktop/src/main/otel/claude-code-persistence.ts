import { z } from "zod";
import { DATA_REVISION } from "../collectors/engine/data-revision.js";
import { deterministicEventId } from "../database/deterministic-event-id.js";
import type { PrismaClient } from "../database/generated/client.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { safeStorageTokenCountSchema } from "../token-counts.js";

export const ClaudeCodeOtelSignalType = {
  CostUsage: "cost_usage",
  PermissionDecision: "permission_decision",
  ApiRequest: "api_request",
  TokenUsage: "token_usage",
} as const;
export type ClaudeCodeOtelSignalType =
  (typeof ClaudeCodeOtelSignalType)[keyof typeof ClaudeCodeOtelSignalType];

export const ClaudeCodeOtelWarningSignalType = {
  Unknown: "unknown",
} as const;
export type ClaudeCodeOtelWarningSignalType =
  | ClaudeCodeOtelSignalType
  | (typeof ClaudeCodeOtelWarningSignalType)[keyof typeof ClaudeCodeOtelWarningSignalType];

export const ClaudeCodePermissionDecision = {
  Allow: "allow",
  Deny: "deny",
} as const;
export type ClaudeCodePermissionDecision =
  (typeof ClaudeCodePermissionDecision)[keyof typeof ClaudeCodePermissionDecision];

export const ClaudeCodePermissionSource = {
  Config: "config",
  Hook: "hook",
  UserPermanent: "user_permanent",
  UserReject: "user_reject",
} as const;
export type ClaudeCodePermissionSource =
  (typeof ClaudeCodePermissionSource)[keyof typeof ClaudeCodePermissionSource];

export const ClaudeCodeOtelTableName = {
  CostEvent: "claude_code_cost_event",
  PermissionEvent: "claude_code_permission_event",
  ApiRequest: "claude_code_api_request",
  TokenUsage: "token_usage",
} as const;
export type ClaudeCodeOtelTableName =
  (typeof ClaudeCodeOtelTableName)[keyof typeof ClaudeCodeOtelTableName];

export type ClaudeCodeOtelPersistenceSummary = {
  accepted: number;
  rejected: number;
};

export type ClaudeCodeOtelPersistenceWarning = {
  kind: "validation_failed";
  index: number;
  signalType: ClaudeCodeOtelWarningSignalType | null;
  issues: string[];
};

export type ClaudeCodeOtelPersistenceOptions = {
  warn?: (warning: ClaudeCodeOtelPersistenceWarning) => void;
  now?: () => string;
};

export type PersistClaudeCodeOtelSignalsInput = {
  prisma: DesktopPrisma;
  events: unknown[];
};

type ValidClaudeCodeOtelSignal = z.infer<typeof claudeCodeOtelSignalSchema>;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isoTimestampSchema = z.string().trim().min(1).refine(isValidTimestamp, {
  message: "must be a valid timestamp",
});
const nonEmptyStringSchema = z.string().trim().min(1);
const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const baseSignalSchema = z.object({
  sessionId: nonEmptyStringSchema,
});
const tokenCountsSchema = z.object({
  inputTokens: safeStorageTokenCountSchema,
  outputTokens: safeStorageTokenCountSchema,
  cacheReadTokens: safeStorageTokenCountSchema,
  cacheCreationTokens: safeStorageTokenCountSchema,
});
const costUsageSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.CostUsage),
  model: nonEmptyStringSchema,
  observedAt: isoTimestampSchema,
  costUsd: finiteNonNegativeNumberSchema,
});
const permissionDecisionSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.PermissionDecision),
  toolName: nonEmptyStringSchema,
  observedAt: isoTimestampSchema,
  decision: z.enum(ClaudeCodePermissionDecision),
  source: z.enum(ClaudeCodePermissionSource),
});
const apiRequestSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.ApiRequest),
  model: nonEmptyStringSchema,
  startedAt: isoTimestampSchema,
  durationMs: nonNegativeIntegerSchema,
  costUsd: finiteNonNegativeNumberSchema,
  ...tokenCountsSchema.shape,
});
const tokenUsageSignalSchema = baseSignalSchema.extend({
  type: z.literal(ClaudeCodeOtelSignalType.TokenUsage),
  model: nonEmptyStringSchema,
  observedAt: isoTimestampSchema.optional(),
  ...tokenCountsSchema.shape,
});
const claudeCodeOtelSignalSchema = z.discriminatedUnion("type", [
  costUsageSignalSchema,
  permissionDecisionSignalSchema,
  apiRequestSignalSchema,
  tokenUsageSignalSchema,
]);
const claudeCodeOtelSignalTypeSchema = z.enum(ClaudeCodeOtelSignalType);

export async function persistClaudeCodeOtelSignals(
  input: PersistClaudeCodeOtelSignalsInput,
  options: ClaudeCodeOtelPersistenceOptions = {}
): Promise<ClaudeCodeOtelPersistenceSummary> {
  // FEA-1842 owns OTLP protobuf decoding, receiver networking, and harness
  // discrimination. This boundary owns validation and persistence after a
  // Claude-normalized signal exists.
  const accepted: ValidClaudeCodeOtelSignal[] = [];
  let rejected = 0;

  input.events.forEach((event, index) => {
    const result = claudeCodeOtelSignalSchema.safeParse(event);
    if (result.success) {
      accepted.push(result.data);
      return;
    }
    rejected += 1;
    options.warn?.({
      kind: "validation_failed",
      index,
      signalType: readWarningSignalType(event),
      issues: summarizeIssues(result.error),
    });
  });

  if (accepted.length === 0) {
    return { accepted: 0, rejected };
  }

  const now = options.now?.() ?? new Date().toISOString();
  await input.prisma.write((client) =>
    client.$transaction(
      accepted.map((event) => createPersistenceOperation(client, event, now))
    )
  );

  return { accepted: accepted.length, rejected };
}

function createPersistenceOperation(
  client: PrismaClient,
  event: ValidClaudeCodeOtelSignal,
  now: string
) {
  if (event.type === ClaudeCodeOtelSignalType.CostUsage) {
    return client.claudeCodeCostEvent.upsert({
      where: {
        sessionId_model_observedAt: {
          sessionId: event.sessionId,
          model: event.model,
          observedAt: event.observedAt,
        },
      },
      create: {
        id: deterministicEventId(
          event.sessionId,
          ClaudeCodeOtelTableName.CostEvent,
          event.observedAt,
          event.model
        ),
        sessionId: event.sessionId,
        model: event.model,
        observedAt: event.observedAt,
        costUsd: event.costUsd.toString(),
        dataRevision: DATA_REVISION,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        costUsd: event.costUsd.toString(),
        dataRevision: DATA_REVISION,
        updatedAt: now,
      },
    });
  }

  if (event.type === ClaudeCodeOtelSignalType.PermissionDecision) {
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
        decision: event.decision,
        source: event.source,
        dataRevision: DATA_REVISION,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        decision: event.decision,
        source: event.source,
        dataRevision: DATA_REVISION,
        updatedAt: now,
      },
    });
  }

  if (event.type === ClaudeCodeOtelSignalType.ApiRequest) {
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
        tokensInput: event.inputTokens,
        tokensOutput: event.outputTokens,
        tokensCacheRead: event.cacheReadTokens,
        tokensCacheCreation: event.cacheCreationTokens,
        costUsd: event.costUsd.toString(),
        startedAt: event.startedAt,
        durationMs: event.durationMs,
        dataRevision: DATA_REVISION,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        tokensInput: event.inputTokens,
        tokensOutput: event.outputTokens,
        tokensCacheRead: event.cacheReadTokens,
        tokensCacheCreation: event.cacheCreationTokens,
        costUsd: event.costUsd.toString(),
        durationMs: event.durationMs,
        dataRevision: DATA_REVISION,
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

function isValidTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_RE.test(value)) {
    return false;
  }
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value
  );
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
