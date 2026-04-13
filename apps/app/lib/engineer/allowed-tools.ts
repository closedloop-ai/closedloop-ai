import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "@/env";
import { getShellPath } from "@/lib/engineer/shell-path";

const execFileAsync = promisify(execFile);

type McpProvider = "claude" | "codex";

type CachedMcpServer = {
  serverName: string | null;
  expiresAt: number;
};

const ENGINEER_CHAT_BASE_TOOLS = [
  "Bash",
  "Grep",
  "Glob",
  "Read",
  "Edit",
  "Write",
  "Task",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
];

const READONLY_CODEBASE_BASE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
];

const WEB_ONLY_BASE_TOOLS = ["WebSearch", "WebFetch"];

const STATUS_CACHE_TTL_MS = 60_000;
const RESOLVED_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const CLAUDE_DISCOVERY_TIMEOUT_MS = 30_000;
const CLAUDE_STATUS_TIMEOUT_MS = 5000;
const CODEX_DETECTION_TIMEOUT_MS = 10_000;
const HTTP_URL_REGEX = /https?:\/\/[^\s)]+/g;
const TRAILING_SLASH_REGEX = /\/+$/;
const NAME_SUFFIX_REGEX = /:\s*$/;
const WHITESPACE_REGEX = /\s+/;
const CODEX_ENABLED_REGEX = /\benabled\b/i;
const TIMEOUT_REGEX = /timed out|ETIMEDOUT/i;

const cache = new Map<string, CachedMcpServer>();
const resolvedNameCache = new Map<string, CachedMcpServer>();

export const ENGINEER_CHAT_TOOLS = ENGINEER_CHAT_BASE_TOOLS.join(",");
export const READONLY_CODEBASE_TOOLS = READONLY_CODEBASE_BASE_TOOLS.join(",");
export const WEB_ONLY_TOOLS = WEB_ONLY_BASE_TOOLS.join(",");

export function buildMcpToolPattern(serverName: string): string {
  return `mcp__${serverName}__*`;
}

export function withResolvedMcpTools(
  tools: string,
  serverName: string | null | undefined
): string {
  const baseTools = tools
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (!serverName) {
    return baseTools.join(",");
  }
  return [...baseTools, buildMcpToolPattern(serverName)].join(",");
}

export function normalizeMcpServerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const normalizedPath = parsed.pathname.replace(TRAILING_SLASH_REGEX, "");
    parsed.pathname = normalizedPath === "" ? "/" : normalizedPath;
    return parsed.toString();
  } catch {
    return null;
  }
}

function findMatchingUrl(
  line: string,
  normalizedExpectedUrl: string
): string | null {
  const matches = line.match(HTTP_URL_REGEX) ?? [];
  for (const match of matches) {
    if (normalizeMcpServerUrl(match) === normalizedExpectedUrl) {
      return match;
    }
  }
  return null;
}

function parseClaudeMcpList(
  stdout: string,
  normalizedExpectedUrl: string
): string | null {
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const statusSeparator = line.lastIndexOf(" - ");
    if (statusSeparator === -1) {
      continue;
    }
    const beforeStatus = line.slice(0, statusSeparator).trim();
    const status = line.slice(statusSeparator + 3).trim();
    const url = findMatchingUrl(beforeStatus, normalizedExpectedUrl);
    if (!url) {
      continue;
    }
    if (!(status.includes("Connected") || status.includes("✓"))) {
      return null;
    }
    const name = beforeStatus
      .slice(0, beforeStatus.indexOf(url))
      .replace(NAME_SUFFIX_REGEX, "")
      .trim();
    return name || null;
  }
  return null;
}

function parseCodexMcpList(
  stdout: string,
  normalizedExpectedUrl: string
): string | null {
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Name ")) {
      continue;
    }
    const url = findMatchingUrl(line, normalizedExpectedUrl);
    if (!url) {
      continue;
    }
    if (!CODEX_ENABLED_REGEX.test(line)) {
      return null;
    }
    const namePrefix = line.slice(0, line.indexOf(url)).trim();
    return namePrefix.split(WHITESPACE_REGEX)[0] ?? null;
  }
  return null;
}

function parseClaudeMcpGet(
  stdout: string,
  normalizedExpectedUrl: string
): { name: string; available: boolean } | null {
  let name: string | null = null;
  let status: string | null = null;
  let url: string | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!name && line.endsWith(":")) {
      name = line.slice(0, -1).trim();
      continue;
    }
    if (line.startsWith("Status:")) {
      status = line.slice("Status:".length).trim();
      continue;
    }
    if (line.startsWith("URL:")) {
      url = line.slice("URL:".length).trim();
    }
  }

  if (!(name && url)) {
    return null;
  }
  if (normalizeMcpServerUrl(url) !== normalizedExpectedUrl) {
    return null;
  }

  return {
    name,
    available: Boolean(status?.includes("Connected") || status?.includes("✓")),
  };
}

function cacheKey(provider: McpProvider, expectedMcpUrl: string): string {
  return `${provider}::${expectedMcpUrl}`;
}

function getFreshCachedValue(
  targetCache: Map<string, CachedMcpServer>,
  provider: McpProvider,
  expectedMcpUrl: string
): string | null {
  const cached = targetCache.get(cacheKey(provider, expectedMcpUrl));
  if (!cached) {
    return null;
  }
  if (Date.now() >= cached.expiresAt) {
    targetCache.delete(cacheKey(provider, expectedMcpUrl));
    return null;
  }
  return cached.serverName;
}

function setCachedValue(
  targetCache: Map<string, CachedMcpServer>,
  provider: McpProvider,
  expectedMcpUrl: string,
  serverName: string | null,
  ttlMs: number
): void {
  targetCache.set(cacheKey(provider, expectedMcpUrl), {
    serverName,
    expiresAt: Date.now() + ttlMs,
  });
}

function clearCachedValue(
  targetCache: Map<string, CachedMcpServer>,
  provider: McpProvider,
  expectedMcpUrl: string
): void {
  targetCache.delete(cacheKey(provider, expectedMcpUrl));
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const killed = "killed" in error ? Boolean(error.killed) : false;
  const signal = "signal" in error ? String(error.signal ?? "") : "";
  return killed || signal === "SIGTERM" || TIMEOUT_REGEX.test(error.message);
}

function coerceExecOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function getCommandOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return "";
  }
  const stdout = "stdout" in error ? coerceExecOutput(error.stdout) : "";
  const stderr = "stderr" in error ? coerceExecOutput(error.stderr) : "";
  return `${stdout}\n${stderr}`.trim();
}

async function resolveMcpServerName(
  provider: McpProvider = "claude"
): Promise<string | null> {
  const expectedMcpUrl = normalizeMcpServerUrl(
    env.NEXT_PUBLIC_MCP_SERVER_URL ?? ""
  );
  if (!expectedMcpUrl) {
    return null;
  }

  const cachedServerName = getFreshCachedValue(cache, provider, expectedMcpUrl);
  if (cachedServerName !== null) {
    return cachedServerName;
  }

  if (provider === "claude") {
    const resolvedName = getFreshCachedValue(
      resolvedNameCache,
      provider,
      expectedMcpUrl
    );
    if (resolvedName) {
      const byName = await resolveClaudeServerNameByGet(
        resolvedName,
        expectedMcpUrl
      );
      if (byName !== undefined) {
        setCachedValue(
          cache,
          provider,
          expectedMcpUrl,
          byName,
          STATUS_CACHE_TTL_MS
        );
        return byName;
      }
    }
  }

  const discoveredServerName = await resolveServerNameByList(
    provider,
    expectedMcpUrl
  );
  setCachedValue(
    cache,
    provider,
    expectedMcpUrl,
    discoveredServerName,
    STATUS_CACHE_TTL_MS
  );
  if (discoveredServerName) {
    setCachedValue(
      resolvedNameCache,
      provider,
      expectedMcpUrl,
      discoveredServerName,
      RESOLVED_NAME_TTL_MS
    );
  }
  return discoveredServerName;
}

async function resolveServerNameByList(
  provider: McpProvider,
  expectedMcpUrl: string
): Promise<string | null> {
  try {
    const shellPath = await getShellPath();
    const { stdout, stderr } = await execFileAsync(provider, ["mcp", "list"], {
      timeout:
        provider === "claude"
          ? CLAUDE_DISCOVERY_TIMEOUT_MS
          : CODEX_DETECTION_TIMEOUT_MS,
      env: { ...process.env, PATH: shellPath },
    });
    const combinedOutput = `${stdout}\n${stderr}`.trim();
    return provider === "claude"
      ? parseClaudeMcpList(combinedOutput, expectedMcpUrl)
      : parseCodexMcpList(combinedOutput, expectedMcpUrl);
  } catch (error) {
    const output = getCommandOutput(error);
    const parsedServerName =
      provider === "claude"
        ? parseClaudeMcpList(output, expectedMcpUrl)
        : parseCodexMcpList(output, expectedMcpUrl);
    if (parsedServerName) {
      return parsedServerName;
    }
    return null;
  }
}

async function resolveClaudeServerNameByGet(
  serverName: string,
  expectedMcpUrl: string
): Promise<string | null | undefined> {
  try {
    const shellPath = await getShellPath();
    const { stdout, stderr } = await execFileAsync(
      "claude",
      ["mcp", "get", serverName],
      {
        timeout: CLAUDE_STATUS_TIMEOUT_MS,
        env: { ...process.env, PATH: shellPath },
      }
    );
    const parsed = parseClaudeMcpGet(
      `${stdout}\n${stderr}`.trim(),
      expectedMcpUrl
    );
    if (!parsed) {
      clearCachedValue(resolvedNameCache, "claude", expectedMcpUrl);
      return undefined;
    }
    return parsed.available ? parsed.name : null;
  } catch (error) {
    const parsed = parseClaudeMcpGet(getCommandOutput(error), expectedMcpUrl);
    if (parsed) {
      return parsed.available ? parsed.name : null;
    }
    if (isTimeoutError(error)) {
      return null;
    }
    clearCachedValue(resolvedNameCache, "claude", expectedMcpUrl);
    return undefined;
  }
}

export async function withMcpTools(
  tools: string,
  provider: McpProvider = "claude"
): Promise<string> {
  return withResolvedMcpTools(tools, await resolveMcpServerName(provider));
}
