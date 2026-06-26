import { z } from "zod";
import {
  ClaudeCodeOtelReceiverState,
  type ClaudeCodeOtelReceiverStatus,
} from "../server/otel/claude-code-env.js";

export const DEFAULT_OTLP_RECEIVER_HOST = "127.0.0.1";
export const DEFAULT_OTLP_RECEIVER_PORT = 4318;

export const OtlpReceiverUnavailableReason = {
  NotStarted: "otlp_receiver_not_started",
  BindFailed: "otlp_receiver_bind_failed",
  Stopped: "otlp_receiver_stopped",
  InvalidState: "otlp_receiver_invalid_state",
  InvalidHost: "otlp_receiver_invalid_host",
} as const;

export type OtlpReceiverUnavailableReason =
  (typeof OtlpReceiverUnavailableReason)[keyof typeof OtlpReceiverUnavailableReason];

export type OtlpReceiverState =
  | {
      available: true;
      host: typeof DEFAULT_OTLP_RECEIVER_HOST;
      port: number;
    }
  | {
      available: false;
      host: typeof DEFAULT_OTLP_RECEIVER_HOST;
      port: number;
      reason: OtlpReceiverUnavailableReason;
    };

const validPortSchema = z.number().int().min(1).max(65_535);

const receiverStateSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    host: z.literal(DEFAULT_OTLP_RECEIVER_HOST),
    port: validPortSchema,
  }),
  z.object({
    available: z.literal(false),
    host: z.literal(DEFAULT_OTLP_RECEIVER_HOST),
    port: validPortSchema,
    reason: z
      .enum([
        OtlpReceiverUnavailableReason.NotStarted,
        OtlpReceiverUnavailableReason.BindFailed,
        OtlpReceiverUnavailableReason.Stopped,
        OtlpReceiverUnavailableReason.InvalidState,
        OtlpReceiverUnavailableReason.InvalidHost,
      ])
      .catch(OtlpReceiverUnavailableReason.InvalidState),
  }),
]);

let processState: OtlpReceiverState = unavailableState(
  OtlpReceiverUnavailableReason.NotStarted
);

export function getOtlpReceiverState(): OtlpReceiverState {
  return processState;
}

export function setOtlpReceiverStateForProcess(
  state: OtlpReceiverState
): OtlpReceiverState {
  const parsed = receiverStateSchema.safeParse(state);
  processState = parsed.success
    ? parsed.data
    : unavailableState(OtlpReceiverUnavailableReason.InvalidState);
  return processState;
}

export function toClaudeCodeOtelReceiverStatus(
  state: OtlpReceiverState
): ClaudeCodeOtelReceiverStatus {
  if (state.available) {
    return {
      state: ClaudeCodeOtelReceiverState.Ready,
      host: state.host,
      port: state.port,
    };
  }
  return {
    state: ClaudeCodeOtelReceiverState.Unavailable,
    reason: state.reason,
  };
}

export function makeOtlpReceiverUnavailableState(
  reason: OtlpReceiverUnavailableReason,
  port = DEFAULT_OTLP_RECEIVER_PORT
): OtlpReceiverState {
  return unavailableState(reason, port);
}

function unavailableState(
  reason: OtlpReceiverUnavailableReason,
  port = DEFAULT_OTLP_RECEIVER_PORT
): OtlpReceiverState {
  return {
    available: false,
    host: DEFAULT_OTLP_RECEIVER_HOST,
    port,
    reason,
  };
}
