import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { OperationReceipt } from "@repo/api/src/types/attribution-evidence.js";
import { operationReceiptSchema } from "@repo/api/src/types/attribution-evidence-schema.js";
import { computeRequestFingerprint } from "@repo/api/src/utils/request-fingerprint.js";
import { z } from "zod";
import {
  currentToolCallContext,
  readClientCallId,
  runInToolCallContext,
  type ToolCallContext,
} from "./tool-call-context.js";
import { asRecord } from "./tools/tool-utils.js";

const TOOLS_CALL_METHOD = "tools/call";

/**
 * ISS-12552: the one choke point for operation evidence, on the session
 * transport rather than on each tool. Call it once, after `server.connect`.
 *
 * Each incoming `tools/call` runs inside its own call context, so the API
 * client sends the harness's call id and a fingerprint of the call's raw
 * arguments with every write. The SDK starts the handler's promise chain, and
 * the `send` of its result, synchronously inside `onmessage`, so the context
 * reaches both. The receipt a write returns lands inside the JSON body of that
 * call's text result (where `upload_artifact.py` and other parsers already
 * read the response), never as a separate line.
 *
 * Reading `_meta` here, not from the SDK's per-call `extra`, keeps every tool
 * handler free of `extra` (see `no-mcp-server-initiated-send`).
 */
export function withToolCallEvidence(transport: Transport): void {
  const receive = transport.onmessage;
  if (!receive) {
    throw new Error("withToolCallEvidence must run after server.connect");
  }
  transport.onmessage = (message, extra) => {
    const context = readToolCallContext(message);
    if (context) {
      runInToolCallContext(context, () => receive(message, extra));
    } else {
      receive(message, extra);
    }
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const context = currentToolCallContext();
    return send(
      context ? attachToToolCallResponse(message, context) : message,
      options
    );
  };
}

/** Put the receipt inside each JSON object text body and the structured body. */
export function attachOperationReceipt(
  result: unknown,
  operationReceipt: OperationReceipt
): unknown {
  const record = asRecord(result);
  if (!Array.isArray(record.content)) {
    return result;
  }
  const content = record.content.map((item: unknown) => {
    const block = asRecord(item);
    if (block.type !== "text" || typeof block.text !== "string") {
      return item;
    }
    const body = parseJsonObject(block.text);
    return body
      ? {
          ...block,
          text: JSON.stringify({ ...body, operationReceipt }, null, 2),
        }
      : item;
  });
  const structured = plainObjectSchema.safeParse(record.structuredContent).data;
  return {
    ...record,
    content,
    ...(structured
      ? { structuredContent: { ...structured, operationReceipt } }
      : {}),
  };
}

const toolCallRequestSchema = z.object({
  method: z.literal(TOOLS_CALL_METHOD),
  id: z.union([z.string(), z.number()]),
  params: z
    .object({
      name: z.string().catch(""),
      _meta: z.unknown(),
      arguments: z.unknown(),
    })
    .catch({ name: "", _meta: undefined, arguments: undefined }),
});

function readToolCallContext(message: JSONRPCMessage): ToolCallContext | null {
  const request = toolCallRequestSchema.safeParse(message).data;
  if (!request) {
    return null;
  }
  const { params } = request;
  return {
    requestId: request.id,
    clientCallId: readClientCallId(params._meta),
    // The raw arguments, as the harness sent and recorded them; a call with
    // none hashes as `{}`. A fingerprint that cannot be computed is omitted.
    requestFingerprint: computeRequestFingerprint(
      params.name,
      params.arguments ?? {}
    ).catch(() => undefined),
  };
}

function attachToToolCallResponse(
  message: JSONRPCMessage,
  context: ToolCallContext
): JSONRPCMessage {
  if (!(context.operationReceipt && "result" in message)) {
    return message;
  }
  if (message.id !== context.requestId) {
    return message;
  }
  const result = attachOperationReceipt(
    message.result,
    context.operationReceipt
  );
  const plain = plainObjectSchema.safeParse(result).data;
  return plain ? { ...message, result: plain } : message;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return plainObjectSchema.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

const plainObjectSchema = z.record(z.string(), z.unknown());

/**
 * ISS-12552: the key {@link attachOperationReceipt} adds to a tool's
 * `structuredContent`. Every tool that declares an `outputSchema` spreads this
 * into it: the SDK advertises that schema with `additionalProperties: false`,
 * and an MCP SDK client rejects a result carrying a key the schema does not
 * declare (`Client.callTool`, "Structured content does not match the tool's
 * output schema").
 */
export const operationReceiptOutputShape = {
  operationReceipt: operationReceiptSchema.optional(),
};
