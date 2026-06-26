import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { isRecord } from "../../shared/type-guards.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import {
  type ChatSessionRow,
  type CompleteTurnInput,
  type CompleteTurnResult,
  completeTurnViaBackend,
  type UpsertTurnResult,
  upsertTurnViaBackend,
} from "./chat-backend-client.js";
import type {
  ChatMessage,
  ChatProvider,
  ProviderRegistry,
  SpawnParams,
  StreamEvent,
} from "./chat-providers.js";
import { getWebOnlyTools } from "./chat-tools.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";

type ValidatedBody = {
  chatKey: string;
  userMessage: ChatMessage;
  provider: "claude" | "codex";
  model: string | undefined;
  context: string | undefined;
  cwd: string | undefined;
  tools?: string;
  expectedMcpUrl?: string;
  apiBaseUrl: string;
  apiAuthToken: string;
};

type ResolvedBody = ValidatedBody & { tools: string };

type StreamErrorPhase = "upsert" | "spawn" | "complete";

type StreamErrorPayload = {
  phase: StreamErrorPhase;
  code: string;
  message: string;
  boundProvider?: string;
};

type PersistFailureCode =
  | "PERSISTENCE_FAILED"
  | "AUTH_EXPIRED"
  | "PROVIDER_MISMATCH";

type PersistOutcome =
  | { kind: "ok" }
  | {
      kind: "error";
      code: PersistFailureCode;
      message: string;
      boundProvider?: string;
    };

type EventForwarder = {
  readonly onEvent: (event: StreamEvent) => void;
  // Discards any events buffered during the current spawn attempt. Called
  // between the first spawn and the lazy-fallback retry so errors from the
  // failed attempt never reach the client when the retry ultimately succeeds.
  readonly reset: () => void;
  // Flushes any events buffered during the current spawn attempt to the
  // response. Called after the final spawn attempt (happy path or retry)
  // resolves, so errors from a non-retryable failure are still surfaced.
  readonly commit: () => void;
  readonly textEventsEmitted: number;
  readonly accumulatedText: string;
};

export function registerChatSessionRoutes(
  dispatcher: OperationDispatcher,
  _processManager: ProcessManager,
  registry: ProviderRegistry,
  getGatewayId: () => string
): void {
  dispatcher.register("POST", "/api/gateway/chat", async (context) => {
    const parsed = parseBody(context);
    if (parsed == null || !isRecord(parsed)) {
      json(context, 400, { error: "Invalid JSON body" });
      return;
    }
    const validation = validateBody(parsed);
    if (validation.kind === "error") {
      json(context, 400, { error: validation.message });
      return;
    }
    const body: ResolvedBody = {
      ...validation.body,
      tools:
        validation.body.tools ??
        (await getWebOnlyTools(
          validation.body.expectedMcpUrl,
          validation.body.provider
        )),
    };

    const chatProvider = registry.get(body.provider);
    if (!chatProvider) {
      const supported = registry.list().join(", ") || "(none registered)";
      json(context, 400, {
        error: `Unsupported provider: ${body.provider}. Supported: ${supported}`,
      });
      return;
    }

    const gatewayId = getGatewayId();

    setStreamingHeaders(context.response);
    writeEvent(context.response, { type: "status", status: "starting" });

    const upsertOutcome = await runUpsert(body, chatProvider, gatewayId);
    if (upsertOutcome.kind === "error") {
      writeStreamError(context.response, upsertOutcome.error);
      writeResult(context.response, false, undefined);
      writeDone(context.response);
      return;
    }
    const { row, resumeSessionId } = upsertOutcome;

    const forwarder = makeEventForwarder(context.response);
    const initialParams = buildSpawnParams(
      body,
      chatProvider,
      row,
      resumeSessionId
    );
    let spawnResult = await chatProvider.spawn(
      initialParams,
      forwarder.onEvent
    );

    if (shouldLazyFallback(spawnResult, initialParams, forwarder)) {
      forwarder.reset();
      const retryParams: SpawnParams = {
        ...initialParams,
        sessionId: undefined,
      };
      spawnResult = await chatProvider.spawn(retryParams, forwarder.onEvent);
    }

    // Flush buffered error events now that the final spawn has resolved.
    // Errors from a retried-away attempt were already dropped by reset().
    forwarder.commit();

    const assistantMessage: ChatMessage = {
      id: `assistant-${randomUUID()}`,
      role: "assistant",
      content: forwarder.accumulatedText,
      timestamp: new Date().toISOString(),
    };
    const sessionFields = buildSessionFields(spawnResult.sessionId, gatewayId);

    const persist = await persistAssistantWithRetry(
      body.apiBaseUrl,
      body.apiAuthToken,
      {
        chatKey: body.chatKey,
        provider: body.provider,
        messages: [assistantMessage],
        sessionId: sessionFields.sessionId,
        sessionSourceId: sessionFields.sessionSourceId,
      }
    );

    if (persist.kind === "error") {
      writeStreamError(context.response, {
        phase: "complete",
        code: persist.code,
        message: persist.message,
        boundProvider: persist.boundProvider,
      });
      writeResult(context.response, false, spawnResult.sessionId);
      writeDone(context.response);
      return;
    }

    writeResult(
      context.response,
      spawnResult.exitCode === 0,
      spawnResult.sessionId
    );
    writeDone(context.response);
  });
}

type UpsertOutcome =
  | { kind: "ok"; row: ChatSessionRow; resumeSessionId: string | null }
  | { kind: "error"; error: StreamErrorPayload };

async function runUpsert(
  body: ValidatedBody,
  chatProvider: ChatProvider,
  gatewayId: string
): Promise<UpsertOutcome> {
  let result: UpsertTurnResult;
  try {
    result = await upsertTurnViaBackend(body.apiBaseUrl, body.apiAuthToken, {
      chatKey: body.chatKey,
      userMessage: body.userMessage,
      provider: body.provider,
      model: body.model ?? chatProvider.defaultModel,
      context: body.context,
      sourceGatewayId: gatewayId,
    });
  } catch (err) {
    return {
      kind: "error",
      error: {
        phase: "upsert",
        code: "BACKEND_ERROR",
        message: errorMessage(err),
      },
    };
  }

  if (result.ok) {
    return {
      kind: "ok",
      row: result.chat,
      resumeSessionId: result.resumeSessionId,
    };
  }

  if ("conflict" in result) {
    return {
      kind: "error",
      error: {
        phase: "upsert",
        code: "PROVIDER_MISMATCH",
        boundProvider: result.boundProvider,
        message: `Chat is bound to provider ${result.boundProvider}`,
      },
    };
  }

  const errorText = result.error;
  const code = /^401\b/.exec(errorText) ? "AUTH_EXPIRED" : "BACKEND_ERROR";
  return {
    kind: "error",
    error: {
      phase: "upsert",
      code,
      message: errorText,
    },
  };
}

async function persistAssistantWithRetry(
  apiBaseUrl: string,
  token: string,
  input: CompleteTurnInput
): Promise<PersistOutcome> {
  let result: CompleteTurnResult = await completeTurnViaBackend(
    apiBaseUrl,
    token,
    input
  );
  if (!result.ok && result.kind === "transient") {
    result = await completeTurnViaBackend(apiBaseUrl, token, input);
  }
  if (result.ok) {
    return { kind: "ok" };
  }
  if (result.kind === "conflict") {
    return {
      kind: "error",
      code: "PROVIDER_MISMATCH",
      message: `Chat is bound to provider ${result.boundProvider}`,
      boundProvider: result.boundProvider,
    };
  }
  if (result.kind === "auth_expired") {
    return {
      kind: "error",
      code: "AUTH_EXPIRED",
      message:
        "Assistant message generated but could not be saved; your token expired mid-stream.",
    };
  }
  return {
    kind: "error",
    code: "PERSISTENCE_FAILED",
    message:
      result.message ||
      "Assistant message was generated but could not be saved; your chat may be out of sync",
  };
}

function shouldLazyFallback(
  spawnResult: { exitCode: number; retryableSessionMissing: boolean },
  params: SpawnParams,
  forwarder: EventForwarder
): boolean {
  if (spawnResult.exitCode === 0) {
    return false;
  }
  if (params.sessionId == null) {
    return false;
  }
  if (!spawnResult.retryableSessionMissing) {
    return false;
  }
  return forwarder.textEventsEmitted === 0;
}

function buildSpawnParams(
  body: ResolvedBody,
  chatProvider: ChatProvider,
  row: ChatSessionRow,
  resumeSessionId: string | null
): SpawnParams {
  return {
    model: body.model ?? row.model ?? chatProvider.defaultModel,
    messages: row.messages,
    sessionId: resumeSessionId ?? undefined,
    context: row.context ?? undefined,
    tools: body.tools,
    cwd: body.cwd,
  };
}

function buildSessionFields(
  sessionId: string | undefined,
  gatewayId: string
): { sessionId: string | null; sessionSourceId: string | null } {
  if (sessionId) {
    return { sessionId, sessionSourceId: gatewayId };
  }
  return { sessionId: null, sessionSourceId: null };
}

function makeEventForwarder(response: ServerResponse): EventForwarder {
  let text = "";
  let textCount = 0;
  // Error events are buffered instead of streamed directly so that a failed
  // first attempt followed by a successful lazy-fallback retry does not ship
  // a spurious error to the client. The buffer is dropped on reset() (first
  // attempt's errors are superseded by the retry's output) and flushed on
  // commit() (final attempt's errors surface alongside result/done).
  let pendingErrors: Record<string, unknown>[] = [];

  const onEvent = (event: StreamEvent): void => {
    if (event.type === "result" || event.type === "done") {
      return;
    }
    if (event.type === "error") {
      pendingErrors.push(event as Record<string, unknown>);
      return;
    }
    if (event.type === "text") {
      const content = (event as { content?: unknown }).content;
      if (typeof content === "string") {
        text += content;
        textCount += 1;
      }
    }
    writeEvent(response, event as Record<string, unknown>);
  };

  const reset = (): void => {
    text = "";
    textCount = 0;
    pendingErrors = [];
  };

  const commit = (): void => {
    for (const event of pendingErrors) {
      writeEvent(response, event);
    }
    pendingErrors = [];
  };

  return {
    onEvent,
    reset,
    commit,
    get textEventsEmitted(): number {
      return textCount;
    },
    get accumulatedText(): string {
      return text;
    },
  };
}

function validateBody(
  body: Record<string, unknown>
): { kind: "ok"; body: ValidatedBody } | { kind: "error"; message: string } {
  const chatKey = stringOrNull(body.chatKey);
  if (chatKey == null) {
    return { kind: "error", message: "chatKey is required" };
  }
  const apiBaseUrl = stringOrNull(body.apiBaseUrl);
  if (apiBaseUrl == null) {
    return { kind: "error", message: "apiBaseUrl is required" };
  }
  const apiAuthToken = stringOrNull(body.apiAuthToken);
  if (apiAuthToken == null) {
    return { kind: "error", message: "apiAuthToken is required" };
  }
  const providerRaw = stringOrNull(body.provider);
  if (providerRaw == null) {
    return { kind: "error", message: "provider is required" };
  }
  if (providerRaw !== "claude" && providerRaw !== "codex") {
    return { kind: "error", message: `unsupported provider: ${providerRaw}` };
  }
  const userMessage = parseUserMessage(body.userMessage);
  if (userMessage == null) {
    return { kind: "error", message: "userMessage is required" };
  }
  const cwdRaw = stringOrNull(body.cwd);
  const contextRaw = stringOrNull(body.context);
  const modelRaw = stringOrNull(body.model);
  const toolsRaw = stringOrNull(body.tools);
  const expectedMcpUrlRaw = stringOrNull(body.expectedMcpUrl);
  return {
    kind: "ok",
    body: {
      chatKey,
      apiBaseUrl,
      apiAuthToken,
      provider: providerRaw,
      userMessage,
      model: modelRaw ?? undefined,
      context: contextRaw ?? undefined,
      cwd: cwdRaw ?? undefined,
      tools: toolsRaw ?? undefined,
      expectedMcpUrl: expectedMcpUrlRaw ?? undefined,
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseUserMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const role = record.role;
  const content = record.content;
  const timestamp = record.timestamp;
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  if (role !== "user") {
    return null;
  }
  if (typeof content !== "string") {
    return null;
  }
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    return null;
  }
  const message: ChatMessage = { id, role, content, timestamp };
  if (Array.isArray(record.blocks)) {
    message.blocks = record.blocks;
  }
  return message;
}

function setStreamingHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.socket?.setNoDelay(true);
}

function writeEvent(
  response: ServerResponse,
  payload: Record<string, unknown>
): void {
  response.write(`${JSON.stringify(payload)}\n`);
}

function writeStreamError(
  response: ServerResponse,
  payload: StreamErrorPayload
): void {
  const event: Record<string, unknown> = {
    type: "error",
    phase: payload.phase,
    code: payload.code,
    message: payload.message,
  };
  if (payload.boundProvider !== undefined) {
    event.boundProvider = payload.boundProvider;
  }
  writeEvent(response, event);
}

function writeResult(
  response: ServerResponse,
  success: boolean,
  sessionId: string | undefined
): void {
  writeEvent(response, { type: "result", success, sessionId });
}

function writeDone(response: ServerResponse): void {
  writeEvent(response, { type: "done" });
  response.end();
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
