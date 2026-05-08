import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CLAUDE_OUTPUT_FILE = "claude-output.jsonl";
const CLAUDE_OUTPUT_SIDECAR_FILE = "claude-output.name.txt";
const CLAUDE_OUTPUT_RENAMED_PREFIX = "claude-output-";
const CLAUDE_OUTPUT_RENAMED_SUFFIX = ".jsonl";

/**
 * Pattern that matches known auth/rate-limit/billing error messages from Claude CLI.
 *
 * Kept narrow because it is applied to arbitrary text — raw stderr (`logTail`)
 * and `entry.result` strings — where loose terms like `forbidden` or
 * `access denied` would produce false positives (filesystem permission errors,
 * git errors, etc.). For synthetic `isApiErrorMessage` entries, see
 * `AUTH_STATUS_PATTERN`.
 */
export const AUTH_CHALLENGE_PATTERN =
  /authentication_error|authentication required|invalid bearer token|invalid token|rate_limit_error|rate limit reached|usage limit|billing_error|permission_error|overloaded_error|api overloaded|\bunauthorized\b|token.*expired/i;

/**
 * Broader auth pattern that adds generic HTTP-status phrasing
 * (`forbidden`, `access denied`). Only safe to apply to synthetic
 * `isApiErrorMessage` entries from the Claude CLI, which are guaranteed
 * to describe an API error rather than arbitrary log content.
 */
export const AUTH_STATUS_PATTERN =
  /authentication_error|authentication required|invalid bearer token|invalid token|\brate_limit(_error)?\b|rate limit reached|usage limit|billing_error|permission_error|overloaded_error|api overloaded|\bunauthorized\b|\bforbidden\b|access denied|token.*expired/i;

/**
 * Validate and resolve a sidecar-selected renamed output path.
 *
 * @param {string} claudeWorkDir
 * @param {string} sidecarValue
 * @returns {string | null}
 */
function resolveSidecarOutputPath(claudeWorkDir, sidecarValue) {
  if (path.basename(sidecarValue) !== sidecarValue) {
    return null;
  }
  if (
    !(
      sidecarValue.startsWith(CLAUDE_OUTPUT_RENAMED_PREFIX) &&
      sidecarValue.endsWith(CLAUDE_OUTPUT_RENAMED_SUFFIX)
    )
  ) {
    return null;
  }
  const candidate = path.join(claudeWorkDir, sidecarValue);
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the newest renamed output file in `claudeWorkDir` matching the
 * `claude-output-*.jsonl` naming convention. Returns null when none exist.
 *
 * @param {string} claudeWorkDir
 * @returns {string | null}
 */
function resolveNewestRenamedOutputPath(claudeWorkDir) {
  let newest = null;
  let entries;
  try {
    entries = readdirSync(claudeWorkDir);
  } catch {
    return null;
  }

  for (const name of entries) {
    if (
      !(
        name.startsWith(CLAUDE_OUTPUT_RENAMED_PREFIX) &&
        name.endsWith(CLAUDE_OUTPUT_RENAMED_SUFFIX)
      )
    ) {
      continue;
    }
    const candidate = path.join(claudeWorkDir, name);
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) {
        continue;
      }
      if (
        newest === null ||
        stats.mtimeMs > newest.mtimeMs ||
        (stats.mtimeMs === newest.mtimeMs && name > newest.name)
      ) {
        newest = { path: candidate, mtimeMs: stats.mtimeMs, name };
      }
    } catch {
      // Ignore entries that disappear or cannot be statted.
    }
  }
  return newest?.path ?? null;
}

/**
 * Resolve the Claude JSONL output path for a run.
 *
 * Resolution order:
 * 1. Sidecar-selected renamed output (`claude-output.name.txt`).
 * 2. Newest renamed output (`claude-output-*.jsonl`) when the sidecar is
 *    absent, unreadable, or stale.
 * 3. Legacy fixed-path `claude-output.jsonl`.
 *
 * An empty sidecar is a start-of-run sentinel — it intentionally skips the
 * renamed-file scan and only falls through to the legacy fixed path.
 *
 * @param {string} claudeWorkDir
 * @returns {string | null}
 */
export function resolveClaudeOutputPath(claudeWorkDir) {
  const legacyPath = path.join(claudeWorkDir, CLAUDE_OUTPUT_FILE);
  const sidecarPath = path.join(claudeWorkDir, CLAUDE_OUTPUT_SIDECAR_FILE);

  if (existsSync(sidecarPath)) {
    try {
      const sidecarValue = readFileSync(sidecarPath, "utf-8").trim();
      if (sidecarValue.length === 0) {
        return existsSync(legacyPath) ? legacyPath : null;
      }
      const resolvedSidecarPath = resolveSidecarOutputPath(
        claudeWorkDir,
        sidecarValue
      );
      if (resolvedSidecarPath !== null) {
        return resolvedSidecarPath;
      }
    } catch {
      // Fall through to renamed-file scan when the sidecar cannot be read.
    }
  }

  const newestRenamedPath = resolveNewestRenamedOutputPath(claudeWorkDir);
  if (newestRenamedPath !== null) {
    return newestRenamedPath;
  }

  return existsSync(legacyPath) ? legacyPath : null;
}

/**
 * Scan JSONL content for a result record with `is_error: true` whose message
 * matches a known auth/rate-limit/billing pattern. Also detects synthetic
 * `isApiErrorMessage` entries from the Claude CLI that carry HTTP status codes
 * (401, 403, 429).
 *
 * Returns the error text or null if no auth challenge was detected.
 *
 * @param {string} content - Raw JSONL file content.
 * @returns {string | null}
 */
function scanJsonlForAuthChallenge(content) {
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (
        entry.type === "result" &&
        entry.is_error === true &&
        typeof entry.result === "string" &&
        AUTH_CHALLENGE_PATTERN.test(entry.result)
      ) {
        return entry.result;
      }
      // Synthetic API-error entries emitted by Claude CLI mid-conversation
      // carry `isApiErrorMessage: true` and the error string in `error`.
      if (entry.isApiErrorMessage === true) {
        const errorText =
          typeof entry.error === "string" ? entry.error : "unknown error";
        if (AUTH_STATUS_PATTERN.test(errorText)) {
          const status =
            typeof entry.apiErrorStatus === "number"
              ? ` (status ${entry.apiErrorStatus})`
              : "";
          return `Claude API ${errorText} error${status}`;
        }
        // HTTP 401/403/429 is an auth/quota challenge regardless of error text.
        // 429 is the canonical rate-limit / over-quota status; treating it as
        // a challenge here ensures we catch entries like
        // {error: "rate_limit", apiErrorStatus: 429} even if Anthropic drops
        // or renames the textual error token in a future CLI version.
        if (
          entry.apiErrorStatus === 401 ||
          entry.apiErrorStatus === 403 ||
          entry.apiErrorStatus === 429
        ) {
          return `API returned HTTP ${entry.apiErrorStatus}: ${errorText}`;
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

/**
 * Scan the current Claude JSONL output for auth/rate-limit/billing errors.
 *
 * Resolves the output file path via sidecar/renamed/legacy fallback, then
 * delegates to `scanJsonlForAuthChallenge`.
 *
 * @param {string} claudeWorkDir
 * @returns {string | null}
 */
export function detectAuthChallengeFromJsonl(claudeWorkDir) {
  const outputFile = resolveClaudeOutputPath(claudeWorkDir);
  if (outputFile === null) {
    return null;
  }
  try {
    return scanJsonlForAuthChallenge(readFileSync(outputFile, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Scan a specific JSONL file path for auth/rate-limit/billing error entries.
 *
 * Unlike `detectAuthChallengeFromJsonl`, this function does not perform path
 * resolution — it reads the given file directly. This is used when the caller
 * already knows the exact transcript path (e.g. the Claude native session
 * transcript at `~/.claude/projects/<cwdHash>/<sessionId>.jsonl`).
 *
 * @param {string} filePath
 * @returns {string | null}
 */
export function detectAuthChallengeFromJsonlFile(filePath) {
  if (!(filePath && existsSync(filePath))) {
    return null;
  }
  try {
    return scanJsonlForAuthChallenge(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Check whether a log tail string contains Claude CLI auth/rate-limit/billing
 * error patterns.
 *
 * @param {string} logTail
 * @returns {boolean}
 */
export function isAuthChallengeError(logTail) {
  return AUTH_CHALLENGE_PATTERN.test(logTail);
}
