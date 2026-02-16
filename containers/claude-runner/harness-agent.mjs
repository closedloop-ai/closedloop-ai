#!/usr/bin/env node

/**
 * Harness Agent for the Claude Code Runner container.
 *
 * Orchestrates a Symphony loop execution inside the container:
 * 1. Reads configuration from environment variables
 * 2. Downloads context pack from S3 (PRD, plan, prompt files)
 * 3. Reports "started" event to the backend
 * 4. Clones the target repository
 * 5. Writes context pack files to the work directory
 * 6. Executes run-loop.sh (or claude directly) based on the command
 * 7. Streams output and reports progress events
 * 8. Uploads state to S3 on completion (conversation history, logs)
 * 9. Reports final status (COMPLETED / FAILED / CANCELLED)
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// AWS SDK v3 — loaded from the global install
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------
function log(level, ...args) {
  const ts = new Date().toISOString();
  const prefix = `[harness][${ts}][${level.toUpperCase()}]`;
  const safeArgs = args.map((arg) =>
    typeof arg === "string" ? redactSensitive(arg) : arg
  );
  if (level === "error") {
    console.error(prefix, ...safeArgs);
  } else {
    console.log(prefix, ...safeArgs);
  }
}

// ---------------------------------------------------------------------------
// Configuration (from environment variables)
// ---------------------------------------------------------------------------
const config = {
  loopId: process.env.LOOP_ID,
  command: process.env.COMMAND, // "plan" | "execute" | "chat" | "explore" | "request_changes"
  anthropicApiKey: null, // Injected from S3 context pack (not env vars)
  githubToken: null, // Injected from S3 context pack (not env vars)
  authToken: process.env.CLOSEDLOOP_AUTH_TOKEN, // JWT for backend API calls
  apiBaseUrl: process.env.API_BASE_URL, // e.g., "https://api.closedloop.ai"
  organizationId: process.env.ORGANIZATION_ID,
  artifactId: process.env.ARTIFACT_ID,
  targetRepo: process.env.TARGET_REPO, // "owner/repo"
  targetBranch: process.env.TARGET_BRANCH || "main",
  s3ContextKey: process.env.S3_CONTEXT_KEY, // S3 key for context pack download
  s3StateKey: process.env.S3_STATE_KEY, // S3 key prefix for state upload
  s3Bucket: process.env.S3_BUCKET, // "closedloop-runtime-state-stage"
  s3Region: process.env.S3_REGION || "us-east-1",
  correlationId: process.env.CORRELATION_ID,
  maxIterations: Number.parseInt(process.env.MAX_ITERATIONS || "50", 10),
  // Parent state for resume: used to download prior run's .claude directory
  s3ParentStateKey: process.env.S3_PARENT_STATE_KEY || null,
  parentSessionId: process.env.PARENT_SESSION_ID || null,
  parentBranchName: process.env.PARENT_BRANCH_NAME || null,
};

const ERROR_CODES = {
  runner: "RUNNER_ERROR",
  config: "CONFIG_VALIDATION_FAILED",
  secrets: "SECRETS_VALIDATION_FAILED",
  contextPackDownload: "CONTEXT_PACK_DOWNLOAD_FAILED",
  contextPackInvalid: "CONTEXT_PACK_INVALID",
  contextPackWrite: "CONTEXT_PACK_WRITE_FAILED",
  gitClone: "GIT_CLONE_FAILED",
  branchCreate: "BRANCH_CREATE_FAILED",
  preRunValidation: "PRE_RUN_VALIDATION_FAILED",
  runLoopNotFound: "RUN_LOOP_NOT_FOUND",
};

class HarnessError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function redactSensitive(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  const secrets = [
    config.anthropicApiKey,
    config.githubToken,
    config.authToken,
  ].filter((secret) => typeof secret === "string" && secret.length > 0);

  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(
    /x-access-token:[^@]+@/g,
    "x-access-token:[REDACTED]@"
  );
}

function sanitizeValue(value) {
  if (typeof value === "string") {
    return redactSensitive(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateConfig() {
  // Validate required environment variables (available before context pack download).
  // Secrets (anthropicApiKey, githubToken) are delivered via S3 context pack,
  // so they are validated separately after download.
  const requiredEnv = ["loopId", "command", "authToken", "apiBaseUrl"];

  // targetRepo is only required for commands that operate on a repository.
  // chat/explore can run prompt-only without a repo.
  const repoCommands = new Set(["plan", "execute", "request_changes"]);
  if (repoCommands.has(config.command?.toLowerCase())) {
    requiredEnv.push("targetRepo");
  }

  const missing = requiredEnv.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new HarnessError(
      ERROR_CODES.config,
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

function validateSecrets() {
  // Validate secrets extracted from S3 context pack.
  const requiredSecrets = ["anthropicApiKey"];

  // Repo commands need a GitHub token for clone/push operations.
  const repoCommands = new Set(["plan", "execute", "request_changes"]);
  if (repoCommands.has(config.command?.toLowerCase())) {
    requiredSecrets.push("githubToken");
  }

  const missing = requiredSecrets.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new HarnessError(
      ERROR_CODES.secrets,
      `Missing required secrets from context pack: ${missing.join(", ")}. ` +
        "Ensure the backend included secrets in the context pack."
    );
  }
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------
let s3;

function getS3Client() {
  if (!s3) {
    s3 = new S3Client({ region: config.s3Region });
  }
  return s3;
}

async function downloadFromS3(key) {
  log("info", `Downloading s3://${config.s3Bucket}/${key}`);
  const client = getS3Client();
  const resp = await client.send(
    new GetObjectCommand({ Bucket: config.s3Bucket, Key: key })
  );
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uploadToS3(key, body, contentType = "application/octet-stream") {
  log("info", `Uploading s3://${config.s3Bucket}/${key}`);
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * List all objects under an S3 prefix (handles pagination).
 * Returns an array of { Key, Size } objects.
 */
async function listS3Objects(prefix) {
  const client = getS3Client();
  const objects = [];
  let continuationToken;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    if (resp.Contents) {
      for (const obj of resp.Contents) {
        objects.push({ Key: obj.Key, Size: obj.Size ?? 0 });
      }
    }
    continuationToken = resp.IsTruncated
      ? resp.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
}

/**
 * Download an entire S3 "directory" (prefix) to a local directory.
 * Preserves relative paths. Skips files >50MB (mirrors upload limit).
 */
async function downloadDirectoryFromS3(s3Prefix, localDir) {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const normalizedPrefix = s3Prefix.endsWith("/") ? s3Prefix : `${s3Prefix}/`;
  const objects = await listS3Objects(normalizedPrefix);

  let downloaded = 0;
  for (const obj of objects) {
    if (obj.Size > MAX_FILE_SIZE) {
      log("info", `Skipping large file (${obj.Size} bytes): ${obj.Key}`);
      continue;
    }

    const relativePath = obj.Key.slice(normalizedPrefix.length);
    if (!relativePath) {
      continue; // skip the prefix itself
    }

    const localPath = path.join(localDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const data = await downloadFromS3(obj.Key);
    fs.writeFileSync(localPath, data);
    downloaded++;
  }

  log("info", `Downloaded ${downloaded} files from s3://${config.s3Bucket}/${normalizedPrefix}`);
  return downloaded;
}

/**
 * Download and restore prior run state from the parent loop.
 * Restores:
 *   - {parentPrefix}/claude-state/ → {workDir}/.claude/  (run state, conversation history)
 *   - {parentPrefix}/home-claude-state/ → ~/.claude/      (session state for --resume)
 *
 * This is the counterpart to uploadState() — ensures resumed loops start
 * with the same .claude directory as the parent run.
 */
async function downloadState(workDir) {
  if (!config.s3ParentStateKey) {
    return;
  }

  log("info", "Downloading prior run state from parent loop...");
  const parentPrefix = config.s3ParentStateKey;

  // 1. Restore workDir/.claude from parent's claude-state
  try {
    const claudeStatePrefix = `${parentPrefix}/claude-state`;
    const claudeDir = path.join(workDir, ".claude");
    const count = await downloadDirectoryFromS3(claudeStatePrefix, claudeDir);
    log("info", `Restored ${count} files to ${claudeDir}`);
  } catch (err) {
    log(
      "error",
      `Failed to download claude-state (best-effort): ${err.message}`
    );
  }

  // 2. Restore ~/.claude/{projects,sessions} from parent's home-claude-state
  try {
    const homeClaudePrefix = `${parentPrefix}/home-claude-state`;
    const homeClaudeDir = path.join(os.homedir(), ".claude");
    const count = await downloadDirectoryFromS3(homeClaudePrefix, homeClaudeDir);
    log("info", `Restored ${count} files to ${homeClaudeDir}`);
  } catch (err) {
    log(
      "error",
      `Failed to download home-claude-state (best-effort): ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Event reporting
// ---------------------------------------------------------------------------
async function reportEvent(event) {
  const url = `${config.apiBaseUrl}/api/loops/${config.loopId}/events`;
  const payload = sanitizeValue({
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.authToken}`,
        "x-loop-event-nonce": randomUUID(),
      },
      body: JSON.stringify({
        type: payload.type,
        data: payload,
      }),
    });
    if (!resp.ok) {
      log(
        "error",
        `Event report failed (${resp.status}): ${redactSensitive(await resp.text())}`
      );
    }
  } catch (err) {
    log("error", `Event report error: ${redactSensitive(err.message)}`);
  }
}

// ---------------------------------------------------------------------------
// Context pack handling
// ---------------------------------------------------------------------------
async function downloadContextPack() {
  if (!config.s3ContextKey) {
    log("info", "No S3_CONTEXT_KEY set, skipping context pack download");
    return null;
  }

  let buf;
  try {
    buf = await downloadFromS3(config.s3ContextKey);
  } catch (err) {
    throw new HarnessError(
      ERROR_CODES.contextPackDownload,
      "Failed to download context pack from S3",
      err
    );
  }

  // Context packs are always JSON (uploaded by the backend via uploadContextPack).
  // Reject non-JSON payloads rather than attempting archive extraction, which
  // would introduce tar-slip risk and an unnecessary attack surface.
  let pack;
  try {
    pack = JSON.parse(buf.toString("utf-8"));
  } catch {
    throw new HarnessError(
      ERROR_CODES.contextPackInvalid,
      "Context pack is not valid JSON. Expected JSON from backend uploadContextPack."
    );
  }

  // Extract secrets from context pack before writing anything to disk.
  // Secrets must never be persisted to the filesystem.
  if (pack.secrets) {
    if (pack.secrets.anthropicApiKey) {
      config.anthropicApiKey = pack.secrets.anthropicApiKey;
    }
    if (pack.secrets.githubToken) {
      config.githubToken = pack.secrets.githubToken;
    }
    log("info", "Extracted secrets from context pack");
  }

  return pack;
}

function writeContextPackFiles(workDir, pack) {
  if (!pack) {
    return;
  }
  try {
    const contextDir = path.join(workDir, ".claude", "context");
    fs.mkdirSync(contextDir, { recursive: true });

    // Write structured context pack fields as specific files that the CLI expects.
    // The pack schema is: { command, prompt?, artifacts[], repoInfo?, priorLoopSummaries?, secrets? }

    let filesWritten = 0;

    // Write prompt as prompt.md (used by buildClaudeDirectArgs and run-loop.sh)
    if (pack.prompt) {
      fs.writeFileSync(path.join(contextDir, "prompt.md"), pack.prompt);
      filesWritten++;
    }

    // Write each artifact as artifacts/<type>-<id>.md
    if (Array.isArray(pack.artifacts) && pack.artifacts.length > 0) {
      const artifactsDir = path.join(contextDir, "artifacts");
      fs.mkdirSync(artifactsDir, { recursive: true });
      for (const artifact of pack.artifacts) {
        const safeName = (artifact.type || "artifact")
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "_");
        const fileName = `${safeName}-${artifact.id}.md`;
        const header = `# ${artifact.title || "Untitled"}\n\n`;
        fs.writeFileSync(
          path.join(artifactsDir, fileName),
          header + (artifact.content || "")
        );
        filesWritten++;
      }
    }

    // Write repo info as repo-info.json (informational for CLAUDE.md context)
    if (pack.repoInfo) {
      fs.writeFileSync(
        path.join(contextDir, "repo-info.json"),
        JSON.stringify(pack.repoInfo, null, 2)
      );
      filesWritten++;
    }

    // Write prior loop summaries as prior-loops.md
    if (
      Array.isArray(pack.priorLoopSummaries) &&
      pack.priorLoopSummaries.length > 0
    ) {
      const lines = pack.priorLoopSummaries.map(
        (s) => `## Loop ${s.loopId} (${s.command})\n\n${s.summary}`
      );
      fs.writeFileSync(
        path.join(contextDir, "prior-loops.md"),
        lines.join("\n\n---\n\n")
      );
      filesWritten++;
    }

    log("info", `Wrote ${filesWritten} context pack files`);
  } catch (err) {
    throw new HarnessError(
      ERROR_CODES.contextPackWrite,
      "Failed to write context pack files",
      err
    );
  }
}

// ---------------------------------------------------------------------------
// Git auth helper (shared between clone and safety commit)
// ---------------------------------------------------------------------------
function buildGitAuthEnv() {
  const authHeader = Buffer.from(
    `x-access-token:${config.githubToken}`,
    "utf-8"
  ).toString("base64");
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME || os.homedir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authHeader}`,
  };
}

// ---------------------------------------------------------------------------
// Repository cloning
// ---------------------------------------------------------------------------
function cloneRepo(workDir) {
  const cloneUrl = `https://github.com/${config.targetRepo}.git`;
  log("info", `Cloning ${config.targetRepo} (branch: ${config.targetBranch})`);

  // Use execFileSync with array args to prevent shell injection via branch/repo names
  execFileSync(
    "git",
    [
      "clone",
      "--depth",
      "50",
      "--branch",
      config.targetBranch,
      cloneUrl,
      workDir,
    ],
    {
      stdio: "pipe",
      env: buildGitAuthEnv(),
    }
  );

  // Configure git identity for any commits the agent might make
  execFileSync("git", ["config", "user.name", "Symphony Agent"], {
    cwd: workDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", "agent@closedloop.ai"], {
    cwd: workDir,
    stdio: "pipe",
  });

  log("info", "Repository cloned successfully");
}

// ---------------------------------------------------------------------------
// Safety commit (best-effort on any exit path)
// ---------------------------------------------------------------------------
function attemptSafetyCommit(
  workDir,
  commitMessage = "[INCOMPLETE] WIP: Safety commit — loop interrupted"
) {
  if (!(config.targetRepo && config.githubToken)) {
    return;
  }
  try {
    // Stage everything except .claude directory (matches dispatch pattern)
    execFileSync("git", ["add", "-A", "--", ":!.claude"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 5000,
    });

    // Check if there are staged changes (exit 1 = changes exist)
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], {
        cwd: workDir,
        stdio: "pipe",
        timeout: 5000,
      });
      // Exit 0 means no changes — nothing to commit
      log("info", "Safety commit: no uncommitted changes");
      return;
    } catch {
      // Exit non-zero means there are staged changes — proceed
    }

    execFileSync("git", ["commit", "-m", commitMessage], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 10_000,
    });

    const currentBranch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: workDir,
        stdio: "pipe",
        timeout: 5000,
      }
    )
      .toString()
      .trim();

    // Never push a safety commit directly to the target branch.
    if (currentBranch === config.targetBranch) {
      log(
        "error",
        `Safety commit created on target branch (${currentBranch}); skipping push`
      );
      return;
    }

    execFileSync("git", ["push", "origin", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 15_000,
      env: buildGitAuthEnv(),
    });

    log("info", "Safety commit pushed successfully");
  } catch (err) {
    log("error", `Safety commit failed (best-effort): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Ensure working branch is pushed (even if safety commit was a no-op)
// ---------------------------------------------------------------------------
function ensureBranchPushed(workDir) {
  if (!(config.targetRepo && config.githubToken)) {
    return;
  }
  const branchName = detectBranchName(workDir);
  if (!branchName) {
    return; // on target branch, don't push
  }
  try {
    execFileSync("git", ["push", "origin", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 30_000,
      env: buildGitAuthEnv(),
    });
  } catch (err) {
    // Push may fail if already up to date (non-fast-forward), or token expired.
    // This is best-effort — the safety commit push may have already succeeded.
    log("error", `Branch push failed (best-effort): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// PR info parsing
// ---------------------------------------------------------------------------
const RE_GITHUB_PR_URL = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;

/**
 * Try to read execution-result.json from the most recent run directory.
 */
function readExecutionResult(workDir) {
  const runsDir = path.join(workDir, ".claude", "runs");
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const runs = fs.readdirSync(runsDir).sort().reverse();
  for (const run of runs) {
    const resultFile = path.join(runsDir, run, "execution-result.json");
    if (!fs.existsSync(resultFile)) {
      continue;
    }
    const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
    const prUrl = result.pr_url || result.prUrl;
    if (!prUrl) {
      continue;
    }
    const prMatch = prUrl.match(RE_GITHUB_PR_URL);
    return {
      prUrl,
      prNumber: prMatch
        ? Number.parseInt(prMatch[1], 10)
        : (result.pr_number ?? result.prNumber ?? null),
      branchName: result.branch_name || result.branchName || null,
      commitSha: result.commit_sha || result.commitSha || null,
    };
  }
  return null;
}

/**
 * Try to detect the current branch name (if different from target).
 */
function detectBranchName(workDir) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    if (branch && branch !== config.targetBranch && branch !== "HEAD") {
      return branch;
    }
  } catch {
    // Ignore
  }
  return null;
}

function parsePrInfo(workDir, outputLines) {
  // Strategy 1: Check for execution-result.json written by run-loop.sh
  try {
    const fromFile = readExecutionResult(workDir);
    if (fromFile) {
      return fromFile;
    }
  } catch (err) {
    log("info", `execution-result.json parse attempt: ${err.message}`);
  }

  // Strategy 2: Regex scan output lines (reverse order) for PR URL
  for (let i = outputLines.length - 1; i >= 0; i--) {
    const line = outputLines[i].line || "";
    const match = line.match(RE_GITHUB_PR_URL);
    if (match) {
      return {
        prUrl: match[0],
        prNumber: Number.parseInt(match[1], 10),
        branchName: null,
        commitSha: null,
      };
    }
  }

  // Strategy 3: Get branch name from git if we have a workdir
  const branch = detectBranchName(workDir);
  if (branch) {
    return { prUrl: null, prNumber: null, branchName: branch, commitSha: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fallback PR creation (best-effort if Claude didn't create one)
// ---------------------------------------------------------------------------
function ensurePrExists(workDir, existingPrInfo) {
  if (existingPrInfo?.prUrl) {
    return existingPrInfo;
  }
  if (!(config.targetRepo && config.githubToken)) {
    return existingPrInfo;
  }

  const branchName = detectBranchName(workDir);
  if (!branchName) {
    return existingPrInfo; // still on target branch
  }

  // Check if there are commits ahead of the target branch
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `origin/${config.targetBranch}..HEAD`],
      { cwd: workDir, stdio: "pipe", timeout: 5000 }
    )
      .toString()
      .trim();
    if (count === "0") {
      return existingPrInfo;
    }
  } catch {
    // Remote tracking may not exist; proceed with PR attempt anyway
  }

  try {
    const title = `Symphony: ${config.command} — loop ${config.loopId}`;
    const body = [
      "Automated PR created by Symphony loop runner.",
      "",
      `**Loop:** \`${config.loopId}\``,
      `**Command:** \`${config.command}\``,
    ].join("\n");

    const result = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--label",
        "symphony",
        "--head",
        branchName,
        "--base",
        config.targetBranch,
      ],
      {
        cwd: workDir,
        stdio: "pipe",
        timeout: 30_000,
        env: { ...buildGitAuthEnv(), GH_TOKEN: config.githubToken },
      }
    );

    const prUrl = result.toString().trim();
    const prMatch = prUrl.match(/\/pull\/(\d+)/);
    log("info", `Fallback PR created: ${prUrl}`);
    return {
      prUrl,
      prNumber: prMatch ? Number.parseInt(prMatch[1], 10) : null,
      branchName,
      commitSha: null,
    };
  } catch (err) {
    log(
      "error",
      `Fallback PR creation failed (best-effort): ${err.message}`
    );
    return existingPrInfo;
  }
}

// ---------------------------------------------------------------------------
// Incomplete-implementation labeling (best-effort)
// ---------------------------------------------------------------------------
function labelPrIncomplete(workDir, prNumber) {
  if (!prNumber || !config.githubToken) {
    return;
  }
  try {
    execFileSync(
      "gh",
      [
        "pr",
        "edit",
        String(prNumber),
        "--add-label",
        "incomplete-implementation",
      ],
      {
        cwd: workDir,
        stdio: "pipe",
        timeout: 15_000,
        env: { ...buildGitAuthEnv(), GH_TOKEN: config.githubToken },
      }
    );
    log(
      "info",
      `Added 'incomplete-implementation' label to PR #${prNumber}`
    );
  } catch (err) {
    log(
      "error",
      `Failed to label PR #${prNumber} (best-effort): ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Session ID capture
// ---------------------------------------------------------------------------
let capturedSessionId = null;
const RE_SESSION_ID =
  /(?:Session:\s*|"session_id"\s*:\s*")([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// ---------------------------------------------------------------------------
// Run-loop discovery
// ---------------------------------------------------------------------------
function findRunLoop() {
  const pluginCachePath = path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "cache",
    "closedloop",
    "experimental"
  );
  const runLoopPath = path.join(pluginCachePath, "run-loop.sh");

  if (fs.existsSync(runLoopPath)) {
    log("info", `Found run-loop.sh at ${runLoopPath}`);
    return runLoopPath;
  }

  // Fallback: search common locations
  const fallbackPaths = [
    path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "closedloop",
      "experimental",
      "run-loop.sh"
    ),
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/plugins/closedloop/experimental/run-loop.sh",
  ];

  for (const p of fallbackPaths) {
    if (fs.existsSync(p)) {
      log("info", `Found run-loop.sh at fallback path: ${p}`);
      return p;
    }
  }

  throw new Error(
    `run-loop.sh not found. Searched: ${runLoopPath}, ${fallbackPaths.join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Child process execution
// ---------------------------------------------------------------------------
function spawnProcess(cmd, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    let lastReportedAt = 0;
    const REPORT_INTERVAL_MS = 5000; // Report output events at most every 5s

    log("info", `Spawning: ${cmd} ${args.join(" ")}`);

    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Track the child so SIGTERM handler can kill it
    currentChild = child;

    function handleLine(stream, line) {
      const safeLine = redactSensitive(line);
      outputChunks.push({ stream, line: safeLine, ts: Date.now() });

      // Capture session ID from output (first match wins)
      if (!capturedSessionId) {
        const sessionMatch = line.match(RE_SESSION_ID);
        if (sessionMatch) {
          capturedSessionId = sessionMatch[1];
          log("info", `Captured session ID: ${capturedSessionId}`);
        }
      }

      // Log to container stdout/stderr
      if (stream === "stderr") {
        process.stderr.write(`[child] ${safeLine}\n`);
      } else {
        process.stdout.write(`[child] ${safeLine}\n`);
      }

      // Throttled event reporting
      const now = Date.now();
      if (now - lastReportedAt >= REPORT_INTERVAL_MS) {
        lastReportedAt = now;
        reportEvent({
          type: "output",
          chunk: safeLine,
          correlationId: config.correlationId,
        }).catch(() => {});
      }
    }

    let stdoutBuf = "";
    child.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop(); // keep partial line
      for (const line of lines) {
        handleLine("stdout", line);
      }
    });

    let stderrBuf = "";
    child.stderr.on("data", (data) => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop();
      for (const line of lines) {
        handleLine("stderr", line);
      }
    });

    child.on("error", (err) => {
      currentChild = null;
      reject(err);
    });

    child.on("close", (code, signal) => {
      currentChild = null;
      // Flush remaining partial lines
      if (stdoutBuf) {
        handleLine("stdout", stdoutBuf);
      }
      if (stderrBuf) {
        handleLine("stderr", stderrBuf);
      }

      resolve({ code, signal, output: outputChunks });
    });
  });
}

// ---------------------------------------------------------------------------
// Token usage parsing
// ---------------------------------------------------------------------------

/**
 * Parse Claude Code CLI output for per-model token usage.
 * Claude Code prints a summary like:
 *   Model: claude-opus-4-6  Input: 12345  Output: 6789  Cache creation: 100  Cache read: 200
 *   Model: claude-sonnet-4-5-20250929  Input: 5000  Output: 2000
 *
 * It may also print total lines like:
 *   Total input tokens: 17345
 *   Total output tokens: 8789
 *   Total cost: $1.23
 */

// Regex patterns for parsing token usage (top-level for performance)
const RE_MODEL_USAGE =
  /Model:\s*([\w.-]+)\s+Input:\s*([\d,]+)\s+Output:\s*([\d,]+)/i;
const RE_CACHE_CREATION = /Cache creation:\s*([\d,]+)/i;
const RE_CACHE_READ = /Cache read:\s*([\d,]+)/i;
const RE_TOTAL_INPUT = /Total input tokens:\s*([\d,]+)/i;
const RE_TOTAL_OUTPUT = /Total output tokens:\s*([\d,]+)/i;
const RE_DATE_SUFFIX = /-\d{8}$/;

/**
 * Parse a single model-usage line and accumulate into tokensByModel map.
 */
function accumulateModelUsage(tokensByModel, line, modelMatch) {
  const modelName = normalizeModelName(modelMatch[1]);
  const input = Number.parseInt(modelMatch[2].replace(/,/g, ""), 10);
  const output = Number.parseInt(modelMatch[3].replace(/,/g, ""), 10);

  if (!tokensByModel[modelName]) {
    tokensByModel[modelName] = { input: 0, output: 0 };
  }
  tokensByModel[modelName].input += input;
  tokensByModel[modelName].output += output;

  const cacheCreateMatch = line.match(RE_CACHE_CREATION);
  if (cacheCreateMatch) {
    tokensByModel[modelName].cacheCreation =
      (tokensByModel[modelName].cacheCreation || 0) +
      Number.parseInt(cacheCreateMatch[1].replace(/,/g, ""), 10);
  }
  const cacheReadMatch = line.match(RE_CACHE_READ);
  if (cacheReadMatch) {
    tokensByModel[modelName].cacheRead =
      (tokensByModel[modelName].cacheRead || 0) +
      Number.parseInt(cacheReadMatch[1].replace(/,/g, ""), 10);
  }
}

function parseTokenUsage(outputLines) {
  const tokensByModel = {};
  let totalInput = 0;
  let totalOutput = 0;

  for (const entry of outputLines) {
    const line = entry.line || "";

    const modelMatch = line.match(RE_MODEL_USAGE);
    if (modelMatch) {
      accumulateModelUsage(tokensByModel, line, modelMatch);
    }

    const totalInputMatch = line.match(RE_TOTAL_INPUT);
    if (totalInputMatch) {
      totalInput = Number.parseInt(totalInputMatch[1].replace(/,/g, ""), 10);
    }
    const totalOutputMatch = line.match(RE_TOTAL_OUTPUT);
    if (totalOutputMatch) {
      totalOutput = Number.parseInt(totalOutputMatch[1].replace(/,/g, ""), 10);
    }
  }

  const hasModelData = Object.keys(tokensByModel).length > 0;
  if (!hasModelData) {
    return { tokensByModel: null, totalInput, totalOutput };
  }

  let sumInput = 0;
  let sumOutput = 0;
  for (const usage of Object.values(tokensByModel)) {
    sumInput += usage.input;
    sumOutput += usage.output;
  }
  return {
    tokensByModel,
    totalInput: sumInput || totalInput,
    totalOutput: sumOutput || totalOutput,
  };
}

/**
 * Normalize model names to canonical short forms for consistent pricing lookup.
 * e.g., "claude-opus-4-6" -> "claude-opus-4"
 *        "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
 *        "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
 */
function normalizeModelName(rawName) {
  // Strip date suffixes like -20250929
  const stripped = rawName.replace(RE_DATE_SUFFIX, "");
  // Map known variants to canonical names
  const canonicalMap = {
    "claude-opus-4-6": "claude-opus-4",
    "claude-opus-4": "claude-opus-4",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-haiku-4-5": "claude-haiku-4-5",
  };
  return canonicalMap[stripped] || stripped;
}

// ---------------------------------------------------------------------------
// State upload
// ---------------------------------------------------------------------------
async function uploadState(workDir, output) {
  if (!(config.s3StateKey && config.s3Bucket)) {
    log("info", "No S3_STATE_KEY or S3_BUCKET set, skipping state upload");
    return;
  }

  const statePrefix = config.s3StateKey;

  // 1. Upload captured output log
  try {
    const logContent = output
      .map((o) => `[${new Date(o.ts).toISOString()}][${o.stream}] ${o.line}`)
      .join("\n");
    await uploadToS3(`${statePrefix}/output.log`, logContent, "text/plain");
  } catch (err) {
    log("error", `Failed to upload output log: ${err.message}`);
  }

  // 2. Upload .claude directory (conversation history, run state)
  const claudeDir = path.join(workDir, ".claude");
  if (fs.existsSync(claudeDir)) {
    try {
      await uploadDirectoryToS3(claudeDir, `${statePrefix}/claude-state`);
    } catch (err) {
      log("error", `Failed to upload .claude state: ${err.message}`);
    }
  }

  // 2b. Upload Claude HOME session state needed for --resume.
  // Claude stores resumable sessions under ~/.claude/{projects,sessions}.
  const homeClaudeDir = path.join(process.env.HOME || os.homedir(), ".claude");
  const homeStateDirs = ["projects", "sessions"];
  for (const relDir of homeStateDirs) {
    const absDir = path.join(homeClaudeDir, relDir);
    if (!fs.existsSync(absDir)) {
      continue;
    }
    try {
      await uploadDirectoryToS3(
        absDir,
        `${statePrefix}/home-claude-state/${relDir}`
      );
    } catch (err) {
      log("error", `Failed to upload ~/.claude/${relDir}: ${err.message}`);
    }
  }

  // 3. Upload key work directory files (plan.json, plan.md, etc.)
  const keyFiles = [
    "plan.json",
    "plan.md",
    "implementation-plan.md",
    ".claude/symphony-loop.local.md",
    "execution-result.json",
  ];
  for (const relPath of keyFiles) {
    const absPath = path.join(workDir, relPath);
    if (fs.existsSync(absPath)) {
      try {
        const content = fs.readFileSync(absPath);
        await uploadToS3(
          `${statePrefix}/artifacts/${relPath}`,
          content,
          "application/octet-stream"
        );
      } catch (err) {
        log("error", `Failed to upload ${relPath}: ${err.message}`);
      }
    }
  }

  log("info", "State upload complete");
}

/**
 * Upload metadata.json with token usage breakdown and execution info.
 */
async function uploadMetadata(_workDir, output, tokenUsage, startTime) {
  if (!(config.s3StateKey && config.s3Bucket)) {
    return;
  }

  const statePrefix = config.s3StateKey;

  // Collect files read/written from output
  const filesWritten = [];
  const filesRead = [];
  let toolCalls = 0;

  for (const entry of output) {
    const line = entry.line || "";
    // Count tool calls from Claude Code output
    if (line.includes("Tool:") || line.includes("tool_use")) {
      toolCalls++;
    }
  }

  const metadata = {
    loopId: config.loopId,
    command: config.command,
    status: "COMPLETED",
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
    tokensInput: tokenUsage.totalInput,
    tokensOutput: tokenUsage.totalOutput,
    tokensByModel: tokenUsage.tokensByModel,
    filesRead,
    filesWritten,
    toolCalls,
  };

  try {
    await uploadToS3(
      `${statePrefix}/metadata.json`,
      JSON.stringify(metadata, null, 2),
      "application/json"
    );
    log("info", "Metadata uploaded to S3");
  } catch (err) {
    log("error", `Failed to upload metadata: ${err.message}`);
  }
}

async function uploadDirectoryToS3(dirPath, s3Prefix) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const s3Key = `${s3Prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await uploadDirectoryToS3(fullPath, s3Key);
    } else if (entry.isFile()) {
      // Skip very large files (>50MB) to avoid timeouts
      const stat = fs.statSync(fullPath);
      if (stat.size > 50 * 1024 * 1024) {
        log("info", `Skipping large file ${fullPath} (${stat.size} bytes)`);
        continue;
      }
      const content = fs.readFileSync(fullPath);
      await uploadToS3(s3Key, content);
    }
  }
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------
function buildRunLoopArgs(runLoopPath, _workDir) {
  const command = config.command.toLowerCase();
  const args = [runLoopPath];

  switch (command) {
    case "plan":
      args.push("--max-iterations", String(config.maxIterations || 50));
      break;
    case "execute":
      args.push("--max-iterations", String(config.maxIterations || 150));
      break;
    default:
      args.push("--max-iterations", String(config.maxIterations || 50));
      break;
  }

  return { cmd: "bash", args };
}

function buildClaudeDirectArgs(workDir) {
  const command = config.command.toLowerCase();
  const args = [];

  // If resuming from a parent loop, use --resume to continue the session
  if (config.parentSessionId) {
    args.push("--resume", config.parentSessionId);
  }

  switch (command) {
    case "request_changes": {
      // Use the amend-plan skill
      const contextDir = path.join(workDir, ".claude", "context");
      const promptFile = path.join(contextDir, "prompt.md");
      let prompt = "Please amend the plan based on the requested changes.";
      if (fs.existsSync(promptFile)) {
        prompt = fs.readFileSync(promptFile, "utf-8");
      }
      args.push("/experimental:amend-plan", prompt);
      break;
    }
    case "chat":
    case "explore": {
      const contextDir = path.join(workDir, ".claude", "context");
      const promptFile = path.join(contextDir, "prompt.md");
      let prompt = "";
      if (fs.existsSync(promptFile)) {
        prompt = fs.readFileSync(promptFile, "utf-8");
      }
      if (!prompt) {
        throw new Error(`No prompt found for ${command} command`);
      }
      args.push(prompt);
      break;
    }
    default:
      throw new Error(
        `Unexpected command for direct claude invocation: ${command}`
      );
  }

  return { cmd: "claude", args };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let currentChild = null;
let shuttingDown = false;

function setupShutdownHandlers(workDir) {
  async function handleShutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log("info", `Received ${signal}, initiating graceful shutdown...`);

    // Kill the child process and wait for it to exit
    if (currentChild && !currentChild.killed) {
      log("info", "Terminating child process...");
      currentChild.kill("SIGTERM");

      // Wait for child to exit (up to 10s), then force kill
      await new Promise((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (currentChild && !currentChild.killed) {
            log("info", "Force killing child process...");
            currentChild.kill("SIGKILL");
          }
        }, 10_000);

        const onExit = () => {
          clearTimeout(forceKillTimer);
          resolve();
        };

        if (currentChild) {
          currentChild.once("close", onExit);
        } else {
          onExit();
        }
      });
    }

    // Attempt safety commit before uploading state
    attemptSafetyCommit(
      workDir,
      "[INCOMPLETE] WIP: Safety commit — loop cancelled"
    );

    // Try to upload whatever state we have
    try {
      await uploadState(workDir, []);
    } catch (err) {
      log(
        "error",
        `Failed to upload state during shutdown: ${redactSensitive(
          err instanceof Error ? err.message : String(err)
        )}`
      );
    }

    // Report cancelled status
    try {
      await reportEvent({
        type: "error",
        code: "CANCELLED",
        message: `Loop cancelled (${signal})`,
        correlationId: config.correlationId,
      });
    } catch (err) {
      log(
        "error",
        `Failed to report cancellation: ${redactSensitive(
          err instanceof Error ? err.message : String(err)
        )}`
      );
    }

    process.exit(1);
  }

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Workspace preparation
// ---------------------------------------------------------------------------
function prepareWorkspace(workDir) {
  if (config.targetRepo) {
    try {
      cloneRepo(workDir);
    } catch (err) {
      throw new HarnessError(
        ERROR_CODES.gitClone,
        `Failed to clone repository ${config.targetRepo}@${config.targetBranch}`,
        err
      );
    }
  } else {
    fs.mkdirSync(workDir, { recursive: true });
    log("info", "No targetRepo — skipping clone, using empty workDir");
  }
}

function shouldCreateWorkingBranch() {
  const command = config.command?.toLowerCase();
  return command === "execute" || command === "request_changes";
}

function createWorkingBranch(workDir) {
  if (!config.targetRepo) {
    return null;
  }
  const currentBranch = execFileSync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd: workDir,
      stdio: "pipe",
      timeout: 5000,
    }
  )
    .toString()
    .trim();

  if (
    currentBranch &&
    currentBranch !== "HEAD" &&
    currentBranch !== config.targetBranch
  ) {
    log("info", `Working branch already set: ${currentBranch}`);
    return currentBranch;
  }

  // If resuming from a parent loop, checkout the parent's branch (with its commits)
  if (config.parentBranchName) {
    try {
      execFileSync(
        "git",
        ["fetch", "origin", config.parentBranchName],
        {
          cwd: workDir,
          stdio: "pipe",
          timeout: 30_000,
          env: buildGitAuthEnv(),
        }
      );
      execFileSync(
        "git",
        ["checkout", config.parentBranchName],
        {
          cwd: workDir,
          stdio: "pipe",
          timeout: 5000,
        }
      );
      log("info", `Checked out parent branch: ${config.parentBranchName}`);
      return config.parentBranchName;
    } catch (err) {
      log(
        "error",
        `Failed to checkout parent branch ${config.parentBranchName}: ${err.message}`
      );
      // Fall through to create a new branch
    }
  }

  const loopSuffix = (config.loopId || randomUUID())
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 50);
  const branchName = `symphony/${loopSuffix}`;

  try {
    try {
      execFileSync("git", ["checkout", "-b", branchName], {
        cwd: workDir,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Branch may already exist in local clone (e.g., retry). Reuse it.
      execFileSync("git", ["checkout", branchName], {
        cwd: workDir,
        stdio: "pipe",
        timeout: 5000,
      });
    }
  } catch (err) {
    throw new HarnessError(
      ERROR_CODES.branchCreate,
      `Failed to create or checkout working branch ${branchName}`,
      err
    );
  }

  log("info", `Created/checked out working branch: ${branchName}`);
  return branchName;
}

function validatePreRunInputs(command, contextPack) {
  const normalized = command.toLowerCase();
  const hasPrompt =
    typeof contextPack?.prompt === "string" &&
    contextPack.prompt.trim().length > 0;
  const hasArtifacts =
    Array.isArray(contextPack?.artifacts) && contextPack.artifacts.length > 0;

  if (normalized === "execute" && !(hasArtifacts || hasPrompt)) {
    throw new HarnessError(
      ERROR_CODES.preRunValidation,
      "Pre-run validation failed: EXECUTE requires prompt or artifacts in context pack"
    );
  }
  if (normalized === "request_changes" && !hasPrompt) {
    throw new HarnessError(
      ERROR_CODES.preRunValidation,
      "Pre-run validation failed: REQUEST_CHANGES requires a non-empty prompt"
    );
  }
}

function buildCommand(workDir) {
  const command = config.command.toLowerCase();
  const usesRunLoop = command === "plan" || command === "execute";

  if (usesRunLoop) {
    let runLoopPath;
    try {
      runLoopPath = findRunLoop();
    } catch (err) {
      throw new HarnessError(
        ERROR_CODES.runLoopNotFound,
        "run-loop.sh not found for plan/execute command",
        err
      );
    }
    return buildRunLoopArgs(runLoopPath, workDir);
  }
  return buildClaudeDirectArgs(workDir);
}

function toHarnessError(err) {
  if (err instanceof HarnessError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HarnessError(ERROR_CODES.runner, message, err);
}

// ---------------------------------------------------------------------------
// Harness-level timeout (Layer 1 of timeout enforcement)
// ---------------------------------------------------------------------------
const MAX_RUNTIME_MS = 55 * 60 * 1000; // 55 minutes (GitHub installation token safe window)

/**
 * Kill the current child process with SIGTERM, wait 5s, then SIGKILL.
 * Returns a promise that resolves when the child exits.
 */
function killChild() {
  return new Promise((resolve) => {
    if (!currentChild || currentChild.killed) {
      resolve();
      return;
    }
    currentChild.kill("SIGTERM");
    const forceKillTimer = setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 5000);

    currentChild.once("close", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Execute command with timeout enforcement
// ---------------------------------------------------------------------------
async function executeWithTimeout(cmd, args, workDir, childEnv) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("HARNESS_TIMEOUT")), MAX_RUNTIME_MS);
  });

  try {
    const result = await Promise.race([
      spawnProcess(cmd, args, workDir, childEnv),
      timeoutPromise,
    ]);
    return { result, timedOut: false };
  } catch (err) {
    if (err.message === "HARNESS_TIMEOUT") {
      log("error", `Harness timeout reached (${MAX_RUNTIME_MS / 1000}s)`);
      await killChild();
      return {
        result: { code: null, signal: "SIGKILL", output: [] },
        timedOut: true,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Report final status (completed, failed, or timed out)
// ---------------------------------------------------------------------------
async function reportFinalStatus(
  workDir,
  output,
  { timedOut, exitCode, signal, duration, tokenUsage, startTime }
) {
  // Step 1: Safety commit + push on ALL exit paths (matches dispatch `if: always()` pattern)
  const isIncomplete = timedOut || exitCode !== 0;
  const commitMsg = timedOut
    ? "[INCOMPLETE] WIP: Safety commit — loop timed out"
    : exitCode !== 0
      ? "[INCOMPLETE] WIP: Safety commit — process failed"
      : "Post-run: uncommitted changes from loop execution";
  attemptSafetyCommit(workDir, commitMsg);
  ensureBranchPushed(workDir);

  // Step 2: Parse PR info (may have been created by Claude/run-loop during execution)
  let prInfo = parsePrInfo(workDir, output);

  // Step 3: Fallback PR creation if Claude didn't create one
  prInfo = ensurePrExists(workDir, prInfo);

  // Step 4: Label incomplete PRs
  if (isIncomplete && prInfo?.prNumber) {
    labelPrIncomplete(workDir, prInfo.prNumber);
  }

  if (prInfo) {
    log(
      "info",
      `PR info: url=${prInfo.prUrl}, number=${prInfo.prNumber}, branch=${prInfo.branchName}`
    );
  }
  if (capturedSessionId) {
    log("info", `Session ID: ${capturedSessionId}`);
  }

  // Step 5: Upload state + metadata
  await uploadState(workDir, output);
  await uploadMetadata(workDir, output, tokenUsage, startTime);

  // Step 6: Report event
  if (timedOut) {
    await reportEvent({
      type: "error",
      code: "TIMED_OUT",
      message: `Loop exceeded maximum runtime of ${MAX_RUNTIME_MS / 1000}s`,
      result: {
        ...(prInfo || {}),
        sessionId: capturedSessionId,
        durationSeconds: Number.parseFloat(duration),
      },
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported TIMED_OUT event");
    process.exit(1);
  }

  if (exitCode === 0) {
    await reportEvent({
      type: "completed",
      result: {
        exitCode,
        signal,
        durationSeconds: Number.parseFloat(duration),
        ...(prInfo || {}),
        sessionId: capturedSessionId,
      },
      tokensUsed: {
        input: tokenUsage.totalInput,
        output: tokenUsage.totalOutput,
      },
      tokensByModel: tokenUsage.tokensByModel,
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported COMPLETED event");
  } else {
    await reportEvent({
      type: "error",
      code: "PROCESS_FAILED",
      message: `Process exited with code ${exitCode}`,
      result: {
        ...(prInfo || {}),
        sessionId: capturedSessionId,
      },
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported FAILED event");
  }
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------
async function main() {
  const startTime = Date.now();
  const workDir = "/workspace/repo";

  log("info", "========================================");
  log("info", "Symphony Claude Runner - Harness Agent");
  log("info", "========================================");
  log("info", `Loop ID:        ${config.loopId}`);
  log("info", `Command:        ${config.command}`);
  log("info", `Target Repo:    ${config.targetRepo || "(none)"}`);

  log("info", `Target Branch:  ${config.targetBranch}`);
  log("info", `Correlation ID: ${config.correlationId}`);
  log("info", `Max Iterations: ${config.maxIterations}`);
  log("info", `Max Runtime:    ${MAX_RUNTIME_MS / 1000}s`);

  validateConfig();
  setupShutdownHandlers(workDir);

  let output = [];

  try {
    // Step 1: Download context pack and validate secrets BEFORE reporting started.
    // The "started" event triggers secret scrubbing on the backend, so we must
    // consume the secrets first to avoid a race condition.
    const contextPack = await downloadContextPack();
    validateSecrets();

    // Step 2: Report started event (triggers backend secret scrubbing)
    await reportEvent({
      type: "started",
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported STARTED event");

    // Step 3: Clone the target repository or prepare an empty workspace
    prepareWorkspace(workDir);

    // Step 3a: Restore prior run state from parent loop (if resuming).
    // This restores .claude/ and ~/.claude/ so run-loop can continue
    // where the parent left off.
    await downloadState(workDir);

    // Step 3b: Write context files into the prepared workspace.
    // This must happen after clone AND after downloadState — clone fails on
    // non-empty dir, and we want fresh context to overwrite .claude/context/.
    writeContextPackFiles(workDir, contextPack);

    // Step 3c: Command-level validation and branch hardening.
    validatePreRunInputs(config.command, contextPack);
    if (shouldCreateWorkingBranch()) {
      createWorkingBranch(workDir);
    }

    // Step 4: Determine execution mode and build command
    const { cmd, args } = buildCommand(workDir);

    // Step 5: Build environment for the child process
    const childEnv = {
      ANTHROPIC_API_KEY: config.anthropicApiKey,
      GITHUB_TOKEN: config.githubToken,
      GH_TOKEN: config.githubToken,
      HOME: process.env.HOME || os.homedir(),
      PATH: process.env.PATH,
      LANG: process.env.LANG || "C.UTF-8",
    };

    // Step 6: Execute with timeout
    log("info", `Executing: ${cmd} ${args.join(" ")}`);
    const { result, timedOut } = await executeWithTimeout(
      cmd,
      args,
      workDir,
      childEnv
    );
    output = result.output;

    const exitCode = timedOut ? null : result.code;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      "info",
      `Process exited with code ${exitCode} (signal: ${result.signal}) after ${duration}s`
    );

    // Step 7: Parse token usage
    const tokenUsage = parseTokenUsage(output);
    log(
      "info",
      `Token usage: input=${tokenUsage.totalInput}, output=${tokenUsage.totalOutput}, models=${
        tokenUsage.tokensByModel
          ? Object.keys(tokenUsage.tokensByModel).join(", ")
          : "unknown"
      }`
    );

    // Step 8: Report final status + upload
    await reportFinalStatus(workDir, output, {
      timedOut,
      exitCode,
      signal: result.signal,
      duration,
      tokenUsage,
      startTime,
    });

    // Exit with the child's exit code
    process.exit(exitCode || 0);
  } catch (err) {
    const harnessError = toHarnessError(err);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const errorMessage = harnessError.message;
    const errorStack = err instanceof Error ? err.stack : undefined;
    log(
      "error",
      `Fatal error after ${duration}s [${harnessError.code}]: ${redactSensitive(errorMessage)}`
    );
    if (errorStack) {
      log("error", redactSensitive(errorStack));
    }

    // Best-effort: upload whatever state we have
    try {
      await uploadState(workDir, output);
    } catch (uploadErr) {
      log(
        "error",
        `Failed to upload state after error: ${redactSensitive(uploadErr.message)}`
      );
    }

    // Best-effort: report failure with PR info if available
    try {
      const prInfo = parsePrInfo(workDir, output);
      await reportEvent({
        type: "error",
        code: harnessError.code,
        message: redactSensitive(errorMessage),
        result: {
          ...(prInfo || {}),
          sessionId: capturedSessionId,
        },
        correlationId: config.correlationId,
        loopId: config.loopId,
      });
    } catch (reportErr) {
      log(
        "error",
        `Failed to report error event: ${redactSensitive(reportErr.message)}`
      );
    }

    process.exit(1);
  }
}

main();
