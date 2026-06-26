import { z } from "zod";
import { gatewayLog } from "../../main/gateway-logger.js";
import { getShellEnv } from "../shell-path.js";

export const ClaudeCodeOtelEnvVar = {
  EnableTelemetry: "CLAUDE_CODE_ENABLE_TELEMETRY",
  MetricsExporter: "OTEL_METRICS_EXPORTER",
  LogsExporter: "OTEL_LOGS_EXPORTER",
  OtlpProtocol: "OTEL_EXPORTER_OTLP_PROTOCOL",
  OtlpEndpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
} as const;

export type ClaudeCodeOtelEnvVar =
  (typeof ClaudeCodeOtelEnvVar)[keyof typeof ClaudeCodeOtelEnvVar];

export const ClaudeCodeOtelReceiverState = {
  Ready: "ready",
  Unavailable: "unavailable",
} as const;

export type ClaudeCodeOtelReceiverState =
  (typeof ClaudeCodeOtelReceiverState)[keyof typeof ClaudeCodeOtelReceiverState];

export type ClaudeCodeOtelReceiverStatus =
  | {
      state: typeof ClaudeCodeOtelReceiverState.Ready;
      host: "127.0.0.1";
      port: number;
    }
  | { state: typeof ClaudeCodeOtelReceiverState.Unavailable; reason: string };

export type ClaudeCodeOtelEnvDiagnostics = {
  warn(tag: string, message: string): void;
};

export type ClaudeCodeShellEnvProvider = (
  extra?: Record<string, string>
) => Promise<Record<string, string>>;

export type ClaudeCodeShellEnvProviderOptions = {
  getReceiverStatus: () => unknown;
  diagnostics?: ClaudeCodeOtelEnvDiagnostics;
  getBaseShellEnv?: typeof getShellEnv;
};

export const ClaudeCodeOtelDiagnosticTag = "claude-otel-env";

const ClaudeCodeOtelUnavailableReason = {
  ReceiverNotStarted: "otlp_receiver_not_started",
  ReceiverBindFailed: "otlp_receiver_bind_failed",
  ReceiverStopped: "otlp_receiver_stopped",
  ReceiverInvalidHost: "otlp_receiver_invalid_host",
  InvalidReceiverStatus: "invalid_receiver_status",
  ReceiverStatusThrown: "receiver_status_thrown",
} as const;

type ClaudeCodeOtelUnavailableReason =
  (typeof ClaudeCodeOtelUnavailableReason)[keyof typeof ClaudeCodeOtelUnavailableReason];

const OTEL_VALUE = {
  Enabled: "1",
  Otlp: "otlp",
  HttpProtobuf: "http/protobuf",
} as const;

const TARGET_ENV_KEYS = [
  ClaudeCodeOtelEnvVar.EnableTelemetry,
  ClaudeCodeOtelEnvVar.MetricsExporter,
  ClaudeCodeOtelEnvVar.LogsExporter,
  ClaudeCodeOtelEnvVar.OtlpProtocol,
  ClaudeCodeOtelEnvVar.OtlpEndpoint,
] as const;

const receiverStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal(ClaudeCodeOtelReceiverState.Ready),
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
  }),
  z.object({
    state: z.literal(ClaudeCodeOtelReceiverState.Unavailable),
    reason: z.string().trim().min(1),
  }),
]);

const defaultClaudeCodeShellEnvProvider = createClaudeCodeShellEnvProvider({
  getReceiverStatus: getDefaultClaudeCodeOtelReceiverStatus,
  diagnostics: gatewayLog,
});

export function createClaudeCodeShellEnvProvider(
  options: ClaudeCodeShellEnvProviderOptions
): ClaudeCodeShellEnvProvider {
  const getBaseShellEnv = options.getBaseShellEnv ?? getShellEnv;
  const warnedUnavailableReasons = new Set<string>();
  const warnedConflictSets = new Set<string>();

  return async (extra?: Record<string, string>) => {
    const baseEnv = await getBaseShellEnv(extra);
    const status = readReceiverStatus(options.getReceiverStatus);

    if (status.state === ClaudeCodeOtelReceiverState.Unavailable) {
      warnOnce(
        options.diagnostics,
        warnedUnavailableReasons,
        status.reason,
        `Claude Code OTel env injection skipped: receiver unavailable (${status.reason})`
      );
      return baseEnv;
    }

    const defaults = buildReadyDefaults(status);
    const conflicts = TARGET_ENV_KEYS.filter((key) =>
      Object.hasOwn(baseEnv, key)
    );
    if (conflicts.length > 0) {
      const sortedConflicts = [...conflicts].sort();
      warnOnce(
        options.diagnostics,
        warnedConflictSets,
        sortedConflicts.join(","),
        `Claude Code OTel env preserved existing user values for keys: ${sortedConflicts.join(",")}`
      );
    }

    const merged = { ...baseEnv };
    for (const key of TARGET_ENV_KEYS) {
      if (!Object.hasOwn(merged, key)) {
        merged[key] = defaults[key];
      }
    }
    return merged;
  };
}

export function getClaudeCodeShellEnv(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  return defaultClaudeCodeShellEnvProvider(extra);
}

export function getDefaultClaudeCodeOtelReceiverStatus(): ClaudeCodeOtelReceiverStatus {
  return {
    state: ClaudeCodeOtelReceiverState.Unavailable,
    reason: ClaudeCodeOtelUnavailableReason.ReceiverNotStarted,
  };
}

function readReceiverStatus(
  getReceiverStatus: () => unknown
): ClaudeCodeOtelReceiverStatus {
  let rawStatus: unknown;
  try {
    rawStatus = getReceiverStatus();
  } catch {
    return {
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: ClaudeCodeOtelUnavailableReason.ReceiverStatusThrown,
    };
  }

  const parsed = receiverStatusSchema.safeParse(rawStatus);
  if (!parsed.success) {
    return {
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: ClaudeCodeOtelUnavailableReason.InvalidReceiverStatus,
    };
  }
  if (parsed.data.state === ClaudeCodeOtelReceiverState.Unavailable) {
    return {
      ...parsed.data,
      reason: normalizeUnavailableReason(parsed.data.reason),
    };
  }
  return parsed.data;
}

function normalizeUnavailableReason(
  reason: string
): ClaudeCodeOtelUnavailableReason {
  switch (reason) {
    case ClaudeCodeOtelUnavailableReason.ReceiverNotStarted:
    case ClaudeCodeOtelUnavailableReason.ReceiverBindFailed:
    case ClaudeCodeOtelUnavailableReason.ReceiverStopped:
    case ClaudeCodeOtelUnavailableReason.ReceiverInvalidHost:
    case ClaudeCodeOtelUnavailableReason.InvalidReceiverStatus:
    case ClaudeCodeOtelUnavailableReason.ReceiverStatusThrown:
      return reason;
    default:
      return ClaudeCodeOtelUnavailableReason.InvalidReceiverStatus;
  }
}

function buildReadyDefaults(
  status: Extract<
    ClaudeCodeOtelReceiverStatus,
    { state: typeof ClaudeCodeOtelReceiverState.Ready }
  >
): Record<ClaudeCodeOtelEnvVar, string> {
  return {
    [ClaudeCodeOtelEnvVar.EnableTelemetry]: OTEL_VALUE.Enabled,
    [ClaudeCodeOtelEnvVar.MetricsExporter]: OTEL_VALUE.Otlp,
    [ClaudeCodeOtelEnvVar.LogsExporter]: OTEL_VALUE.Otlp,
    [ClaudeCodeOtelEnvVar.OtlpProtocol]: OTEL_VALUE.HttpProtobuf,
    [ClaudeCodeOtelEnvVar.OtlpEndpoint]: `http://127.0.0.1:${status.port}`,
  };
}

function warnOnce(
  diagnostics: ClaudeCodeOtelEnvDiagnostics | undefined,
  seen: Set<string>,
  key: string,
  message: string
): void {
  if (!diagnostics || seen.has(key)) {
    return;
  }
  seen.add(key);
  diagnostics.warn(ClaudeCodeOtelDiagnosticTag, message);
}
