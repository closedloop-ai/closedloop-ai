import type { ChatMessage } from "./chat-providers.js";

export type ChatSessionRow = {
  id: string;
  chatKey: string;
  provider: "claude" | "codex";
  model: string;
  context: string | null;
  messages: ChatMessage[];
  sessionId: string | null;
  sessionSourceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertTurnInput = {
  chatKey: string;
  userMessage: ChatMessage;
  provider: "claude" | "codex";
  model: string;
  context?: string;
  sourceGatewayId: string;
};

export type UpsertTurnResult =
  | { ok: true; chat: ChatSessionRow; resumeSessionId: string | null }
  | { ok: false; conflict: true; boundProvider: string }
  | { ok: false; error: string };

export type CompleteTurnInput = {
  chatKey: string;
  provider: "claude" | "codex";
  messages: ChatMessage[];
  sessionId: string | null;
  sessionSourceId: string | null;
};

export type CompleteTurnResult =
  | { ok: true; chat: ChatSessionRow }
  | { ok: false; kind: "conflict"; boundProvider: string }
  | { ok: false; kind: "auth_expired"; message: string }
  | { ok: false; kind: "transient"; message: string }
  | { ok: false; kind: "permanent"; message: string };

const REQUEST_TIMEOUT_MS = 15_000;
const UPSERT_PATH = "/chat-sessions/turn";
const COMPLETE_PATH = "/chat-sessions/turn/complete";

export async function upsertTurnViaBackend(
  apiBaseUrl: string,
  token: string,
  input: UpsertTurnInput
): Promise<UpsertTurnResult> {
  const url = joinUrl(apiBaseUrl, UPSERT_PATH);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: formatFetchError(err) };
  }

  if (response.status === 200) {
    try {
      const parsed = (await response.json()) as {
        success?: boolean;
        data?: {
          chat: ChatSessionRow;
          resumeSessionId: string | null;
        };
      };
      if (parsed.success !== true || !parsed.data) {
        return {
          ok: false,
          error: "malformed success envelope in 200 response",
        };
      }
      return {
        ok: true,
        chat: parsed.data.chat,
        resumeSessionId: parsed.data.resumeSessionId ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        error: `invalid JSON in 200 response: ${formatFetchError(err)}`,
      };
    }
  }

  if (response.status === 409) {
    try {
      const parsed = (await response.json()) as {
        error?: string;
        boundProvider?: string;
      };
      const boundProvider =
        typeof parsed.boundProvider === "string"
          ? parsed.boundProvider
          : "unknown";
      return { ok: false, conflict: true, boundProvider };
    } catch (err) {
      return {
        ok: false,
        error: `invalid JSON in 409 response: ${formatFetchError(err)}`,
      };
    }
  }

  const text = await safeReadText(response);
  return { ok: false, error: `${response.status} ${text}`.trim() };
}

export async function completeTurnViaBackend(
  apiBaseUrl: string,
  token: string,
  input: CompleteTurnInput
): Promise<CompleteTurnResult> {
  const url = joinUrl(apiBaseUrl, COMPLETE_PATH);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, kind: "transient", message: formatFetchError(err) };
  }

  if (response.status === 200) {
    try {
      const parsed = (await response.json()) as {
        success?: boolean;
        data?: { chat: ChatSessionRow };
      };
      if (parsed.success !== true || !parsed.data) {
        return {
          ok: false,
          kind: "permanent",
          message: "malformed success envelope in 200 response",
        };
      }
      return { ok: true, chat: parsed.data.chat };
    } catch (err) {
      return {
        ok: false,
        kind: "permanent",
        message: `invalid JSON in 200 response: ${formatFetchError(err)}`,
      };
    }
  }

  if (response.status === 401) {
    const text = await safeReadText(response);
    return {
      ok: false,
      kind: "auth_expired",
      message: text || "authentication failed",
    };
  }

  if (response.status === 409) {
    try {
      const parsed = (await response.json()) as {
        error?: string;
        boundProvider?: string;
      };
      const boundProvider =
        typeof parsed.boundProvider === "string"
          ? parsed.boundProvider
          : "unknown";
      return { ok: false, kind: "conflict", boundProvider };
    } catch (err) {
      return {
        ok: false,
        kind: "permanent",
        message: `invalid JSON in 409 response: ${formatFetchError(err)}`,
      };
    }
  }

  const text = await safeReadText(response);
  const message = `${response.status} ${text}`.trim();
  if (response.status >= 500 && response.status < 600) {
    return { ok: false, kind: "transient", message };
  }
  return { ok: false, kind: "permanent", message };
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function formatFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `request timed out after ${REQUEST_TIMEOUT_MS}ms`;
    }
    return err.message;
  }
  return String(err);
}
