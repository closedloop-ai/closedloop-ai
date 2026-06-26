import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import type { ProcessManager } from "../process-manager.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { getShellEnv, resolveBinaryFromLoginShell } from "../shell-path.js";
import { createStreamState, processStreamEvent } from "./stream-events.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: unknown[];
};

export type SpawnParams = {
  model: string;
  messages: ChatMessage[];
  sessionId?: string;
  context?: string;
  tools: string;
  cwd?: string;
};

// Providers emit non-terminal events only. The chat-session route owns the
// single `{ type: "result" }` and `{ type: "done" }` events that follow the
// provider's `spawn` resolution.
export type StreamEvent = { readonly type: string } & Record<string, unknown>;

export type SpawnResult = {
  sessionId: string | undefined;
  exitCode: number;
  // True iff the provider determined this failure was caused by an invalid or
  // missing session id passed via `--resume`. The gateway handler reads this
  // to decide whether a single retry with `sessionId: undefined` is safe.
  retryableSessionMissing: boolean;
};

export type ChatProvider = {
  readonly name: "claude" | "codex";
  readonly defaultModel: string;
  supportsModel(model: string): boolean;
  spawn(
    params: SpawnParams,
    onEvent: (event: StreamEvent) => void
  ): Promise<SpawnResult>;
};

export class ProviderRegistry {
  private readonly providers = new Map<string, ChatProvider>();

  register(provider: ChatProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ChatProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

const TERMINAL_EVENT_TYPES = new Set(["result", "done"]);

function resolveSpawnCwd(requested: string | undefined): string | undefined {
  if (!requested) {
    return undefined;
  }
  try {
    const stats = statSync(requested);
    if (stats.isDirectory()) {
      return requested;
    }
  } catch {
    // Path does not exist or is not accessible — fall through.
  }
  return undefined;
}

function renderHistoryPrompt(params: SpawnParams): string {
  const { messages, sessionId, context } = params;
  const lastMessage = messages.at(-1);
  const lastUserContent = lastMessage?.content ?? "";
  if (sessionId) {
    return lastUserContent;
  }
  const historyLines: string[] = [];
  for (const message of messages.slice(0, -1)) {
    const role = message.role === "user" ? "User" : "Assistant";
    historyLines.push(`${role}: ${message.content}`);
  }
  const parts: string[] = [];
  if (context) {
    parts.push(`<context>${context}</context>`);
  }
  if (historyLines.length > 0) {
    parts.push("", "## Conversation History", historyLines.join("\n\n"));
  }
  parts.push("", `User: ${lastUserContent}`);
  return parts.join("\n");
}

// Classifies `claude` CLI stderr as "session id passed via --resume was
// missing" so the gateway handler can retry without the session id. Captured
// from `claude -p --resume 00000000-0000-0000-0000-000000000000 "hi"` — see
// apps/desktop/test/fixtures/cli-session-missing/claude.txt. The alternates
// cover older/future phrasing variants that have been observed in the wild.
const CLAUDE_SESSION_MISSING_REGEX =
  /no conversation found with session id|session (?:id |)not found|failed to load session/i;

export class ClaudeProvider implements ChatProvider {
  readonly name = "claude" as const;
  readonly defaultModel = "claude-sonnet-4-5";

  private readonly processManager: ProcessManager;
  private readonly getShellEnv: ClaudeCodeShellEnvProvider;

  constructor(
    processManager: ProcessManager,
    getShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
  ) {
    this.processManager = processManager;
    this.getShellEnv = getShellEnv;
  }

  supportsModel(model: string): boolean {
    return model.startsWith("claude-");
  }

  async spawn(
    params: SpawnParams,
    onEvent: (event: StreamEvent) => void
  ): Promise<SpawnResult> {
    const prompt = renderHistoryPrompt(params);
    const model = params.model || this.defaultModel;
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      `--allowedTools=${params.tools}`,
      "--model",
      model,
    ];
    if (params.sessionId) {
      args.push("--resume", params.sessionId);
    }
    const shellEnv = await this.getShellEnv();
    const claudeBin = (
      await resolveBinaryFromLoginShell(
        "claude",
        getOverrideBinaryPaths()?.claude
      )
    ).path;
    const streamState = createStreamState();
    let stderrBuffer = "";

    return new Promise<SpawnResult>((resolve) => {
      let settled = false;
      const settle = (result: SpawnResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const classifyRetryable = (exitCode: number): boolean => {
        if (exitCode === 0) {
          return false;
        }
        if (params.sessionId == null) {
          return false;
        }
        return CLAUDE_SESSION_MISSING_REGEX.test(stderrBuffer);
      };

      const forwardFromStreamEvents = (line: string): void => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const type = typeof parsed.type === "string" ? parsed.type : "";
          if (TERMINAL_EVENT_TYPES.has(type)) {
            return;
          }
          onEvent(parsed as StreamEvent);
        } catch {
          // Skip lines that are not valid JSON — they carry no structured data.
        }
      };

      this.processManager
        .spawnStreaming({
          command: claudeBin,
          args,
          cwd: resolveSpawnCwd(params.cwd),
          env: shellEnv,
          input: prompt,
          onLine: (line) => {
            try {
              const rawEvent = JSON.parse(line) as Record<string, unknown>;
              processStreamEvent(
                rawEvent as never,
                streamState,
                forwardFromStreamEvents
              );
            } catch {
              // Non-JSON chatter from the CLI — ignore.
            }
          },
          onError: (error) => {
            stderrBuffer += `${error.message}\n`;
            onEvent({ type: "error", error: error.message });
          },
          onExit: (exitCode) => {
            const code = exitCode ?? 1;
            settle({
              sessionId: streamState.capturedSessionId ?? undefined,
              exitCode: code,
              retryableSessionMissing: classifyRetryable(code),
            });
          },
        })
        .then((handle) => {
          onEvent({ type: "status", status: "running", pid: handle.pid });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          onEvent({ type: "error", error: message });
          settle({
            sessionId: streamState.capturedSessionId ?? undefined,
            exitCode: 1,
            retryableSessionMissing: false,
          });
        });
    });
  }
}

// Matches the inline pattern in codex.ts (CODEX_SESSION_ID_REGEX at line 14).
const CODEX_SESSION_ID_REGEX = /session id:\s*([0-9a-f-]{36})/i;

// Classifies `codex` CLI stderr as "resume session id was missing" so the
// gateway handler can retry without the session id. Captured from
// `codex exec resume 00000000-0000-0000-0000-000000000000 "hi" --full-auto`
// — see apps/desktop/test/fixtures/cli-session-missing/codex.txt. The
// alternates cover phrasing variants that may appear in future CLI releases.
const CODEX_SESSION_MISSING_REGEX =
  /no rollout found for thread|no such session|unknown session|session (?:id |)not found/i;

export const CODEX_DEFAULT_MODEL = "gpt-5.3-codex";

function extractCodexText(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.output_text === "string") {
      return parsed.output_text;
    }
    if (typeof parsed.text === "string") {
      return parsed.text;
    }
    const item = parsed.item as Record<string, unknown> | undefined;
    if (item && typeof item.text === "string") {
      return item.text;
    }
    return "";
  } catch {
    return "";
  }
}

function extractCodexSessionId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const candidates = [
      parsed.session_id,
      (parsed.item as Record<string, unknown> | undefined)?.session_id,
      (parsed.item as Record<string, unknown> | undefined)?.sessionId,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
  } catch {
    const match = CODEX_SESSION_ID_REGEX.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export class CodexProvider implements ChatProvider {
  readonly name = "codex" as const;
  readonly defaultModel = CODEX_DEFAULT_MODEL;

  private readonly getAllowedDirectories: () => string[];

  constructor(getAllowedDirectories: () => string[]) {
    this.getAllowedDirectories = getAllowedDirectories;
  }

  supportsModel(model: string): boolean {
    return (
      model.startsWith("gpt-") ||
      model.startsWith("codex-") ||
      model.startsWith("o")
    );
  }

  async spawn(
    params: SpawnParams,
    onEvent: (event: StreamEvent) => void
  ): Promise<SpawnResult> {
    const prompt = renderHistoryPrompt(params);
    const model = params.model || this.defaultModel;
    const args = params.sessionId
      ? [
          "exec",
          "resume",
          params.sessionId,
          prompt,
          "--full-auto",
          "--json",
          "-m",
          model,
        ]
      : ["exec", "--full-auto", "--json", "-m", model, prompt];
    const resolvedCwd = resolveSpawnCwd(params.cwd);
    // Mirror the sandbox check that processManager.spawnStreaming applies to
    // ClaudeProvider. Codex uses direct child_process.spawn, so we must guard
    // the cwd explicitly to keep the two providers symmetric.
    if (resolvedCwd !== undefined) {
      try {
        assertPathAllowed(resolvedCwd, this.getAllowedDirectories());
      } catch (error) {
        const message =
          error instanceof DirectoryNotAllowedError
            ? `working directory not allowed: ${error.targetPath}`
            : error instanceof Error
              ? error.message
              : String(error);
        onEvent({ type: "error", error: message });
        return {
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: false,
        };
      }
    }

    // Resolve the login-shell PATH so `codex` installed via nvm/Homebrew is
    // discoverable in packaged Electron builds. Without this the minimal PATH
    // inherited from launchd misses ~/.nvm/versions/node/*/bin and
    // /opt/homebrew/bin and spawn fails with ENOENT. Mirrors how ClaudeProvider
    // and every other codex spawn site in the repo resolves its environment.
    const shellEnv = await getShellEnv();
    const codexBin = (
      await resolveBinaryFromLoginShell(
        "codex",
        getOverrideBinaryPaths()?.codex
      )
    ).path;

    return new Promise<SpawnResult>((resolve) => {
      let settled = false;
      const settle = (result: SpawnResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = spawn(codexBin, args, {
          cwd: resolvedCwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...shellEnv, FORCE_COLOR: "0" },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: "error", error: message });
        settle({
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: false,
        });
        return;
      }

      if (!child.pid) {
        onEvent({ type: "error", error: "failed to spawn codex process" });
        settle({
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: false,
        });
        return;
      }

      onEvent({ type: "status", status: "running", pid: child.pid });

      let capturedSessionId: string | null = null;
      let stdoutBuffer = "";
      let stderrBuffer = "";

      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        stdoutBuffer +=
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }
          const extracted = extractCodexText(line);
          if (extracted) {
            onEvent({ type: "text", content: extracted });
          }
          const sessionId = extractCodexSessionId(line);
          if (sessionId && sessionId !== capturedSessionId) {
            capturedSessionId = sessionId;
            onEvent({ type: "status", sessionId });
          }
        }
      });

      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string | Buffer) => {
        stderrBuffer +=
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      });

      child.on("error", (error) => {
        onEvent({ type: "error", error: error.message });
      });

      child.on("close", (exitCode) => {
        const code = exitCode ?? 1;
        if (code !== 0 && stderrBuffer.trim()) {
          onEvent({ type: "error", error: stderrBuffer.trim() });
        }
        const retryable =
          code !== 0 &&
          params.sessionId != null &&
          CODEX_SESSION_MISSING_REGEX.test(stderrBuffer);
        settle({
          sessionId: capturedSessionId ?? undefined,
          exitCode: code,
          retryableSessionMissing: retryable,
        });
      });
    });
  }
}
