import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gatewayLog } from "../../main/gateway-logger.js";
import {
  getShellPath,
  resolveExecutablesOnPath,
  sanitizeSpawnEnv,
} from "../shell-path.js";

const execFileAsync = promisify(execFile);

export type McpProvider = "claude" | "codex";

export type McpDetectionResult = {
  available: boolean;
  serverName: string | null;
  matchedUrl: string | null;
  checkedAt: string;
  error?: string | null;
  // Legacy compatibility field for older app consumers.
  closedloopAvailable: boolean;
};

type ParsedMcpServer = {
  name: string;
  url: string;
  available: boolean;
};

const RESULT_CACHE_TTL_MS = 60_000;
const RESOLVED_NAME_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLVED_BINARY_TTL_MS = 60 * 60 * 1000;
const CLAUDE_DISCOVERY_TIMEOUT_MS = 30_000;
const CLAUDE_STATUS_TIMEOUT_MS = 5000;
const CODEX_DETECTION_TIMEOUT_MS = 10_000;
const HTTP_URL_REGEX = /https?:\/\/[^\s)]+/g;
const TRAILING_SLASH_REGEX = /\/+$/;
const NAME_SUFFIX_REGEX = /:\s*$/;
const WHITESPACE_REGEX = /\s+/;
const CODEX_ENABLED_REGEX = /\benabled\b/i;
const TIMEOUT_REGEX = /timed out|ETIMEDOUT/i;

const cache = new Map<
  string,
  { result: McpDetectionResult; expiresAt: number }
>();
const resolvedNameCache = new Map<
  string,
  { serverName: string; expiresAt: number }
>();
const resolvedBinaryCache = new Map<
  McpProvider,
  { binary: string; expiresAt: number }
>();
const latestByProvider = new Map<
  McpProvider,
  { result: McpDetectionResult; expiresAt: number }
>();
let neutralMcpCwdResolver: (() => string | undefined) | null = null;

export function resetMcpDetectionCache(): void {
  cache.clear();
  latestByProvider.clear();
  resolvedNameCache.clear();
  resolvedBinaryCache.clear();
}

export function configureMcpDetectionCwdResolver(
  resolver: (() => string | undefined) | null
): void {
  neutralMcpCwdResolver = resolver;
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

function cacheKey(provider: McpProvider, expectedMcpUrl: string): string {
  return `${provider}::${expectedMcpUrl}`;
}

function createDetectionResult(
  checkedAt: string,
  options: {
    available?: boolean;
    serverName?: string | null;
    matchedUrl?: string | null;
    error?: string | null;
  } = {}
): McpDetectionResult {
  const available = options.available ?? false;
  return {
    available,
    serverName: options.serverName ?? null,
    matchedUrl: options.matchedUrl ?? null,
    checkedAt,
    error: options.error ?? null,
    closedloopAvailable: available,
  };
}

function toDetectionResult(
  match: ParsedMcpServer | null,
  checkedAt: string,
  error?: string | null
): McpDetectionResult {
  return createDetectionResult(checkedAt, {
    available: match?.available ?? false,
    serverName: match?.name ?? null,
    matchedUrl: match?.url ?? null,
    error,
  });
}

function getFreshCacheEntry(
  provider: McpProvider,
  expectedMcpUrl: string
): McpDetectionResult | null {
  const cached = cache.get(cacheKey(provider, expectedMcpUrl));
  if (!cached) {
    return null;
  }
  if (Date.now() >= cached.expiresAt) {
    cache.delete(cacheKey(provider, expectedMcpUrl));
    return null;
  }
  return cached.result;
}

function getFreshLatest(provider: McpProvider): McpDetectionResult | null {
  const cached = latestByProvider.get(provider);
  if (!cached) {
    return null;
  }
  if (Date.now() >= cached.expiresAt) {
    latestByProvider.delete(provider);
    return null;
  }
  return cached.result;
}

function setCachedDetection(
  provider: McpProvider,
  expectedMcpUrl: string,
  result: McpDetectionResult
): void {
  const expiresAt = Date.now() + RESULT_CACHE_TTL_MS;
  cache.set(cacheKey(provider, expectedMcpUrl), { result, expiresAt });
  latestByProvider.set(provider, { result, expiresAt });
  if (
    result.serverName &&
    result.error !== "Project-local config unsupported"
  ) {
    resolvedNameCache.set(cacheKey(provider, expectedMcpUrl), {
      serverName: result.serverName,
      expiresAt: Date.now() + RESOLVED_NAME_TTL_MS,
    });
    return;
  }
  if (!result.error) {
    resolvedNameCache.delete(cacheKey(provider, expectedMcpUrl));
  }
}

function getFreshResolvedName(
  provider: McpProvider,
  expectedMcpUrl: string
): string | null {
  const cached = resolvedNameCache.get(cacheKey(provider, expectedMcpUrl));
  if (!cached) {
    return null;
  }
  if (Date.now() >= cached.expiresAt) {
    resolvedNameCache.delete(cacheKey(provider, expectedMcpUrl));
    return null;
  }
  return cached.serverName;
}

function clearResolvedName(
  provider: McpProvider,
  expectedMcpUrl: string
): void {
  resolvedNameCache.delete(cacheKey(provider, expectedMcpUrl));
}

function getFreshResolvedBinary(provider: McpProvider): string | null {
  const cached = resolvedBinaryCache.get(provider);
  if (!cached) {
    return null;
  }
  if (Date.now() >= cached.expiresAt) {
    resolvedBinaryCache.delete(provider);
    return null;
  }
  return cached.binary;
}

function setResolvedBinary(provider: McpProvider, binary: string): void {
  resolvedBinaryCache.set(provider, {
    binary,
    expiresAt: Date.now() + RESOLVED_BINARY_TTL_MS,
  });
}

function getNeutralMcpCwd(): string | undefined {
  return neutralMcpCwdResolver?.();
}

async function resolveExecutableOnPath(
  binary: string,
  searchPath: string
): Promise<string | null> {
  const hits = await resolveExecutablesOnPath(binary, searchPath);
  return hits[0] ?? null;
}

async function resolveProviderBinary(provider: McpProvider): Promise<string> {
  const cached = getFreshResolvedBinary(provider);
  if (cached) {
    return cached;
  }

  const shellPath = await getShellPath();
  const resolved = await resolveExecutableOnPath(provider, shellPath);
  if (resolved) {
    setResolvedBinary(provider, resolved);
    return resolved;
  }

  return provider;
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

export function parseClaudeMcpList(
  stdout: string,
  expectedMcpUrl: string
): ParsedMcpServer | null {
  const normalizedExpectedUrl = normalizeMcpServerUrl(expectedMcpUrl);
  if (!normalizedExpectedUrl) {
    return null;
  }

  const lines = stdout.split("\n");
  for (const rawLine of lines) {
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

    const urlIndex = beforeStatus.indexOf(url);
    const name = beforeStatus
      .slice(0, urlIndex)
      .replace(NAME_SUFFIX_REGEX, "")
      .trim();
    if (!name) {
      continue;
    }

    return {
      name,
      url,
      available: status.includes("Connected") || status.includes("✓"),
    };
  }

  return null;
}

export function parseClaudeMcpGet(
  stdout: string,
  expectedMcpUrl: string
): ParsedMcpServer | null {
  const normalizedExpectedUrl = normalizeMcpServerUrl(expectedMcpUrl);
  if (!normalizedExpectedUrl) {
    return null;
  }

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
    url,
    available: Boolean(status?.includes("Connected") || status?.includes("✓")),
  };
}

function parseClaudeMcpScope(stdout: string): "user" | "local" | "unknown" {
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("Scope:")) {
      continue;
    }
    const scope = line.slice("Scope:".length).trim().toLowerCase();
    if (scope.includes("user config")) {
      return "user";
    }
    if (scope.includes("local config")) {
      return "local";
    }
  }
  return "unknown";
}

export function parseCodexMcpList(
  stdout: string,
  expectedMcpUrl: string
): ParsedMcpServer | null {
  const normalizedExpectedUrl = normalizeMcpServerUrl(expectedMcpUrl);
  if (!normalizedExpectedUrl) {
    return null;
  }

  const lines = stdout.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("Name ")) {
      continue;
    }

    const url = findMatchingUrl(line, normalizedExpectedUrl);
    if (!url) {
      continue;
    }

    const namePrefix = line.slice(0, line.indexOf(url)).trim();
    const name = namePrefix.split(WHITESPACE_REGEX)[0];
    if (!name) {
      continue;
    }

    return {
      name,
      url,
      available: CODEX_ENABLED_REGEX.test(line),
    };
  }

  return null;
}

export async function detectMcpAvailability(
  provider: McpProvider,
  expectedMcpUrl?: string
): Promise<McpDetectionResult> {
  if (!expectedMcpUrl) {
    return (
      getFreshLatest(provider) ??
      createDetectionResult(new Date().toISOString())
    );
  }

  const normalizedExpectedUrl = normalizeMcpServerUrl(expectedMcpUrl);
  if (!normalizedExpectedUrl) {
    return createDetectionResult(new Date().toISOString());
  }

  const cached = getFreshCacheEntry(provider, normalizedExpectedUrl);
  if (cached) {
    return cached;
  }

  const result =
    provider === "claude"
      ? await runClaudeDetection(normalizedExpectedUrl)
      : await runListDetection(provider, normalizedExpectedUrl);
  setCachedDetection(provider, normalizedExpectedUrl, result);
  return result;
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

async function runListDetection(
  provider: McpProvider,
  expectedMcpUrl: string
): Promise<McpDetectionResult> {
  const checkedAt = new Date().toISOString();
  try {
    const shellPath = await getShellPath();
    const providerBinary = await resolveProviderBinary(provider);
    const { stdout, stderr } = await execFileAsync(
      providerBinary,
      ["mcp", "list"],
      {
        cwd: getNeutralMcpCwd(),
        timeout:
          provider === "claude"
            ? CLAUDE_DISCOVERY_TIMEOUT_MS
            : CODEX_DETECTION_TIMEOUT_MS,
        env: { ...sanitizeSpawnEnv(process.env), PATH: shellPath },
      }
    );
    const combinedOutput = `${stdout}\n${stderr}`.trim();
    const match =
      provider === "claude"
        ? parseClaudeMcpList(combinedOutput, expectedMcpUrl)
        : parseCodexMcpList(combinedOutput, expectedMcpUrl);
    return toDetectionResult(match, checkedAt);
  } catch (error) {
    const output = getCommandOutput(error);
    const match =
      provider === "claude"
        ? parseClaudeMcpList(output, expectedMcpUrl)
        : parseCodexMcpList(output, expectedMcpUrl);
    if (match) {
      return toDetectionResult(match, checkedAt);
    }
    const detectionError = isTimeoutError(error)
      ? "Discovery timed out"
      : "Discovery failed";
    const message = error instanceof Error ? error.message : String(error);
    gatewayLog.warn("mcp-detection", `${provider} mcp list failed: ${message}`);
    return createDetectionResult(checkedAt, { error: detectionError });
  }
}

async function runClaudeDetection(
  expectedMcpUrl: string
): Promise<McpDetectionResult> {
  const cachedName = getFreshResolvedName("claude", expectedMcpUrl);
  if (cachedName) {
    const byName = await runClaudeGetDetection(cachedName, expectedMcpUrl);
    if (byName) {
      return byName;
    }
  }

  const listed = await runListDetection("claude", expectedMcpUrl);
  if (listed.serverName && !listed.error) {
    const byName = await runClaudeGetDetection(
      listed.serverName,
      expectedMcpUrl
    );
    if (byName) {
      return byName;
    }
  }
  return listed;
}

async function runClaudeGetDetection(
  serverName: string,
  expectedMcpUrl: string
): Promise<McpDetectionResult | null> {
  const checkedAt = new Date().toISOString();
  try {
    const shellPath = await getShellPath();
    const claudeBinary = await resolveProviderBinary("claude");
    const { stdout, stderr } = await execFileAsync(
      claudeBinary,
      ["mcp", "get", serverName],
      {
        cwd: getNeutralMcpCwd(),
        timeout: CLAUDE_STATUS_TIMEOUT_MS,
        env: { ...sanitizeSpawnEnv(process.env), PATH: shellPath },
      }
    );
    const combinedOutput = `${stdout}\n${stderr}`.trim();
    const match = parseClaudeMcpGet(combinedOutput, expectedMcpUrl);
    if (!match) {
      clearResolvedName("claude", expectedMcpUrl);
      return null;
    }
    if (parseClaudeMcpScope(combinedOutput) === "local") {
      clearResolvedName("claude", expectedMcpUrl);
      return createDetectionResult(checkedAt, {
        serverName,
        matchedUrl: match.url,
        error: "Project-local config unsupported",
      });
    }
    return toDetectionResult(match, checkedAt);
  } catch (error) {
    const output = getCommandOutput(error);
    const match = parseClaudeMcpGet(output, expectedMcpUrl);
    if (match) {
      return toDetectionResult(match, checkedAt);
    }
    if (isTimeoutError(error)) {
      return createDetectionResult(checkedAt, {
        serverName,
        matchedUrl: expectedMcpUrl,
        error: "Status check timed out",
      });
    }
    clearResolvedName("claude", expectedMcpUrl);
    return null;
  }
}
