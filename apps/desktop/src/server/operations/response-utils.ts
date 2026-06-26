import type { OperationRequestContext } from "../operation-dispatcher.js";

export function json(
  context: OperationRequestContext,
  status: number,
  payload: unknown
): void {
  context.response.statusCode = status;
  context.response.setHeader("content-type", "application/json");
  context.response.end(JSON.stringify(payload));
}

export type JsonErrorPayload = {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
};

export function jsonError(
  context: OperationRequestContext,
  status: number,
  payload: JsonErrorPayload
): void {
  json(context, status, {
    error: payload.error,
    ...(payload.code ? { code: payload.code } : {}),
    ...(payload.details ? { details: omitUndefined(payload.details) } : {}),
  });
}

function omitUndefined(
  input: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}
