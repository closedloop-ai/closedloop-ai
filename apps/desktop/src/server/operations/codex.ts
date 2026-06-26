import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  createWriteStream,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { inspect } from "node:util";
import type { ContentBlock } from "@closedloop-ai/loops-api/stream-types";
import { gatewayLog } from "../../main/gateway-logger.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import { DirectoryNotAllowedError } from "../security.js";
import {
  getShellEnv,
  resolveBinaryFromLoginShell,
  resolveBinaryFromLoginShellSync,
} from "../shell-path.js";
import { loadJsonFile, saveJsonFile } from "./chat-history-store.js";
import { ENGINEER_CHAT_TOOLS, withMcpTools } from "./chat-tools.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { createStreamState, processStreamEvent } from "./stream-events.js";
import { getOverrideBinaryPaths, getResolvedGitPath } from "./symphony-loop.js";
import {
  assertRepoAllowed,
  ensureWorktreeForReview,
  resolveWorktreeDir,
  resolveWorktreeParentDir,
  tryAssertPathAllowed,
  tryAssertRepoAllowed,
} from "./symphony-utils.js";

const CODEX_SESSION_ID_REGEX = /session id:\s*([0-9a-f-]{36})/i;
const CODEX_ROLLOUT_ITEM_RECORDING_DIAGNOSTIC_REGEX =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::session:\s+failed to record rollout items:\s+thread\s+[0-9a-f-]{36}\s+not found$/i;
const FINDINGS_CODE_BLOCK_REGEX = /```json\s*\n([\s\S]*?)\n\s*```/;
const FINDINGS_ARRAY_REGEX = /\[[\s\S]*\]/;
const PR_PREFIX_REGEX = /^pr-/;
const SAFE_REF_REGEX = /^[a-zA-Z0-9/_.-]+$/;

const REVIEW_SYSTEM_PROMPT = [
  "IMPORTANT: Before flagging any change, examine the surrounding context in the file, the PR description, and any linked issues.",
  "Only report findings where the issue is clearly unintentional. Skip patterns that appear to be deliberate design decisions, intentional trade-offs, or conscious simplifications.",
  "If a change looks unusual but is consistent with the overall PR intent, do not flag it.",
  "At the very end of your review, include a ```json fenced code block containing ALL findings as a JSON array.",
  'Each element must have: {"severity": "critical"|"high"|"medium"|"low",',
  '"file": "full/repo-relative/path.ts", "line": <number or null>,',
  '"title": "one-line summary", "description": "detailed explanation",',
  '"suggestion": "suggested fix or null"}.',
  'Use FULL repository-relative file paths (e.g. "src/components/Button.tsx"), not abbreviated names.',
].join(" ");

type ReviewState = {
  status: "running" | "completed" | "failed" | "stopped";
  pid?: number;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  provider: "claude" | "codex";
  sessionId?: string;
  config: {
    model: string;
    reasoningEffort: string;
    reviewMode: "uncommitted" | "base";
    baseBranch: string;
    instructions?: string;
  };
};

type PersistedFinding = {
  severity: string;
  priority?: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
  commented: boolean;
};

type FindingsFile = {
  provider: string;
  model: string;
  findings: PersistedFinding[];
  declined?: boolean;
  declineReason?: string;
};

type ReviewVerdictRequest = {
  repoPath?: unknown;
  sessionId?: unknown;
  provider?: unknown;
  expectedMcpUrl?: unknown;
};

type CodexChatState = {
  sessionId?: string;
  messageCount: number;
};

type FindingChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  blocks?: ContentBlock[];
  responded?: boolean;
};

type FindingChatHistory = {
  messages: FindingChatMessage[];
  ticketId: string;
  repoPath: string;
  findingId: string;
  findingContext?: {
    severity: string;
    priority?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  };
  sessionId?: string;
  contextPercent?: number | null;
};

function writeErrorAndEnd(response: ServerResponse, error: unknown): void {
  writeEvent(response, {
    type: "error",
    error: error instanceof Error ? error.message : "Unknown error",
  });
  writeEvent(response, { type: "done" });
  response.end();
}

/** @internal Exported for testing only. */
export async function saveCodexChatSession(
  worktreeDir: string,
  sessionId: string | undefined,
  provider: string,
  chatContextId?: string
): Promise<void> {
  if (sessionId && provider === "codex") {
    const filename =
      chatContextId === "review" ? "codex-chat-review.json" : "codex-chat.json";
    const chatStatePath = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      filename
    );
    await saveJsonFile(chatStatePath, {
      sessionId,
      messageCount: 0,
    } satisfies CodexChatState);
  }
}

function checkReviewProcess(state: ReviewState): boolean {
  if (state.status !== "running" || !state.pid) {
    return false;
  }
  const running = isProcessRunning(state.pid);
  if (!running) {
    state.status = "stopped";
  }
  return running;
}

async function readLogTail(
  logPath: string,
  maxBytes = 100 * 1024
): Promise<{ log: string; logSize: number }> {
  if (!existsSync(logPath)) {
    return { log: "", logSize: 0 };
  }
  const logStats = await fs.stat(logPath);
  const content = await fs.readFile(logPath, "utf-8");
  const truncated = logStats.size > maxBytes;
  const raw = truncated ? content.slice(-maxBytes) : content;
  return {
    log: extractTextFromNdjsonLog(raw, truncated),
    logSize: logStats.size,
  };
}

export function extractTextFromNdjsonLog(
  raw: string,
  truncated = false
): string {
  const lines = raw.split("\n");
  // When truncated, the first line is a partial JSON fragment — skip it
  if (truncated && lines.length > 1) {
    lines.shift();
  }
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: string;
        content?: string;
        error?: string;
      };
      if (event.type === "text" && typeof event.content === "string") {
        const content = stripCodexNonUserDiagnostics(event.content);
        if (content) {
          parts.push(content);
        }
      } else if (event.type === "error" && typeof event.error === "string") {
        const error = stripCodexNonUserDiagnostics(event.error);
        if (error) {
          parts.push(error);
        }
      }
    } catch {
      const content = stripCodexNonUserDiagnostics(line);
      if (content) {
        parts.push(content);
      }
    }
  }
  return parts.join("");
}

/**
 * Removes Codex CLI diagnostics that describe local rollout recording failures,
 * not model review output or actionable user-facing failures.
 */
export function stripCodexNonUserDiagnostics(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) => !CODEX_ROLLOUT_ITEM_RECORDING_DIAGNOSTIC_REGEX.test(line.trim())
    )
    .join("\n");
}

function tryKillRunningReview(state: ReviewState): void {
  if (state.status === "running" && state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // Process already dead.
    }
  }
}

async function stopAndCleanProvider(
  expandedRepoPath: string,
  ticketId: string,
  providerName: string
): Promise<string[]> {
  const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
  const paths = getReviewPaths(worktreeDir, providerName);
  const deleted: string[] = [];

  if (existsSync(paths.statePath)) {
    try {
      const state = JSON.parse(
        await fs.readFile(paths.statePath, "utf-8")
      ) as ReviewState;
      tryKillRunningReview(state);
    } catch {
      // Ignore corrupted state.
    }
  }

  for (const targetPath of [
    paths.statePath,
    paths.logPath,
    paths.pidPath,
    paths.findingsPath,
  ]) {
    if (existsSync(targetPath)) {
      await fs.rm(targetPath, { force: true });
      deleted.push(path.basename(targetPath));
    }
  }

  return deleted;
}

async function handleMarkCommented(
  context: OperationRequestContext,
  readPath: string,
  writePath: string,
  commentedIndex: number
): Promise<void> {
  if (!existsSync(readPath)) {
    json(context, 404, { error: "No findings file found" });
    return;
  }
  try {
    const data = JSON.parse(
      await fs.readFile(readPath, "utf-8")
    ) as FindingsFile;
    if (commentedIndex < 0 || commentedIndex >= data.findings.length) {
      json(context, 400, { error: "Index out of range" });
      return;
    }
    data.findings[commentedIndex].commented = true;
    await fs.mkdir(path.dirname(writePath), { recursive: true });
    await fs.writeFile(writePath, JSON.stringify(data, null, 2), "utf-8");
    json(context, 200, { success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    json(context, 500, { error: `Failed to update findings: ${message}` });
  }
}

async function handleDeclineFindings(
  context: OperationRequestContext,
  readPath: string,
  writePath: string,
  declineReason: string
): Promise<void> {
  if (!existsSync(readPath)) {
    json(context, 404, { error: "No findings file found" });
    return;
  }
  try {
    const data = JSON.parse(
      await fs.readFile(readPath, "utf-8")
    ) as FindingsFile;
    data.declined = true;
    data.declineReason = declineReason;
    await fs.mkdir(path.dirname(writePath), { recursive: true });
    await fs.writeFile(writePath, JSON.stringify(data, null, 2), "utf-8");
    json(context, 200, { success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    json(context, 500, { error: `Failed to mark declined: ${message}` });
  }
}

async function handleSaveFindings(
  context: OperationRequestContext,
  findingsPath: string,
  body: Record<string, unknown>,
  provider: string
): Promise<void> {
  const findings = (body.findings as Record<string, unknown>[]).map(
    (finding) => ({
      severity: asString(finding.severity) ?? "info",
      priority: asString(finding.priority) ?? undefined,
      file: asString(finding.file) ?? undefined,
      line: asNumber(finding.line) ?? undefined,
      message: asString(finding.message) ?? "",
      suggestion: asString(finding.suggestion) ?? undefined,
      commented: Boolean(finding.commented),
    })
  );

  const data: FindingsFile = {
    provider: asString(body.provider) ?? provider,
    model: asString(body.model) ?? "unknown",
    findings,
  };

  await fs.mkdir(path.dirname(findingsPath), { recursive: true });
  await fs.writeFile(findingsPath, JSON.stringify(data, null, 2), "utf-8");

  json(context, 200, {
    success: true,
    count: findings.length,
  });
}

export function registerCodexRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/codex/available",
    async (context) => {
      try {
        const output = await runCommand("codex", ["--version"]);
        const match = /codex-cli\s+([\d.]+)/i.exec(output);
        json(context, 200, {
          available: true,
          version: match?.[1] ?? "unknown",
        });
      } catch {
        json(context, 200, { available: false });
      }
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/codex/status/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const requestedProvider = context.query.get("provider");

      if (!ticketId) {
        json(context, 400, { error: "ticketId is required" });
        return;
      }
      if (!repoPath) {
        json(context, 400, { error: "repo query parameter is required" });
        return;
      }

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }

      const worktreeDir = resolveWorktreeDir(repoResult.path, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 200, {
          hasReview: false,
          worktreeDir,
          message: "Worktree not found",
        });
        return;
      }

      const pathResult = tryAssertPathAllowed(
        worktreeDir,
        getAllowedDirectories()
      );
      if (pathResult !== true) {
        json(context, pathResult.status, { error: pathResult.error });
        return;
      }

      const provider =
        requestedProvider &&
        (requestedProvider === "claude" || requestedProvider === "codex")
          ? requestedProvider
          : resolveProvider(worktreeDir);

      if (!provider) {
        json(context, 200, {
          hasReview: false,
          worktreeDir,
          message: "No review has been started",
        });
        return;
      }

      const { statePath, logPath } = getReviewPaths(worktreeDir, provider);
      if (!existsSync(statePath)) {
        json(context, 200, {
          hasReview: false,
          worktreeDir,
          message: "No review has been started",
        });
        return;
      }

      try {
        const state = JSON.parse(
          await fs.readFile(statePath, "utf-8")
        ) as ReviewState;
        const processRunning = checkReviewProcess(state);
        const { log, logSize } = await readLogTail(logPath);

        json(context, 200, {
          hasReview: true,
          worktreeDir,
          status: state.status,
          processRunning,
          pid: state.pid,
          provider: state.provider,
          sessionId: state.sessionId,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          exitCode: state.exitCode,
          config: state.config,
          log,
          logSize,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, { error: `Failed to read status: ${message}` });
      }
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/codex/status/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const provider = context.query.get("provider");

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repo are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const providers = provider ? [provider] : ["claude", "codex"];

      await Promise.all(
        providers.flatMap((name) => {
          const paths = getReviewPaths(worktreeDir, name);
          return [
            paths.statePath,
            paths.logPath,
            paths.pidPath,
            paths.findingsPath,
          ].map(async (targetPath) => {
            await fs.rm(targetPath, { force: true });
          });
        })
      );

      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/stop/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repo);
      const provider = asProvider(body.provider) ?? "codex";

      if (!ticketId) {
        json(context, 400, { error: "ticketId is required" });
        return;
      }
      if (!repoPath) {
        json(context, 400, { error: "repo is required in body" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const { statePath } = getReviewPaths(worktreeDir, provider);

      if (!existsSync(statePath)) {
        json(context, 404, { error: "No review found" });
        return;
      }

      try {
        const state = JSON.parse(
          await fs.readFile(statePath, "utf-8")
        ) as ReviewState;
        if (state.status !== "running") {
          json(context, 200, {
            stopped: false,
            message: `Review is not running (status: ${state.status})`,
          });
          return;
        }

        if (!state.pid) {
          json(context, 400, { error: "No PID found for review" });
          return;
        }

        try {
          process.kill(state.pid, "SIGTERM");
        } catch {
          // Process may have already exited.
        }

        await fs.mkdir(path.dirname(statePath), { recursive: true });
        const updatedState: ReviewState = {
          ...state,
          status: "stopped",
          completedAt: new Date().toISOString(),
        };
        await fs.writeFile(
          statePath,
          JSON.stringify(updatedState, null, 2),
          "utf-8"
        );

        json(context, 200, { stopped: true, pid: state.pid });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        json(context, 500, { error: `Failed to stop review: ${message}` });
      }
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/codex/stop/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const provider = context.query.get("provider");

      if (!repoPath) {
        json(context, 400, { error: "repo query param is required" });
        return;
      }

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }

      const providers = provider ? [provider] : ["claude", "codex"];
      const results = await Promise.all(
        providers.map((name) =>
          stopAndCleanProvider(repoResult.path, ticketId, name)
        )
      );

      json(context, 200, { deleted: results.flat() });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/codex/review-findings/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const provider = context.query.get("provider") ?? "codex";

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repo are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const findingsPath = getReviewPaths(
        resolveWorktreeDir(expandedRepoPath, ticketId),
        provider
      ).findingsPath;
      if (!existsSync(findingsPath)) {
        json(context, 200, { findings: [] });
        return;
      }

      try {
        const content = await fs.readFile(findingsPath, "utf-8");
        json(context, 200, JSON.parse(content));
      } catch {
        json(context, 200, { findings: [] });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/review-findings/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");
      const provider = context.query.get("provider") ?? "codex";
      const body = parseBody(context);

      if (!(ticketId && repoPath)) {
        json(context, 400, { error: "ticketId and repo are required" });
        return;
      }
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }

      const worktreeDir = resolveWorktreeDir(repoResult.path, ticketId);
      const findingsPath = getReviewPaths(worktreeDir, provider).findingsPath;

      if (typeof body.commentedIndex === "number") {
        await handleMarkCommented(
          context,
          findingsPath,
          findingsPath,
          body.commentedIndex
        );
        return;
      }

      if (
        body.declined === true &&
        typeof body.declineReason === "string" &&
        body.declineReason.trim().length > 0
      ) {
        await handleDeclineFindings(
          context,
          findingsPath,
          findingsPath,
          body.declineReason
        );
        return;
      }

      if (!Array.isArray(body.findings)) {
        json(context, 400, { error: "Invalid request body" });
        return;
      }

      await handleSaveFindings(context, findingsPath, body, provider);
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/review-dedup/:ticketId",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid or empty JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const providerA = asString(body.providerA);
      const providerB = asString(body.providerB);
      const findingsA = Array.isArray(body.findingsA) ? body.findingsA : [];
      const findingsB = Array.isArray(body.findingsB) ? body.findingsB : [];

      if (!(repoPath && providerA && providerB)) {
        json(context, 400, {
          error: "repoPath, providerA, and providerB are required",
        });
        return;
      }

      try {
        assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      if (findingsA.length === 0 || findingsB.length === 0) {
        json(context, 200, { duplicates: [] });
        return;
      }

      const duplicates = findDuplicatePairs(
        findingsA as Record<string, unknown>[],
        findingsB as Record<string, unknown>[]
      );
      json(context, 200, { duplicates });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/review-extract/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid or empty JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const sessionId = asString(body.sessionId);

      if (!(repoPath && sessionId)) {
        json(context, 400, { error: "repoPath and sessionId are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const workDir = path.join(worktreeDir, ".closedloop-ai", "work");

      let raw = "";
      for (const fileName of [
        "codex-review-claude.log",
        "codex-review-codex.log",
      ]) {
        const candidate = path.join(workDir, fileName);
        if (existsSync(candidate)) {
          raw = await fs.readFile(candidate, "utf-8");
          if (raw.trim()) {
            break;
          }
        }
      }

      const findings = parseFindingsFromText(raw);
      json(context, 200, { findings });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/review-verdict/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid or empty JSON body" });
        return;
      }

      const requestBody = body as ReviewVerdictRequest;
      const repoPath = asString(requestBody.repoPath);
      const sessionId = asString(requestBody.sessionId);
      const provider = asProvider(requestBody.provider);
      const expectedMcpUrl = asString(requestBody.expectedMcpUrl) ?? undefined;

      if (!(repoPath && sessionId && provider)) {
        json(context, 400, {
          error: "repoPath, sessionId, and provider are required",
        });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);

      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      try {
        gatewayLog.debug(
          "review-verdict",
          `Starting verdict extraction for ${ticketId}, provider=${provider}, session=${sessionId}`
        );
        const collected =
          provider === "codex"
            ? await runCodexVerdict(worktreeDir, sessionId)
            : await runClaudeVerdict(
                worktreeDir,
                sessionId,
                getClaudeShellEnv,
                expectedMcpUrl
              );

        gatewayLog.debug(
          "review-verdict",
          `Collected ${collected.length} chars of output`
        );

        const verdict = extractVerdictTag(collected);
        if (verdict) {
          gatewayLog.debug(
            "review-verdict",
            `Extracted verdict: ${verdict.verdict} -- ${verdict.reason}`
          );
        } else {
          gatewayLog.debug("review-verdict", "No verdict tag found in output");
        }

        json(context, 200, { verdict: verdict ?? null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        gatewayLog.error("review-verdict", `Extraction failed: ${msg}`);
        json(context, 200, { verdict: null, error: msg });
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/review/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);

      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = asString(body.repoPath);
      const model = asString(body.model) ?? "gpt-5.3-codex";
      const reasoningEffort = asString(body.reasoningEffort) ?? "medium";
      const reviewMode =
        body.reviewMode === "uncommitted" ? "uncommitted" : "base";
      const baseBranch = asString(body.baseBranch) ?? "main";
      const instructions = asString(body.instructions) ?? undefined;
      const provider = asProvider(body.provider) ?? "codex";
      const branchName = asString(body.branchName) ?? undefined;
      const useBaseRepo = body.useBaseRepo === true;

      if (!repoPath) {
        json(context, 400, { error: "repoPath is required" });
        return;
      }

      const repoResult = tryAssertRepoAllowed(
        repoPath,
        getAllowedDirectories()
      );
      if ("error" in repoResult) {
        json(context, repoResult.status, { error: repoResult.error });
        return;
      }
      const expandedRepoPath = repoResult.path;

      // Validate the worktree parent directory is allowed (worktree may not exist yet)
      const worktreeParentResult = tryAssertPathAllowed(
        resolveWorktreeParentDir(expandedRepoPath),
        getAllowedDirectories()
      );
      if (worktreeParentResult !== true) {
        json(context, worktreeParentResult.status, {
          error: worktreeParentResult.error,
        });
        return;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);

      // Create or update worktree (unless useBaseRepo is set)
      const worktreeError = ensureWorktreeForReview(
        expandedRepoPath,
        worktreeDir,
        branchName,
        useBaseRepo,
        baseBranch
      );
      if (worktreeError) {
        json(context, worktreeError.status, { error: worktreeError.message });
        return;
      }

      // Process cwd: use base repo when requested, otherwise use worktree
      const reviewCwd = useBaseRepo ? expandedRepoPath : worktreeDir;

      const { statePath, logPath, pidPath } = getReviewPaths(
        worktreeDir,
        provider
      );
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(logPath, "", "utf-8");

      if (provider === "claude" && !ticketId.startsWith("pr-")) {
        json(context, 400, {
          error: "ticketId must start with 'pr-' for Claude reviews",
        });
        return;
      }

      // Detect merged PRs where HEAD == merge-base (empty diff).
      // Apply the GitHub PR diff as uncommitted changes and switch to --uncommitted mode.
      const effectiveReviewMode = resolveEffectiveReviewMode(
        reviewCwd,
        baseBranch,
        ticketId,
        reviewMode,
        useBaseRepo,
        provider
      );

      setStreamingHeaders(context.response);

      try {
        const child =
          provider === "claude"
            ? await resolveClaudeReviewProcess(
                reviewCwd,
                model,
                ticketId.slice(3),
                logPath,
                getClaudeShellEnv
              )
            : await spawnCodexReviewProcess({
                cwd: reviewCwd,
                model,
                reasoningEffort,
                reviewMode: effectiveReviewMode,
                baseBranch,
                instructions,
              });

        if (!child.pid) {
          throw new Error("failed to start review process");
        }

        const state: ReviewState = {
          status: "running",
          pid: child.pid,
          startedAt: new Date().toISOString(),
          provider,
          config: {
            model,
            reasoningEffort,
            reviewMode,
            baseBranch,
            instructions,
          },
        };

        await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
        await fs.writeFile(pidPath, String(child.pid), "utf-8");

        writeEvent(context.response, {
          type: "status",
          status: "running",
          pid: child.pid,
          provider,
        });

        const sessionIdHolder: { value: string | undefined } = {
          value: undefined,
        };
        const stderrHolder: { value: string } = { value: "" };
        const streamFn =
          provider === "claude" ? streamClaudeReview : streamCodexReview;
        const exitPromise = waitForExit(child).catch(() => 1);
        await streamFn(
          child,
          context.response,
          logPath,
          sessionIdHolder,
          stderrHolder
        );
        const exitCode = await exitPromise;

        // Detect context window exhaustion — codex exited mid-review, findings are incomplete
        const isContextError =
          exitCode !== 0 &&
          /context window|out of room/i.test(stderrHolder.value);

        const stderrForUser = stripCodexNonUserDiagnostics(
          stderrHolder.value
        ).trim();
        if (exitCode !== 0 && !isContextError && stderrForUser) {
          writeEvent(context.response, { type: "error", error: stderrForUser });
        }

        const finalState: ReviewState = {
          ...state,
          status: exitCode === 0 ? "completed" : "failed",
          completedAt: new Date().toISOString(),
          exitCode,
          sessionId: sessionIdHolder.value,
        };
        await fs.writeFile(
          statePath,
          JSON.stringify(finalState, null, 2),
          "utf-8"
        );
        await fs.rm(pidPath, { force: true });

        await saveCodexChatSession(
          worktreeDir,
          sessionIdHolder.value,
          provider,
          "review"
        );

        if (isContextError) {
          // Send terminal error — client will show error toast instead of "completed"
          writeEvent(context.response, {
            type: "error",
            terminal: true,
            error:
              "Review interrupted: codex ran out of context window space. Partial findings may appear above.",
          });
        } else {
          writeEvent(context.response, {
            type: "result",
            success: exitCode === 0,
          });
          writeEvent(context.response, { type: "done" });
        }
        context.response.end();
      } catch (error) {
        writeErrorAndEnd(context.response, error);
      }
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/argue/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoQuery = context.query.get("repo");
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const repoPath = repoQuery ?? asString(body.repoPath);
      const claudeArgument = asString(body.claudeArgument);
      const findingSummary = asString(body.findingSummary);
      const model = asString(body.model) ?? "gpt-5.3-codex";

      if (!repoPath) {
        json(context, 400, { error: "repo parameter is required" });
        return;
      }

      if (!(claudeArgument && findingSummary)) {
        json(context, 400, {
          error: "claudeArgument and findingSummary are required",
        });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const debateWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
      const debateStatePath = path.join(debateWorkDir, "codex-debate.json");
      const debateState = await loadJsonFile<{
        sessionId?: string;
        rounds: number;
      }>(debateStatePath, {
        rounds: 0,
      });

      const prompt = [
        "You are OpenAI Codex in a structured debate with Claude about a review finding.",
        "Focus on concrete code evidence and keep your response concise.",
        "Finding:",
        findingSummary,
        "Claude's argument:",
        claudeArgument,
      ].join("\n\n");

      setStreamingHeaders(context.response);

      const args = debateState.sessionId
        ? [
            "exec",
            "resume",
            debateState.sessionId,
            prompt,
            "--full-auto",
            "--json",
            "-m",
            model,
          ]
        : ["exec", "--full-auto", "--json", "-m", model, prompt];

      await streamCodexConversation(
        context.response,
        worktreeDir,
        args,
        async (sessionId) => {
          debateState.sessionId = sessionId;
          debateState.rounds += 1;
          await saveJsonFile(debateStatePath, debateState);
        }
      );
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/chat/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const prompt = asString(body.prompt);
      const repoPath = asString(body.repoPath);
      const model = asString(body.model) ?? "gpt-5.3-codex";

      if (!(prompt && repoPath)) {
        json(context, 400, { error: "prompt and repoPath are required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const defaultWorktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const worktreeDir = existsSync(defaultWorktreeDir)
        ? defaultWorktreeDir
        : expandedRepoPath;

      const chatContextId = asString(body.chatContextId);
      const stateFilename =
        chatContextId === "review"
          ? "codex-chat-review.json"
          : "codex-chat.json";
      const statePath = path.join(
        worktreeDir,
        ".closedloop-ai",
        "work",
        stateFilename
      );
      const chatState = await loadJsonFile<CodexChatState>(statePath, {
        messageCount: 0,
      });

      const args = chatState.sessionId
        ? [
            "exec",
            "resume",
            chatState.sessionId,
            prompt,
            "--full-auto",
            "--json",
            "-m",
            model,
          ]
        : ["exec", "--full-auto", "--json", "-m", model, prompt];

      setStreamingHeaders(context.response);

      await streamCodexConversation(
        context.response,
        worktreeDir,
        args,
        async (sessionId) => {
          chatState.sessionId = sessionId;
          chatState.messageCount += 1;
          await saveJsonFile(statePath, chatState);
        }
      );
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/codex/finding-chat/:findingId",
    async (context) => {
      const findingId = context.params.findingId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
        });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const historyPath = getFindingHistoryPath(
        ticketId,
        expandedRepoPath,
        findingId
      );
      const history = await loadJsonFile<FindingChatHistory>(historyPath, {
        messages: [],
        ticketId,
        repoPath,
        findingId,
      });

      json(context, 200, history);
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/codex/finding-chat/:findingId",
    async (context) => {
      const findingId = context.params.findingId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
        });
        return;
      }

      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const message = asString(body.message);
      const displayMessage = asString(body.displayMessage);
      const findingContext =
        body.findingContext instanceof Object
          ? (body.findingContext as FindingChatHistory["findingContext"])
          : undefined;

      if (!message) {
        json(context, 400, { error: "message is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const historyPath = getFindingHistoryPath(
        ticketId,
        expandedRepoPath,
        findingId
      );
      const history = await loadJsonFile<FindingChatHistory>(historyPath, {
        messages: [],
        ticketId,
        repoPath,
        findingId,
      });

      history.findingContext = findingContext ?? history.findingContext;

      const userMessage: FindingChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: displayMessage ?? message,
        timestamp: new Date().toISOString(),
      };

      history.messages.push(userMessage);
      await saveJsonFile(historyPath, history);

      setStreamingHeaders(context.response);

      const streamState = createStreamState(async (sessionId) => {
        history.sessionId = sessionId;
        await saveJsonFile(historyPath, history);
      });

      const prompt = buildFindingPrompt(
        history.findingContext,
        message,
        history.messages
      );

      const args = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--allowedTools",
        await withMcpTools(ENGINEER_CHAT_TOOLS),
        ...(history.sessionId ? ["--resume", history.sessionId] : []),
      ];

      try {
        const claudeBin = (
          await resolveBinaryFromLoginShell(
            "claude",
            getOverrideBinaryPaths()?.claude
          )
        ).path;
        const child = spawn(claudeBin, args, {
          cwd: worktreeDir,
          stdio: ["pipe", "pipe", "pipe"],
          env: await getClaudeShellEnv(),
        });

        if (!child.pid) {
          throw new Error("failed to spawn claude process");
        }

        writeEvent(context.response, {
          type: "status",
          status: "running",
          pid: child.pid,
        });

        child.stdout.setEncoding("utf-8");
        let buffer = "";
        child.stdout.on("data", (chunk: string | Buffer) => {
          buffer += String(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              processStreamEvent(event as never, streamState, (msg) =>
                context.response.write(`${msg}\n`)
              );
            } catch {
              // Ignore malformed lines.
            }
          }
        });

        let stderrBuffer = "";
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string | Buffer) => {
          stderrBuffer += String(chunk);
        });

        child.stdin.write(prompt);
        child.stdin.end();

        const exitCode = await waitForExit(child);

        if (exitCode !== 0 && stderrBuffer.trim()) {
          writeEvent(context.response, {
            type: "error",
            error: stderrBuffer.trim(),
          });
        }

        if (streamState.assistantContent.trim()) {
          history.messages.push({
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: streamState.assistantContent.trim(),
            timestamp: new Date().toISOString(),
            blocks: streamState.assistantBlocks,
          });
        }
        history.contextPercent = streamState.contextPercent;
        if (
          exitCode !== 0 &&
          streamState.authChallengeDetected &&
          history.sessionId
        ) {
          history.sessionId = undefined;
        }
        await saveJsonFile(historyPath, history);

        writeEvent(context.response, {
          type: "result",
          success: exitCode === 0,
        });
        writeEvent(context.response, { type: "done" });
        context.response.end();
      } catch (error) {
        writeEvent(context.response, {
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
        writeEvent(context.response, { type: "done" });
        context.response.end();
      }
    }
  );

  dispatcher.register(
    "PATCH",
    "/api/gateway/codex/finding-chat/:findingId",
    async (context) => {
      const findingId = context.params.findingId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
        });
        return;
      }

      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const messageId = asString(body.messageId);
      const responded =
        typeof body.responded === "boolean" ? body.responded : true;

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const historyPath = getFindingHistoryPath(
        ticketId,
        expandedRepoPath,
        findingId
      );
      const history = await loadJsonFile<FindingChatHistory>(historyPath, {
        messages: [],
        ticketId,
        repoPath,
        findingId,
      });

      const target = messageId
        ? history.messages.find((message) => message.id === messageId)
        : [...history.messages]
            .reverse()
            .find((message) => message.role === "assistant");
      if (target) {
        target.responded = responded;
      }

      await saveJsonFile(historyPath, history);
      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/codex/finding-chat/:findingId",
    async (context) => {
      const findingId = context.params.findingId;
      const ticketId = context.query.get("ticketId");
      const repoPath = context.query.get("repo");

      if (!(ticketId && repoPath)) {
        json(context, 400, {
          error: "ticketId and repo parameters are required",
        });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      const sanitizedFinding = findingId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
      const findingFile = path.join(
        "finding-chats",
        `${sanitizedFinding}.json`
      );
      await fs.rm(
        path.join(worktreeDir, ".closedloop-ai", "work", findingFile),
        { force: true }
      );
      json(context, 200, { success: true });
    }
  );
}

function asProvider(value: unknown): "claude" | "codex" | null {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return null;
}

function resolveProvider(worktreeDir: string): "claude" | "codex" | null {
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  if (existsSync(path.join(workDir, "codex-review-claude.json"))) {
    return "claude";
  }
  if (existsSync(path.join(workDir, "codex-review-codex.json"))) {
    return "codex";
  }
  return null;
}

/** Resolve review file paths from .closedloop-ai/work. */
function getReviewPaths(
  worktreeDir: string,
  provider: string
): {
  workDir: string;
  statePath: string;
  logPath: string;
  pidPath: string;
  findingsPath: string;
} {
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  return {
    workDir,
    statePath: path.join(workDir, `codex-review-${provider}.json`),
    logPath: path.join(workDir, `codex-review-${provider}.log`),
    pidPath: path.join(workDir, `codex-review-${provider}.pid`),
    findingsPath: path.join(workDir, `review-findings-${provider}.json`),
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseFindingsFromText(text: string): PersistedFinding[] {
  const jsonContent = extractJsonArray(text);
  if (!jsonContent) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonContent) as Record<string, unknown>[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((entry) => {
      const severity = normalizeSeverity(asString(entry.severity) ?? "low");
      return {
        severity,
        priority: mapPriority(severity),
        file: asString(entry.file) ?? undefined,
        line: asNumber(entry.line) ?? undefined,
        message: buildMessage(
          asString(entry.title),
          asString(entry.description)
        ),
        suggestion: asString(entry.suggestion) ?? undefined,
        commented: false,
      };
    });
  } catch {
    return [];
  }
}

function extractJsonArray(text: string): string | null {
  const codeBlock = FINDINGS_CODE_BLOCK_REGEX.exec(text);
  if (codeBlock?.[1]) {
    return codeBlock[1];
  }

  const arrayMatch = FINDINGS_ARRAY_REGEX.exec(text);
  if (arrayMatch?.[0]) {
    return arrayMatch[0];
  }

  return null;
}

function buildMessage(
  title: string | null,
  description: string | null
): string {
  if (title && description) {
    return `${title}\n${description}`;
  }
  return title ?? description ?? "";
}

function normalizeSeverity(value: string): string {
  const lower = value.toLowerCase();
  if (
    lower === "critical" ||
    lower === "high" ||
    lower === "medium" ||
    lower === "low"
  ) {
    return lower;
  }
  return "low";
}

function mapPriority(severity: string): string {
  if (severity === "critical") {
    return "P0";
  }
  if (severity === "high") {
    return "P1";
  }
  if (severity === "medium") {
    return "P2";
  }
  return "P3";
}

function findDuplicatePairs(
  findingsA: Record<string, unknown>[],
  findingsB: Record<string, unknown>[]
): [number, number][] {
  const usedB = new Set<number>();
  const duplicates: [number, number][] = [];

  for (let indexA = 0; indexA < findingsA.length; indexA += 1) {
    const findingA = findingsA[indexA];
    const messageA = normalizeFindingText(asString(findingA.message) ?? "");
    const fileA = asString(findingA.file) ?? "";

    let matchedIndexB: number | null = null;
    let bestScore = 0;

    for (let indexB = 0; indexB < findingsB.length; indexB += 1) {
      if (usedB.has(indexB)) {
        continue;
      }

      const findingB = findingsB[indexB];
      const messageB = normalizeFindingText(asString(findingB.message) ?? "");
      const fileB = asString(findingB.file) ?? "";

      const score = similarityScore(messageA, messageB, fileA, fileB);
      if (score > bestScore) {
        bestScore = score;
        matchedIndexB = indexB;
      }
    }

    if (matchedIndexB !== null && bestScore >= 0.6) {
      duplicates.push([indexA, matchedIndexB]);
      usedB.add(matchedIndexB);
    }
  }

  return duplicates;
}

function normalizeFindingText(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function similarityScore(
  messageA: string,
  messageB: string,
  fileA: string,
  fileB: string
): number {
  if (!(messageA && messageB)) {
    return 0;
  }

  const wordsA = new Set(messageA.split(" ").filter(Boolean));
  const wordsB = new Set(messageB.split(" ").filter(Boolean));
  const intersection = [...wordsA].filter((word) => wordsB.has(word)).length;
  const union = new Set([...wordsA, ...wordsB]).size;

  let score = union > 0 ? intersection / union : 0;
  if (fileA && fileB && fileA === fileB) {
    score += 0.25;
  }
  if (messageA.slice(0, 80) === messageB.slice(0, 80)) {
    score += 0.25;
  }

  return Math.min(score, 1);
}

async function spawnClaudeReview(
  cwd: string,
  model: string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider
): Promise<ChildProcess> {
  const allowedTools = await withMcpTools("Bash,Read,Glob,Grep,Task,TodoWrite");
  const claudeBin = (
    await resolveBinaryFromLoginShell(
      "claude",
      getOverrideBinaryPaths()?.claude
    )
  ).path;
  return spawn(
    claudeBin,
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      model,
      "--allowedTools",
      allowedTools,
      "--append-system-prompt",
      REVIEW_SYSTEM_PROMPT,
    ],
    {
      cwd,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: await getClaudeShellEnv(),
    }
  );
}

/**
 * Try spawning Claude with /code-review:start skill first.
 * If the process exits without producing real model output (only system/init/result
 * events), fall back to /review <prNum>.
 */
async function resolveClaudeReviewProcess(
  cwd: string,
  model: string,
  prNum: string,
  logPath: string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider
): Promise<ChildProcess> {
  const first = await spawnClaudeReview(cwd, model, getClaudeShellEnv);
  first.stdin?.write("/code-review:start");
  first.stdin?.end();

  type ProbeResult = { type: "working" } | { type: "exited"; code: number };

  // Collect all stdout chunks during probe so we can replay them for consumers
  const probeChunks: Buffer[] = [];

  const result = await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let probeBuf = "";
    const settle = (r: ProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      first.stdout?.removeListener("data", onData);
      resolve(r);
    };

    // Safety timeout: if 60s pass with no real output and no exit, assume it's working
    const timer = setTimeout(() => settle({ type: "working" }), 60_000);

    // Ignore system/init/result events (CLI initialization + empty completion).
    // Only treat real model activity as "working".
    const INIT_EVENTS = new Set(["system", "init", "result"]);

    const onData = (chunk: Buffer) => {
      probeChunks.push(chunk);
      probeBuf += chunk.toString();
      const lines = probeBuf.split("\n");
      probeBuf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed);
          if (!INIT_EVENTS.has(event.type)) {
            settle({ type: "working" });
            return;
          }
        } catch {
          // Non-JSON output = real content
          settle({ type: "working" });
          return;
        }
      }
    };

    first.stdout?.on("data", onData);

    first.on("close", (code) => {
      settle({ type: "exited", code: code ?? 1 });
    });
  });

  if (result.type === "working") {
    // Replay consumed probe data so stream consumers see it
    for (const chunk of [...probeChunks].reverse()) {
      first.stdout?.unshift(chunk);
    }
    return first;
  }

  // Skill exited without producing review content — fall back to /review <prNum>
  await fs.writeFile(logPath, "", "utf-8");

  const fallback = await spawnClaudeReview(cwd, model, getClaudeShellEnv);
  fallback.stdin?.write(`/review ${prNum}`);
  fallback.stdin?.end();
  return fallback;
}

/**
 * Detect when a worktree is on the merge-base (merged PR) and apply the PR diff
 * as uncommitted changes so codex can review with --uncommitted instead of --base.
 */
function resolveEffectiveReviewMode(
  worktreeDir: string,
  baseBranch: string,
  ticketId: string,
  reviewMode: "uncommitted" | "base",
  useBaseRepo: boolean,
  provider: string
): "uncommitted" | "base" {
  if (useBaseRepo || provider !== "codex" || reviewMode !== "base") {
    return reviewMode;
  }
  try {
    if (!SAFE_REF_REGEX.test(baseBranch)) {
      return reviewMode;
    }
    const gitBin = getResolvedGitPath();
    const headSha = execSync(`${gitBin} rev-parse HEAD`, {
      cwd: worktreeDir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const mergeBaseResult = spawnSync(
      gitBin,
      ["merge-base", "HEAD", `origin/${baseBranch}`],
      { cwd: worktreeDir, encoding: "utf-8", timeout: 10_000 }
    );
    const mergeBase = (mergeBaseResult.stdout as string).trim();
    if (mergeBase !== headSha) {
      return reviewMode; // Not a merged PR — normal diff exists
    }
    // HEAD == merge-base → merged PR, apply the PR diff as uncommitted changes
    return applyMergedPrDiff(worktreeDir, ticketId);
  } catch (err) {
    gatewayLog.warn(
      "codex-review",
      `Merged PR detection failed, falling back to --base: ${inspect(err, { depth: 2 })}`
    );
  }
  return reviewMode;
}

function applyMergedPrDiff(
  worktreeDir: string,
  ticketId: string
): "uncommitted" | "base" {
  const prNum = ticketId.replace(PR_PREFIX_REGEX, "");
  if (!/^\d+$/.test(prNum)) {
    return "base";
  }
  gatewayLog.debug("codex-review", "Merged PR detected. Applying gh pr diff.");

  const ghBin = resolveBinaryFromLoginShellSync(
    "gh",
    getOverrideBinaryPaths()?.gh
  ).path;
  const diffResult = spawnSync(ghBin, ["pr", "diff", prNum], {
    cwd: worktreeDir,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  const diff = (diffResult.stdout as string) ?? "";
  if (!diff.trim()) {
    gatewayLog.debug("codex-review", "gh pr diff returned empty");
    return "base";
  }

  // Checkout the merge commit's parent so the diff applies cleanly
  const mergeOidResult = spawnSync(
    ghBin,
    ["pr", "view", prNum, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"],
    { cwd: worktreeDir, encoding: "utf-8", timeout: 30_000 }
  );
  const mergeOid = (mergeOidResult.stdout as string).trim();
  if (mergeOid) {
    const gitBin = getResolvedGitPath();
    const baseCommitResult = spawnSync(gitBin, ["rev-parse", `${mergeOid}^1`], {
      cwd: worktreeDir,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const baseCommit = (baseCommitResult.stdout as string).trim();
    if (!baseCommit || baseCommitResult.status !== 0) {
      gatewayLog.warn(
        "codex-review",
        "Failed to resolve base commit for merged PR"
      );
      return "base";
    }
    const checkoutResult = spawnSync(
      gitBin,
      ["checkout", "--detach", baseCommit],
      {
        cwd: worktreeDir,
        stdio: "pipe",
        timeout: 10_000,
      }
    );
    if (checkoutResult.status !== 0) {
      gatewayLog.warn(
        "codex-review",
        `Failed to checkout base commit: ${baseCommit}`
      );
      return "base";
    }
  }

  const gitBin2 = getResolvedGitPath();
  const patchPath = path.join(worktreeDir, ".pr-review-diff.patch");
  writeFileSync(patchPath, diff);
  try {
    execFileSync(gitBin2, ["apply", patchPath], {
      cwd: worktreeDir,
      stdio: "pipe",
    });
  } catch (err) {
    gatewayLog.warn(
      "codex-review",
      `Failed to apply PR diff: ${inspect(err, { depth: 2 })}`
    );
    unlinkSync(patchPath);
    return "base";
  }
  unlinkSync(patchPath);
  gatewayLog.debug("codex-review", "PR diff applied as uncommitted changes");
  return "uncommitted";
}

async function spawnCodexReviewProcess(options: {
  cwd: string;
  model: string;
  reasoningEffort: string;
  reviewMode: "uncommitted" | "base";
  baseBranch: string;
  instructions?: string;
}): Promise<ChildProcess> {
  const args: string[] = ["review"];
  if (options.reviewMode === "uncommitted") {
    args.push("--uncommitted");
  } else {
    args.push("--base", options.baseBranch);
  }

  args.push(
    "-c",
    `model=${options.model}`,
    "-c",
    `model_reasoning_effort=${options.reasoningEffort}`
  );

  const codexBin = (
    await resolveBinaryFromLoginShell("codex", getOverrideBinaryPaths()?.codex)
  ).path;
  return spawn(codexBin, args, {
    cwd: options.cwd,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: await getShellEnv({ FORCE_COLOR: "0" }),
  });
}

async function streamClaudeReview(
  child: ChildProcess,
  response: ServerResponse,
  logPath: string,
  sessionIdHolder: { value: string | undefined },
  stderrHolder: { value: string }
): Promise<void> {
  const streamState = createStreamState((sessionId) => {
    sessionIdHolder.value = sessionId;
  });

  child.stdout?.setEncoding("utf-8");
  let buffer = "";

  const logStream = createWriteStream(logPath, {
    flags: "a",
    encoding: "utf-8",
  });

  child.stdout?.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        processStreamEvent(event as never, streamState, (message) => {
          response.write(`${message}\n`);
          logStream.write(`${message}\n`);
        });
      } catch {
        const fallback = JSON.stringify({ type: "text", content: line });
        response.write(`${fallback}\n`);
        logStream.write(`${fallback}\n`);
      }
    }
  });

  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    logStream.write(text);
    stderrHolder.value += text;
  });

  child.on("close", () => {
    logStream.end();
  });
}

/** @internal Streams Codex review stdout to SSE while retaining stderr for diagnostics. */
export function streamCodexReview(
  child: ChildProcess,
  response: ServerResponse,
  logPath: string,
  sessionIdHolder: { value: string | undefined },
  stderrHolder: { value: string }
): Promise<void> {
  const logStream = createWriteStream(logPath, {
    flags: "a",
    encoding: "utf-8",
  });
  let eventCount = 0;
  const keepaliveInterval = setInterval(() => {
    if (!response.destroyed && response.writable) {
      writeEvent(response, { type: "keepalive" });
    }
  }, 25_000);
  keepaliveInterval.unref();
  const stopKeepalive = () => clearInterval(keepaliveInterval);

  response.once?.("close", stopKeepalive);

  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    logStream.write(text);

    const sessionMatch = CODEX_SESSION_ID_REGEX.exec(text);
    if (sessionMatch?.[1] && !sessionIdHolder.value) {
      sessionIdHolder.value = sessionMatch[1];
      writeEvent(response, { type: "status", sessionId: sessionMatch[1] });
    }

    eventCount++;
    const ok = writeEvent(response, { type: "text", content: text });
    if (eventCount <= 3 || eventCount % 50 === 0) {
      gatewayLog.debug(
        "codex-stream",
        `event #${eventCount}: write=${ok}, destroyed=${response.destroyed}, writable=${response.writable}, content=${text.length} chars`
      );
    }
  });

  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    logStream.write(text);
    stderrHolder.value += text;
  });

  child.on("close", () => {
    stopKeepalive();
    gatewayLog.debug(
      "codex-stream",
      `child closed, total events: ${eventCount}, response destroyed: ${response.destroyed}`
    );
    logStream.end();
  });

  return new Promise<void>((resolve, reject) => {
    logStream.once("finish", resolve);
    logStream.once("error", reject);
  });
}

async function streamCodexConversation(
  response: ServerResponse,
  cwd: string,
  args: string[],
  onSessionId: (sessionId: string) => Promise<void>
): Promise<void> {
  try {
    const codexBin = (
      await resolveBinaryFromLoginShell(
        "codex",
        getOverrideBinaryPaths()?.codex
      )
    ).path;
    const child = spawn(codexBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: await getShellEnv({ FORCE_COLOR: "0" }),
    });

    if (!child.pid) {
      throw new Error("failed to spawn codex process");
    }

    writeEvent(response, {
      type: "status",
      status: "running",
      pid: child.pid,
    });

    let capturedSessionId: string | null = null;

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const lines = text.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const extractedText = extractCodexText(trimmed);
        if (extractedText) {
          writeEvent(response, { type: "text", content: extractedText });
        }

        const sessionId = extractCodexSessionId(trimmed);
        if (sessionId && sessionId !== capturedSessionId) {
          capturedSessionId = sessionId;
          void onSessionId(sessionId);
          writeEvent(response, { type: "status", sessionId });
        }
      }
    });

    let stderrBuffer = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderrBuffer +=
        typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });

    const exitCode = await waitForExit(child);

    if (exitCode !== 0 && stderrBuffer.trim()) {
      writeEvent(response, { type: "error", error: stderrBuffer.trim() });
    }

    writeEvent(response, {
      type: "result",
      success: exitCode === 0,
    });
    writeEvent(response, { type: "done" });
    response.end();
  } catch (error) {
    writeEvent(response, {
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    writeEvent(response, { type: "done" });
    response.end();
  }
}

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
    return line;
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

function buildFindingPrompt(
  findingContext: FindingChatHistory["findingContext"],
  userMessage: string,
  messages: FindingChatMessage[]
): string {
  const parts: string[] = [
    "You are helping a developer reason about a code review finding.",
    "Assess whether the finding is valid and propose next steps.",
  ];

  if (findingContext) {
    const lineSuffix = findingContext.line ? `:${findingContext.line}` : "";
    parts.push(
      "Finding context:",
      `Severity: ${findingContext.severity}`,
      ...(findingContext.file
        ? [`File: ${findingContext.file}${lineSuffix}`]
        : []),
      `Message: ${findingContext.message}`,
      ...(findingContext.suggestion
        ? [`Suggestion: ${findingContext.suggestion}`]
        : [])
    );
  }

  if (messages.length > 0) {
    parts.push(
      "Recent conversation:",
      ...messages.slice(-8).map((message) => {
        const role = message.role === "user" ? "User" : "Assistant";
        return `${role}: ${message.content}`;
      })
    );
  }

  parts.push("Latest message:", userMessage);

  return parts.join("\n\n");
}

/** Returns the canonical path for finding chat history. */
function getFindingHistoryPath(
  ticketId: string,
  expandedRepoPath: string,
  findingId: string
): string {
  const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
  const sanitizedFindingId = findingId.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const filename = path.join("finding-chats", `${sanitizedFindingId}.json`);
  return path.join(worktreeDir, ".closedloop-ai", "work", filename);
}

async function waitForExit(child: ChildProcess): Promise<number> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const env = await getShellEnv();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let output = "";
    let errorOutput = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
        return;
      }
      reject(new Error(errorOutput || `${command} exited with code ${code}`));
    });
  });
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
): boolean {
  return response.write(`${JSON.stringify(payload)}\n`);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}
// --- Verdict extraction ---

const VERDICT_PROMPT = `Now perform a Premise Review of the changes you just reviewed. Question whether the changes were necessary at all:

- Non-existent bug "fix": The author claims to fix a bug, but the original code was correct
- Redundant workaround: The problem is already handled by the framework or upstream code
- Phantom dead-code removal: Code removed as "unused" but still referenced elsewhere
- Duplicate abstraction: A new helper was added but an equivalent already exists
- Unnecessary optimization: Caching/batching for a path that is not a bottleneck

Use Read, Grep, and Glob to investigate the existing codebase for evidence.

After your analysis, output exactly one line as the LAST line of your response:
<pr_verdict>{"verdict":"X","reason":"..."}</pr_verdict>

Where verdict is:
- "decline" if you found blocking premise issues (changes are unnecessary or harmful) OR your review found critical/blocking issues
- "needs_attention" if there are high-priority issues but no blocking ones
- "approve" if no blocking or high-priority issues were found

Keep reason under 120 characters. The reason should reference the most important issue.`;

const VERDICT_TAG_RE = /<pr_verdict>([\s\S]*?)<\/pr_verdict>/;
const VALID_VERDICTS = new Set(["decline", "needs_attention", "approve"]);

type ReviewVerdict = {
  verdict: "decline" | "needs_attention" | "approve";
  reason: string;
};

/** @internal Exported for testing only. */
export function extractVerdictTag(
  rawOutput: string
): ReviewVerdict | undefined {
  const match = VERDICT_TAG_RE.exec(rawOutput);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      typeof parsed.verdict !== "string" ||
      !VALID_VERDICTS.has(parsed.verdict) ||
      typeof parsed.reason !== "string" ||
      parsed.reason.length === 0
    ) {
      return undefined;
    }
    return {
      verdict: parsed.verdict as ReviewVerdict["verdict"],
      reason: parsed.reason,
    };
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractClaudeText(event: any): string | null {
  // assistant message with content blocks — append newline to separate turns
  if (event.type === "assistant" && event.message?.content) {
    const texts: string[] = [];
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) {
      return null;
    }
    const joined = texts.join("");
    return joined.endsWith("\n") ? joined : `${joined}\n`;
  }

  // Streaming text deltas
  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta" &&
    event.delta.text
  ) {
    return event.delta.text;
  }

  // Result event with text in content (can be a plain string or array of content blocks)
  if (event.type === "result" && event.result) {
    if (typeof event.result === "string") {
      return event.result.endsWith("\n") ? event.result : `${event.result}\n`;
    }
    const texts: string[] = [];
    for (const block of event.result ?? []) {
      if (block.type === "text" && block.text) {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) {
      return null;
    }
    const joined = texts.join("");
    return joined.endsWith("\n") ? joined : `${joined}\n`;
  }

  return null;
}

const VERDICT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function runVerdictProcess(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    stdin?: string;
    env?: Record<string, string | undefined>;
  },
  extractLine: (trimmedLine: string) => string | null
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    if (options.stdin) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }

    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `${cmd} verdict timed out after ${VERDICT_TIMEOUT_MS / 1000}s`
        )
      );
    }, VERDICT_TIMEOUT_MS);

    let buffer = "";
    let collected = "";

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const text = extractLine(trimmed);
        if (text) {
          collected += text;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      gatewayLog.debug(
        "review-verdict",
        `${cmd} stderr: ${data.toString().trim().slice(0, 300)}`
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const text = extractLine(buffer.trim());
        if (text) {
          collected += text;
        }
      }
      gatewayLog.debug("review-verdict", `${cmd} exited with code ${code}`);
      if (code === 0) {
        resolve(collected);
      } else {
        reject(new Error(`${cmd} process exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function extractCodexVerdictLine(trimmedLine: string): string | null {
  try {
    const event = JSON.parse(trimmedLine) as Record<string, unknown>;
    const item = event.item as { type?: string; text?: string } | undefined;
    if (
      event.type === "item.completed" &&
      item?.text &&
      item.type === "agent_message"
    ) {
      return item.text;
    }
    return null;
  } catch {
    // Not JSON — accumulate raw text as fallback
    return trimmedLine;
  }
}

function extractClaudeVerdictLine(trimmedLine: string): string | null {
  try {
    const event = JSON.parse(trimmedLine);
    return extractClaudeText(event);
  } catch {
    return null;
  }
}

async function runCodexVerdict(
  worktreeDir: string,
  sessionId: string
): Promise<string> {
  const codexBin = (
    await resolveBinaryFromLoginShell("codex", getOverrideBinaryPaths()?.codex)
  ).path;
  return runVerdictProcess(
    codexBin,
    ["exec", "resume", sessionId, VERDICT_PROMPT, "--full-auto", "--json"],
    { cwd: worktreeDir, env: await getShellEnv({ FORCE_COLOR: "0" }) },
    extractCodexVerdictLine
  );
}

async function runClaudeVerdict(
  worktreeDir: string,
  sessionId: string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider,
  expectedMcpUrl?: string
): Promise<string> {
  const allowedTools = await withMcpTools("Read,Glob,Grep", expectedMcpUrl);
  const claudeBin = (
    await resolveBinaryFromLoginShell(
      "claude",
      getOverrideBinaryPaths()?.claude
    )
  ).path;
  return runVerdictProcess(
    claudeBin,
    [
      "-p",
      "--verbose",
      "--resume",
      sessionId,
      "--output-format",
      "stream-json",
      "--model",
      "sonnet",
      "--allowedTools",
      allowedTools,
    ],
    {
      cwd: worktreeDir,
      stdin: VERDICT_PROMPT,
      env: await getClaudeShellEnv(),
    },
    extractClaudeVerdictLine
  );
}
