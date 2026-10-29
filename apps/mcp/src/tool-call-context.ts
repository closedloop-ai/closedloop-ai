import { AsyncLocalStorage } from "node:async_hooks";
import type { OperationReceipt } from "@repo/api/src/types/attribution-evidence.js";
import { asRecord } from "./tools/tool-utils.js";

/**
 * ISS-12552: what one MCP tool call carries to the API, and the receipt the
 * API hands back. Scoped per call, so concurrent calls on one server never see
 * each other's ids.
 */
export type ToolCallContext = {
  /** The JSON-RPC id of the `tools/call` request, which its response echoes. */
  requestId: string | number;
  /** The harness's per-call id from `tools/call` `_meta`. */
  clientCallId?: string;
  /** `computeRequestFingerprint` over the tool name and its raw arguments. */
  requestFingerprint?: Promise<string | undefined>;
  /** The last receipt a write in this call returned. */
  operationReceipt?: OperationReceipt;
};

const storage = new AsyncLocalStorage<ToolCallContext>();

export function runInToolCallContext<T>(
  context: ToolCallContext,
  fn: () => T
): T {
  return storage.run(context, fn);
}

export function currentToolCallContext(): ToolCallContext | undefined {
  return storage.getStore();
}

const OPAQUE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The per-call id a harness sends in `_meta`: Claude Code's
 * `claudecode/toolUseId` (the transcript `tool_use.id`) or Codex's `callId`
 * (the rollout `McpToolCall` item id). Observed on Claude Code 2.1.296 and
 * codex-cli 0.162.1. Anything that is not a short opaque key is dropped.
 */
export function readClientCallId(meta: unknown): string | undefined {
  const record = asRecord(meta);
  for (const key of ["claudecode/toolUseId", "callId"]) {
    const value = record[key];
    if (typeof value === "string" && OPAQUE_KEY.test(value)) {
      return value;
    }
  }
  return undefined;
}
