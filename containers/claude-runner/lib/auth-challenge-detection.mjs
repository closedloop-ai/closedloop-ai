import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const CLAUDE_OUTPUT_FILE = "claude-output.jsonl";

// Narrow pattern applied to arbitrary text (stderr tails, result strings).
// Loose terms like `forbidden`/`access denied` are intentionally excluded here
// to avoid false positives on filesystem/git errors.
const AUTH_CHALLENGE_PATTERN =
  /authentication_error|authentication required|invalid bearer token|invalid token|rate_limit_error|rate limit reached|usage limit|billing_error|permission_error|overloaded_error|api overloaded|\bunauthorized\b|token.*expired/i;

// Broader pattern only applied to synthetic `isApiErrorMessage` entries from
// the Claude CLI, which are guaranteed to describe an API error.
const AUTH_STATUS_PATTERN =
  /authentication_error|authentication required|invalid bearer token|invalid token|\brate_limit(_error)?\b|rate limit reached|usage limit|billing_error|permission_error|overloaded_error|api overloaded|\bunauthorized\b|\bforbidden\b|access denied|token.*expired/i;

/**
 * Scan JSONL content for auth/rate-limit/billing error signals.
 * Returns the matched error text or null.
 *
 * @param {string} content
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
        // HTTP 401/403/429 is an auth/quota challenge regardless of text —
        // catches entries like {error: "rate_limit", apiErrorStatus: 429}
        // even if Anthropic renames the textual token.
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
 * Scan the run's `claude-output.jsonl` for auth/rate-limit/billing errors.
 *
 * @param {string} claudeWorkDir
 * @returns {string | null}
 */
export function detectAuthChallengeFromJsonl(claudeWorkDir) {
  const outputFile = path.join(claudeWorkDir, CLAUDE_OUTPUT_FILE);
  if (!existsSync(outputFile)) {
    return null;
  }
  try {
    return scanJsonlForAuthChallenge(readFileSync(outputFile, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Scan a specific JSONL transcript path. Used when the caller already knows
 * the exact path (e.g. `~/.claude/projects/<cwdHash>/<sessionId>.jsonl`).
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
