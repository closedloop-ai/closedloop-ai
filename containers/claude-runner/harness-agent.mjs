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
  command: process.env.COMMAND?.toUpperCase(), // "PLAN" | "EXECUTE" | "CHAT" | "EXPLORE" | "REQUEST_CHANGES"
  anthropicApiKey: null, // Injected from S3 context pack (not env vars)
  githubToken: null, // Injected from S3 context pack (not env vars)
  committerName: null, // Injected from S3 context pack (triggering user's name)
  committerEmail: null, // Injected from S3 context pack (triggering user's email)
  authToken: process.env.CLOSEDLOOP_AUTH_TOKEN, // JWT for backend API calls
  apiBaseUrl: process.env.API_BASE_URL, // e.g., "https://api.closedloop.ai"
  organizationId: process.env.ORGANIZATION_ID,
  artifactId: process.env.ARTIFACT_ID,
  targetRepo: process.env.TARGET_REPO, // "owner/repo"
  targetBranch: process.env.TARGET_BRANCH || "main",
  s3ContextKey: process.env.S3_CONTEXT_KEY, // S3 key for context pack download
  s3ContextUrl: process.env.S3_CONTEXT_URL || null, // Pre-signed GET URL (preferred over S3 SDK)
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
// Safe patterns for git/CLI arguments to prevent argument injection
const RE_SAFE_REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const RE_SAFE_BRANCH = /^[a-zA-Z0-9/_.-]{1,200}$/;
const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateConfig() {
  // Validate required environment variables (available before context pack download).
  // Secrets (anthropicApiKey, githubToken) are delivered via S3 context pack,
  // so they are validated separately after download.
  const requiredEnv = ["loopId", "command", "authToken", "apiBaseUrl"];

  // targetRepo is only required for commands that operate on a repository.
  // chat/explore can run prompt-only without a repo.
  const repoCommands = new Set(["PLAN", "EXECUTE", "REQUEST_CHANGES"]);
  if (repoCommands.has(config.command)) {
    requiredEnv.push("targetRepo");
  }

  const missing = requiredEnv.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new HarnessError(
      ERROR_CODES.config,
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  // Validate format of values that will be passed to git/CLI to prevent argument injection
  if (config.targetRepo && !RE_SAFE_REPO.test(config.targetRepo)) {
    throw new HarnessError(
      ERROR_CODES.config,
      `Invalid TARGET_REPO format: must be "owner/repo" (alphanumeric, dots, hyphens, underscores)`
    );
  }
  if (config.targetBranch && !RE_SAFE_BRANCH.test(config.targetBranch)) {
    throw new HarnessError(
      ERROR_CODES.config,
      "Invalid TARGET_BRANCH format: must be alphanumeric with /, _, ., - (max 200 chars)"
    );
  }
  if (
    config.parentBranchName &&
    !RE_SAFE_BRANCH.test(config.parentBranchName)
  ) {
    throw new HarnessError(
      ERROR_CODES.config,
      "Invalid PARENT_BRANCH_NAME format: must be alphanumeric with /, _, ., - (max 200 chars)"
    );
  }
  if (config.parentSessionId && !RE_UUID.test(config.parentSessionId)) {
    throw new HarnessError(
      ERROR_CODES.config,
      "Invalid PARENT_SESSION_ID format: must be a valid UUID"
    );
  }
}

function validateSecrets() {
  // Validate secrets extracted from S3 context pack.
  const requiredSecrets = ["anthropicApiKey"];

  // Repo commands need a GitHub token for clone/push operations.
  const repoCommands = new Set(["PLAN", "EXECUTE", "REQUEST_CHANGES"]);
  if (repoCommands.has(config.command)) {
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
// S3 helpers — pre-signed URLs (preferred) with direct SDK fallback
// ---------------------------------------------------------------------------
//
// Multi-tenant isolation: the container should NOT have direct S3 credentials.
// Instead, it uses pre-signed URLs from the API server. The S3 SDK path is
// kept as a backward-compatibility fallback during the transition period.
// Once the ECS task role's S3 permissions are removed (infra change), only
// the pre-signed URL path will work.
// ---------------------------------------------------------------------------
let s3;

function getS3Client() {
  if (!s3) {
    s3 = new S3Client({ region: config.s3Region });
  }
  return s3;
}

/**
 * Download a file using a pre-signed URL (no S3 credentials needed).
 */
async function downloadFromPresignedUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Pre-signed download failed (${resp.status}): ${resp.statusText}`
    );
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Upload a file using a pre-signed PUT URL (no S3 credentials needed).
 */
async function uploadToPresignedUrl(
  url,
  body,
  contentType = "application/octet-stream"
) {
  const resp = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!resp.ok) {
    throw new Error(
      `Pre-signed upload failed (${resp.status}): ${resp.statusText}`
    );
  }
}

/**
 * Request pre-signed upload URLs from the API server.
 * Returns a map of key → pre-signed PUT URL.
 */
async function requestUploadUrls(keys) {
  if (!(config.authToken && config.apiBaseUrl && config.loopId)) {
    return null;
  }
  const url = `${config.apiBaseUrl}/loops/${config.loopId}/upload-urls`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.authToken}`,
    },
    body: JSON.stringify({ keys }),
  });
  if (!resp.ok) {
    throw new Error(`Upload URLs request failed (${resp.status})`);
  }
  const body = await resp.json();
  const urlMap = {};
  for (const entry of body.data.urls) {
    urlMap[entry.key] = entry.url;
  }
  return urlMap;
}

/**
 * Request pre-signed download URLs from the API server for a given prefix.
 * Returns an array of { key, url } entries.
 */
async function requestDownloadUrls(prefix) {
  if (!(config.authToken && config.apiBaseUrl && config.loopId)) {
    return null;
  }
  const url = `${config.apiBaseUrl}/loops/${config.loopId}/download-urls`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.authToken}`,
    },
    body: JSON.stringify({ prefix }),
  });
  if (!resp.ok) {
    throw new Error(`Download URLs request failed (${resp.status})`);
  }
  const body = await resp.json();
  return body.data.urls; // Array of { key, url }
}

// --- Fallback: direct S3 SDK (used when pre-signed URLs are unavailable) ---

async function downloadFromS3(key) {
  log("info", `Downloading s3://${config.s3Bucket}/${key} (SDK fallback)`);
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
  log("info", `Uploading s3://${config.s3Bucket}/${key} (SDK fallback)`);
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
 * Upload a single file: prefer pre-signed URL, fall back to S3 SDK.
 */
async function uploadFile(key, body, contentType = "application/octet-stream") {
  try {
    const urlMap = await requestUploadUrls([key]);
    if (urlMap?.[key]) {
      await uploadToPresignedUrl(urlMap[key], body, contentType);
      return;
    }
  } catch (err) {
    log(
      "info",
      `Pre-signed upload unavailable for ${key}, using SDK fallback: ${err.message}`
    );
  }
  await uploadToS3(key, body, contentType);
}

/**
 * Collect all file paths in a directory tree (recursive).
 * Returns array of { localPath, relativePath }.
 */
function collectFiles(dirPath, prefix = "") {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      if (stat.size <= 50 * 1024 * 1024) {
        results.push({ localPath: fullPath, relativePath: relPath });
      } else {
        log("info", `Skipping large file ${fullPath} (${stat.size} bytes)`);
      }
    }
  }
  return results;
}

/**
 * Upload an entire directory: batch-request pre-signed URLs, fall back to S3 SDK.
 */
async function uploadDirectory(dirPath, s3Prefix) {
  const files = collectFiles(dirPath);
  if (files.length === 0) {
    return;
  }

  const s3Keys = files.map((f) => `${s3Prefix}/${f.relativePath}`);

  // Try batch pre-signed URL request
  let urlMap = null;
  try {
    urlMap = await requestUploadUrls(s3Keys);
  } catch (err) {
    log(
      "info",
      `Batch upload URLs unavailable, using SDK fallback: ${err.message}`
    );
  }

  for (let i = 0; i < files.length; i++) {
    const content = fs.readFileSync(files[i].localPath);
    const key = s3Keys[i];
    try {
      if (urlMap?.[key]) {
        await uploadToPresignedUrl(urlMap[key], content);
      } else {
        await uploadToS3(key, content);
      }
    } catch (err) {
      log("error", `Failed to upload ${key}: ${err.message}`);
    }
  }
}

/**
 * Download files from pre-signed URLs to a local directory.
 * Returns count of files downloaded, or null if no entries were available.
 */
async function downloadViaPresignedUrls(entries, s3Prefix, localDir) {
  const normalizedPrefix = s3Prefix.endsWith("/") ? s3Prefix : `${s3Prefix}/`;
  let downloaded = 0;
  const resolvedLocalDir = path.resolve(localDir);
  for (const entry of entries) {
    const relativePath = entry.key.slice(normalizedPrefix.length);
    if (!relativePath) {
      continue;
    }

    const localPath = path.join(localDir, relativePath);
    const resolvedLocalPath = path.resolve(localPath);
    if (
      !resolvedLocalPath.startsWith(resolvedLocalDir + path.sep) &&
      resolvedLocalPath !== resolvedLocalDir
    ) {
      log("error", `Path traversal attempt blocked: ${entry.key}`);
      continue;
    }

    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const data = await downloadFromPresignedUrl(entry.url);
    fs.writeFileSync(localPath, data);
    downloaded++;
  }
  log(
    "info",
    `Downloaded ${downloaded} files via pre-signed URLs to ${localDir}`
  );
  return downloaded;
}

/**
 * Download files from S3 directly via SDK to a local directory.
 * Lists all objects under the prefix and downloads each one.
 */
async function downloadViaS3Sdk(s3Prefix, localDir) {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const normalizedPrefix = s3Prefix.endsWith("/") ? s3Prefix : `${s3Prefix}/`;
  const client = getS3Client();
  const objects = [];
  let continuationToken;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: normalizedPrefix,
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

  let downloaded = 0;
  const resolvedDir = path.resolve(localDir);
  for (const obj of objects) {
    if (obj.Size > MAX_FILE_SIZE) {
      log("info", `Skipping large file (${obj.Size} bytes): ${obj.Key}`);
      continue;
    }
    const relativePath = obj.Key.slice(normalizedPrefix.length);
    if (!relativePath) {
      continue;
    }

    const localPath = path.join(localDir, relativePath);
    const resolvedPath = path.resolve(localPath);
    if (
      !resolvedPath.startsWith(resolvedDir + path.sep) &&
      resolvedPath !== resolvedDir
    ) {
      log("error", `Path traversal attempt blocked: ${obj.Key}`);
      continue;
    }

    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const data = await downloadFromS3(obj.Key);
    fs.writeFileSync(localPath, data);
    downloaded++;
  }
  log("info", `Downloaded ${downloaded} files via SDK fallback to ${localDir}`);
  return downloaded;
}

/**
 * Download an entire S3 "directory" (prefix) to a local directory.
 * Prefers pre-signed URL path (via API callback), falls back to S3 SDK.
 */
async function downloadDirectoryFromS3(s3Prefix, localDir) {
  // Try pre-signed URL path first
  try {
    const entries = await requestDownloadUrls(s3Prefix);
    if (entries && entries.length > 0) {
      return await downloadViaPresignedUrls(entries, s3Prefix, localDir);
    }
  } catch (err) {
    log(
      "info",
      `Pre-signed download URLs unavailable, using SDK fallback: ${err.message}`
    );
  }

  // Fallback: direct S3 SDK
  return downloadViaS3Sdk(s3Prefix, localDir);
}

/**
 * Download and restore prior run state from the parent loop.
 * Restores:
 *   - {parentPrefix}/claude-state/      → {workDir}/.claude/  (run state, conversation history)
 *   - {parentPrefix}/home-claude-state/  → ~/.claude/          (session state for --resume)
 *   - {parentPrefix}/artifacts/          → {workDir}/          (plan.json, plan.md, etc.)
 *
 * This is the counterpart to uploadState() — ensures resumed loops start
 * with the same working directory as the parent run.
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
    const count = await downloadDirectoryFromS3(
      homeClaudePrefix,
      homeClaudeDir
    );
    log("info", `Restored ${count} files to ${homeClaudeDir}`);
  } catch (err) {
    log(
      "error",
      `Failed to download home-claude-state (best-effort): ${err.message}`
    );
  }

  // Note: artifacts/ is NOT restored here. The run directory (which contains
  // plan.json, plan.md, etc.) is already restored as part of claude-state/
  // above (at .claude/runs/TIMESTAMP/). findExistingRunDir() locates it,
  // and syncPlanFromContextPack() updates it with the latest user edits.
  // Restoring artifacts/ to repo root would create confusing duplicates.
}

// ---------------------------------------------------------------------------
// Event reporting
// ---------------------------------------------------------------------------
async function reportEvent(event) {
  const url = `${config.apiBaseUrl}/loops/${config.loopId}/events`;
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
// GitHub token refresh (best-effort, never throws)
// ---------------------------------------------------------------------------
async function refreshGitHubToken() {
  if (!(config.authToken && config.apiBaseUrl && config.loopId)) {
    return;
  }
  try {
    const url = `${config.apiBaseUrl}/loops/${config.loopId}/github-token`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.authToken}`,
      },
    });
    if (!resp.ok) {
      log(
        "warn",
        `GitHub token refresh failed (${resp.status}): ${redactSensitive(await resp.text())}`
      );
      return;
    }
    const body = await resp.json();
    if (body.data?.token) {
      config.githubToken = body.data.token;
      log("info", "Refreshed GitHub token from API");
    }
  } catch (err) {
    log("warn", `GitHub token refresh error: ${redactSensitive(err.message)}`);
  }
}

// ---------------------------------------------------------------------------
// Context pack handling
// ---------------------------------------------------------------------------
async function downloadContextPack() {
  if (!(config.s3ContextKey || config.s3ContextUrl)) {
    log(
      "info",
      "No S3_CONTEXT_KEY or S3_CONTEXT_URL set, skipping context pack download"
    );
    return null;
  }

  let buf;
  try {
    if (config.s3ContextUrl) {
      // Preferred: download via pre-signed URL (no S3 credentials needed)
      log("info", "Downloading context pack via pre-signed URL");
      buf = await downloadFromPresignedUrl(config.s3ContextUrl);
    } else {
      // Fallback: direct S3 SDK (backward compat during transition)
      buf = await downloadFromS3(config.s3ContextKey);
    }
  } catch (err) {
    throw new HarnessError(
      ERROR_CODES.contextPackDownload,
      "Failed to download context pack",
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

  // Extract committer identity for git attribution (not a secret — safe to log).
  if (pack.committer) {
    config.committerName = pack.committer.name || null;
    config.committerEmail = pack.committer.email || null;
    log("info", `Committer: ${config.committerName} <${config.committerEmail}>`);
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
        const safeId = String(artifact.id || "unknown").replace(
          /[^a-zA-Z0-9_-]/g,
          "_"
        );
        const fileName = `${safeName}-${safeId}.md`;
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
// Run directory management
// ---------------------------------------------------------------------------

/**
 * Find an existing run directory restored from parent state.
 * downloadState() restores .claude/ from the parent, which includes
 * .claude/runs/TIMESTAMP/. We find that directory so child loops
 * (REQUEST_CHANGES, EXECUTE) operate on the same workspace as the parent.
 *
 * Returns the path to the most recent run directory, or null if none exists
 * (indicating this is a fresh PLAN with no parent).
 */
function findExistingRunDir(workDir) {
  const runsDir = path.join(workDir, ".claude", "runs");
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  try {
    const entries = fs.readdirSync(runsDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(); // Timestamp-prefixed names sort chronologically
    if (dirs.length === 0) {
      return null;
    }
    // Use the most recent run directory (last when sorted alphabetically)
    return path.join(runsDir, dirs.at(-1));
  } catch {
    return null;
  }
}

/**
 * Write prd.md to the run directory.
 *
 * Content priority:
 * 1. contextPack.prompt — explicit user prompt (e.g., request-changes text)
 * 2. First PRD artifact in contextPack.artifacts — the source PRD passed via contextRefs
 *
 * Without this, PLAN commands get no --prd flag and produce empty plans.
 */
function writePrdFile(targetDir, contextPack) {
  let prdContent = contextPack?.prompt ?? null;

  // Fall back to the first PRD-type artifact from context refs
  if (!prdContent && Array.isArray(contextPack?.artifacts)) {
    const prdArtifact = contextPack.artifacts.find((a) => a.type === "PRD");
    if (prdArtifact?.content) {
      prdContent = prdArtifact.content;
      log("info", `Using PRD artifact (${prdArtifact.id}) as prd.md content`);
    }
  }

  if (!prdContent) {
    return null;
  }
  const prdPath = path.join(targetDir, "prd.md");
  fs.writeFileSync(prdPath, prdContent);
  log("info", `Wrote prd.md to ${prdPath}`);
  return prdPath;
}

/**
 * Sync plan.json in the run directory with the latest content from the
 * context pack. This ensures manual edits the user made in the Liveblocks
 * editor (stored as artifact versions in the DB) are reflected in plan.json
 * before amend-plan or execute runs.
 *
 * The context pack's primary artifact (artifacts[0]) contains the latest
 * artifact version content from the platform.
 */
function syncPlanFromContextPack(runDir, contextPack) {
  if (!contextPack?.artifacts?.length) {
    return;
  }

  // The primary artifact is the plan content (latest version from DB)
  const primaryArtifact = contextPack.artifacts[0];
  if (!primaryArtifact?.content) {
    return;
  }

  const planJsonPath = path.join(runDir, "plan.json");

  // If plan.json exists, update its .content field preserving other fields
  // (pendingTasks, openQuestions, etc.). If it doesn't exist, the parent
  // may not have produced one yet (edge case) — skip.
  if (!fs.existsSync(planJsonPath)) {
    log(
      "info",
      "No existing plan.json in run dir — skipping context pack sync"
    );
    return;
  }

  try {
    const existing = JSON.parse(fs.readFileSync(planJsonPath, "utf-8"));
    existing.content = primaryArtifact.content;
    fs.writeFileSync(planJsonPath, JSON.stringify(existing, null, 2));
    log(
      "info",
      `Synced plan.json with latest artifact content (${primaryArtifact.content.length} chars)`
    );
  } catch (err) {
    log("error", `Failed to sync plan.json from context pack: ${err.message}`);
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

  // Configure git identity for any commits the agent might make.
  // Use committer info from the context pack (triggering user) when available,
  // falling back to generic identity. This ensures Vercel matches the commit
  // author to a team member for preview deploy permissions.
  const gitName = config.committerName || "Symphony Agent";
  const gitEmail = config.committerEmail || "agent@closedloop.ai";
  execFileSync("git", ["config", "user.name", gitName], {
    cwd: workDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", gitEmail], {
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
// Branch / PR info detection
// ---------------------------------------------------------------------------
const RE_GITHUB_PR_URL = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;

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

/**
 * Detect branch/PR info from the working directory and process output.
 *
 * NOTE: run-loop.sh does NOT create PRs or write execution-result.json.
 * PR creation is owned by the harness (createPullRequest), and
 * execution-result.json is written by writeExecutionResult() before S3 upload.
 * This function only detects branch info and checks if Claude happened to
 * create a PR during execution.
 */
function parsePrInfo(workDir, outputLines) {
  // Strategy 1: Get branch name from git (primary — always available after execute)
  const branch = detectBranchName(workDir);

  // Strategy 2: Scan output for PR URL (rare — only if Claude created one during execution)
  for (let i = outputLines.length - 1; i >= 0; i--) {
    const line = outputLines[i].line || "";
    const match = line.match(RE_GITHUB_PR_URL);
    if (match) {
      return {
        prUrl: match[0],
        prNumber: Number.parseInt(match[1], 10),
        branchName: branch,
        commitSha: null,
      };
    }
  }

  if (branch) {
    return { prUrl: null, prNumber: null, branchName: branch, commitSha: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// PR creation (harness owns this — mirrors symphony-dispatch.yml behavior)
// ---------------------------------------------------------------------------
/**
 * Create a pull request for the working branch. This is the primary PR
 * creation path — run-loop.sh does NOT create PRs, so the harness is
 * responsible, just like the "Commit and Push Changes" + "Create Pull
 * Request" steps in symphony-dispatch.yml.
 *
 * Skips creation if a PR was already detected (e.g., Claude created one
 * during execution) or if there are no commits ahead of the target branch.
 */
const PR_NUMBER_REGEX = /\/pull\/(\d+)/;

function createPullRequest(workDir, existingPrInfo) {
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
    const prMatch = PR_NUMBER_REGEX.exec(prUrl);
    log("info", `PR created: ${prUrl}`);
    return {
      prUrl,
      prNumber: prMatch ? Number.parseInt(prMatch[1], 10) : null,
      branchName,
      commitSha: null,
    };
  } catch (err) {
    log("error", `PR creation failed (best-effort): ${err.message}`);
    return existingPrInfo;
  }
}

// ---------------------------------------------------------------------------
// Incomplete-implementation labeling (best-effort)
// ---------------------------------------------------------------------------
function labelPrIncomplete(workDir, prNumber) {
  if (!(prNumber && config.githubToken)) {
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
    log("info", `Added 'incomplete-implementation' label to PR #${prNumber}`);
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

  // Fallback: search common locations (marketplace install, cache, global)
  const fallbackPaths = [
    path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "marketplaces",
      "closedloop",
      "closedloop",
      "experimental",
      "scripts",
      "run-loop.sh"
    ),
    path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "marketplaces",
      "closedloop",
      "closedloop",
      "experimental",
      "run-loop.sh"
    ),
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
    // Also write to module-level buffer so timeout/shutdown paths can access output
    liveOutputChunks = outputChunks;
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
async function uploadState(workDir, output, runDir) {
  if (!config.s3StateKey) {
    log("info", "No S3_STATE_KEY set, skipping state upload");
    return;
  }

  const statePrefix = config.s3StateKey;

  // 1. Upload captured output log
  try {
    const logContent = output
      .map((o) => `[${new Date(o.ts).toISOString()}][${o.stream}] ${o.line}`)
      .join("\n");
    await uploadFile(`${statePrefix}/output.log`, logContent, "text/plain");
  } catch (err) {
    log("error", `Failed to upload output log: ${err.message}`);
  }

  // 2. Upload .claude directory (conversation history, run state).
  // This is the single source of truth — mirrors what symphony-artifact does
  // in GitHub Actions (zip .claude/runs/ and upload). The run directory
  // (symphonyWorkDir) lives INSIDE .claude/runs/, so this captures everything.
  const claudeDir = path.join(workDir, ".claude");
  if (fs.existsSync(claudeDir)) {
    try {
      await uploadDirectory(claudeDir, `${statePrefix}/claude-state`);
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
      await uploadDirectory(
        absDir,
        `${statePrefix}/home-claude-state/${relDir}`
      );
    } catch (err) {
      log("error", `Failed to upload ~/.claude/${relDir}: ${err.message}`);
    }
  }

  // 3. Upload key artifact files from the run directory.
  // The run directory (.claude/runs/TIMESTAMP/) is the single source of truth —
  // run-loop.sh, amend-plan, and syncPlanFromContextPack all write there.
  // We upload specific files to artifacts/ at flat paths so the backend
  // ingestion pipeline can read them by name (e.g., artifacts/plan.json).
  // The full run directory is already captured in claude-state/ (step 2).
  const KEY_ARTIFACT_FILES = [
    "plan.json",
    "plan.md",
    "implementation-plan.md",
    "open-questions.md",
    "execution-result.json",
    "judges.json",
    "code-judges.json",
    "perf.jsonl",
    "state.json",
  ];
  const artifactDir = runDir || workDir;
  for (const fileName of KEY_ARTIFACT_FILES) {
    const absPath = path.join(artifactDir, fileName);
    if (fs.existsSync(absPath)) {
      try {
        const content = fs.readFileSync(absPath);
        await uploadFile(
          `${statePrefix}/artifacts/${fileName}`,
          content,
          "application/octet-stream"
        );
      } catch (err) {
        log("error", `Failed to upload artifact ${fileName}: ${err.message}`);
      }
    }
  }

  log("info", "State upload complete");
}

/**
 * Upload metadata.json with token usage breakdown and execution info.
 */
async function uploadMetadata(_workDir, output, tokenUsage, startTime) {
  if (!config.s3StateKey) {
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
    await uploadFile(
      `${statePrefix}/metadata.json`,
      JSON.stringify(metadata, null, 2),
      "application/json"
    );
    log("info", "Metadata uploaded");
  } catch (err) {
    log("error", `Failed to upload metadata: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------
function buildRunLoopArgs(runLoopPath, workDir, prdPath) {
  const args = [runLoopPath];

  // Pass workdir as positional argument so run-loop.sh knows where to operate
  args.push(workDir);

  switch (config.command) {
    case "PLAN":
      args.push("--max-iterations", String(config.maxIterations || 50));
      break;
    case "EXECUTE":
      args.push("--max-iterations", String(config.maxIterations || 150));
      break;
    default:
      args.push("--max-iterations", String(config.maxIterations || 50));
      break;
  }

  if (prdPath) {
    args.push("--prd", prdPath);
  }

  return { cmd: "bash", args };
}

function buildClaudeDirectArgs(workDir) {
  const args = [];

  // If resuming from a parent loop, use --resume to continue the session
  if (config.parentSessionId) {
    args.push("--resume", config.parentSessionId);
  }

  switch (config.command) {
    case "REQUEST_CHANGES": {
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
    case "CHAT":
    case "EXPLORE": {
      const contextDir = path.join(workDir, ".claude", "context");
      const promptFile = path.join(contextDir, "prompt.md");
      let prompt = "";
      if (fs.existsSync(promptFile)) {
        prompt = fs.readFileSync(promptFile, "utf-8");
      }
      if (!prompt) {
        throw new Error(`No prompt found for ${config.command} command`);
      }
      args.push(prompt);
      break;
    }
    default:
      throw new Error(
        `Unexpected command for direct claude invocation: ${config.command}`
      );
  }

  return { cmd: "claude", args };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let currentChild = null;
let shuttingDown = false;
// Module-level output buffer so timeout/shutdown paths can access accumulated output
let liveOutputChunks = [];
// Symphony workdir inside the repo (e.g., .claude/runs/YYYYMMDD-HHMMSS-loop-xxx/)
let symphonyWorkDir = null;

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

    // Refresh token before safety commit (may have expired during run)
    await refreshGitHubToken();

    // Attempt safety commit before uploading state (only for code-producing commands)
    const shouldCommitAndPush = config.command === "EXECUTE";
    if (shouldCommitAndPush) {
      attemptSafetyCommit(
        workDir,
        "[INCOMPLETE] WIP: Safety commit — loop cancelled"
      );
    }

    // Try to upload whatever state we have
    try {
      await uploadState(workDir, [], symphonyWorkDir);
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
  return config.command === "EXECUTE";
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
      execFileSync("git", ["fetch", "origin", config.parentBranchName], {
        cwd: workDir,
        stdio: "pipe",
        timeout: 30_000,
        env: buildGitAuthEnv(),
      });
      execFileSync("git", ["checkout", config.parentBranchName], {
        cwd: workDir,
        stdio: "pipe",
        timeout: 5000,
      });
      log("info", `Checked out parent branch: ${config.parentBranchName}`);
      return config.parentBranchName;
    } catch (err) {
      log(
        "error",
        `Failed to checkout parent branch ${config.parentBranchName}: ${err.message}`
      );
      log(
        "warn",
        "Will create fresh branch — parent code changes may be lost. " +
          "Artifact files from S3 will still be restored if available."
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
  const hasPrompt =
    typeof contextPack?.prompt === "string" &&
    contextPack.prompt.trim().length > 0;
  const hasArtifacts =
    Array.isArray(contextPack?.artifacts) && contextPack.artifacts.length > 0;

  if (command === "EXECUTE" && !(hasArtifacts || hasPrompt)) {
    throw new HarnessError(
      ERROR_CODES.preRunValidation,
      "Pre-run validation failed: EXECUTE requires prompt or artifacts in context pack"
    );
  }
  if (command === "REQUEST_CHANGES" && !hasPrompt) {
    throw new HarnessError(
      ERROR_CODES.preRunValidation,
      "Pre-run validation failed: REQUEST_CHANGES requires a non-empty prompt"
    );
  }
}

function buildCommand(workDir, symphonyWD, prdPath) {
  const usesRunLoop = config.command === "PLAN" || config.command === "EXECUTE";

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
    return buildRunLoopArgs(runLoopPath, symphonyWD || workDir, prdPath);
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
      // Capture accumulated output before killing the child — liveOutputChunks
      // is the same array reference as spawnProcess's outputChunks.
      const capturedOutput = [...liveOutputChunks];
      await killChild();
      return {
        result: { code: null, signal: "SIGKILL", output: capturedOutput },
        timedOut: true,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// execution-result.json (consumed by webhook zip-parser + S3 artifact upload)
// ---------------------------------------------------------------------------
/**
 * Get the HEAD commit SHA from the working directory.
 */
function getHeadCommitSha(workDir) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Write execution-result.json to the work directory.
 *
 * This file is expected by the webhook zip-parser (zip-parser.ts) and is
 * listed in the keyFiles array for S3 upload. The schema matches the
 * ExecutionResult type defined in zip-parser.ts.
 *
 * Must be called BEFORE uploadState() so the file is included in the
 * artifacts/ prefix upload.
 */
function writeExecutionResult(workDir, prInfo) {
  try {
    const hasChanges = !!prInfo?.prUrl;
    const commitSha = getHeadCommitSha(workDir);

    const result = {
      has_changes: hasChanges,
      pr_url: prInfo?.prUrl || "",
      pr_number: prInfo?.prNumber || 0,
      branch_name: prInfo?.branchName || "",
      base_ref: config.targetBranch || "main",
      commit_sha: commitSha,
    };

    const filePath = path.join(workDir, "execution-result.json");
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    log("info", `Wrote execution-result.json (has_changes=${hasChanges})`);
  } catch (err) {
    log("error", `Failed to write execution-result.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Report final status (completed, failed, or timed out)
// ---------------------------------------------------------------------------
async function reportFinalStatus(
  workDir,
  output,
  {
    timedOut,
    exitCode,
    signal,
    duration,
    tokenUsage,
    startTime,
    symphonyWorkDir: swDir,
  }
) {
  // Step 0: Refresh GitHub token before safety commit (token may have expired
  // during the 55-minute run window)
  await refreshGitHubToken();

  const shouldCommitAndPush = config.command === "EXECUTE";

  // Step 1: Safety commit + push only for commands that produce code changes
  const isIncomplete = timedOut || exitCode !== 0;
  let commitMsg;
  if (timedOut) {
    commitMsg = "[INCOMPLETE] WIP: Safety commit — loop timed out";
  } else if (exitCode !== 0) {
    commitMsg = "[INCOMPLETE] WIP: Safety commit — process failed";
  } else {
    commitMsg = "Post-run: uncommitted changes from loop execution";
  }

  let prInfo = null;

  if (shouldCommitAndPush) {
    attemptSafetyCommit(workDir, commitMsg);
    ensureBranchPushed(workDir);

    // Step 2: Detect branch info and any PR Claude may have created during execution
    prInfo = parsePrInfo(workDir, output);

    // Step 3: Create PR (harness owns PR creation, not run-loop — mirrors dispatch workflow)
    prInfo = createPullRequest(workDir, prInfo);

    // Step 4: Label incomplete PRs
    if (isIncomplete && prInfo?.prNumber) {
      labelPrIncomplete(workDir, prInfo.prNumber);
    }
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

  // Step 5: Write execution-result.json to the run directory so it's
  // included in the artifacts/ upload to S3.
  if (shouldCommitAndPush) {
    writeExecutionResult(swDir || workDir, prInfo);
  }

  // Step 6: Upload state + metadata
  await uploadState(workDir, output, swDir);
  await uploadMetadata(workDir, output, tokenUsage, startTime);

  // Step 7: Report event
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
// Fatal error handler (extracted to keep main() complexity under limit)
// ---------------------------------------------------------------------------
async function _handleFatalError(err, workDir, output, startTime) {
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

  // Best-effort: refresh token, safety commit, push, create PR, label
  // Mirrors dispatch workflow's `if: always()` pattern — preserve work
  // even on fatal errors.
  try {
    await refreshGitHubToken();
  } catch (_) {
    // ignore
  }
  try {
    attemptSafetyCommit(
      workDir,
      "[INCOMPLETE] WIP: Safety commit — harness error"
    );
    ensureBranchPushed(workDir);
  } catch (_) {
    // ignore — attemptSafetyCommit is already best-effort internally
  }

  let prInfo = null;
  try {
    prInfo = parsePrInfo(workDir, output);
    prInfo = createPullRequest(workDir, prInfo);
    if (prInfo?.prNumber) {
      labelPrIncomplete(workDir, prInfo.prNumber);
    }
  } catch (_) {
    // ignore
  }

  // Best-effort: write execution-result.json before upload
  try {
    writeExecutionResult(workDir, prInfo);
  } catch (_) {
    // ignore
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

  // Best-effort: report failure with PR info
  try {
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
}

// ---------------------------------------------------------------------------
// Main execution helpers (extracted to keep main() complexity under limit)
// ---------------------------------------------------------------------------

function prepareRunDirectory(workDir, contextPack) {
  // Resolve the symphony run directory.
  // There is ONE run directory per chain (PLAN → RC → RC → EXECUTE).
  // - PLAN (fresh): creates a new run dir
  // - Child loops (RC, EXECUTE): reuse the parent's run dir restored by downloadState
  // This mirrors the GitHub Actions flow where symphony-artifact downloads/uploads
  // the same .claude/runs/TIMESTAMP/ directory across all steps.
  const existing = findExistingRunDir(workDir);
  if (existing) {
    log("info", `Reusing parent run directory: ${existing}`);
    const prdPath = writePrdFile(existing, contextPack);
    if (config.s3ParentStateKey) {
      syncPlanFromContextPack(existing, contextPack);
    }
    return { runDir: existing, prdPath };
  }
  const runTs = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const loopSuffix = (config.loopId || randomUUID())
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 50);
  const newDir = path.join(
    workDir,
    ".claude",
    "runs",
    `${runTs}-loop-${loopSuffix}`
  );
  fs.mkdirSync(newDir, { recursive: true });
  log("info", `Created new run directory: ${newDir}`);
  const prdPath = writePrdFile(newDir, contextPack);
  return { runDir: newDir, prdPath };
}

async function handleFatalError(err, workDir, output, startTime) {
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

  // Best-effort: refresh token, safety commit, push, create PR, label
  // Mirrors dispatch workflow's `if: always()` pattern — preserve work
  // even on fatal errors.
  const shouldCommitAndPush = config.command === "EXECUTE";

  try {
    await refreshGitHubToken();
  } catch (_) {
    // ignore
  }

  let prInfo = null;
  if (shouldCommitAndPush) {
    try {
      attemptSafetyCommit(
        workDir,
        "[INCOMPLETE] WIP: Safety commit — harness error"
      );
      ensureBranchPushed(workDir);
    } catch (_) {
      // ignore
    }

    try {
      prInfo = parsePrInfo(workDir, output);
      prInfo = createPullRequest(workDir, prInfo);
      if (prInfo?.prNumber) {
        labelPrIncomplete(workDir, prInfo.prNumber);
      }
    } catch (_) {
      // ignore
    }
  }

  // Best-effort: write execution-result.json before upload
  if (shouldCommitAndPush) {
    try {
      writeExecutionResult(symphonyWorkDir || workDir, prInfo);
    } catch (_) {
      // ignore
    }
  }

  // Best-effort: upload whatever state we have
  try {
    await uploadState(workDir, output, symphonyWorkDir);
  } catch (uploadErr) {
    log(
      "error",
      `Failed to upload state after error: ${redactSensitive(uploadErr.message)}`
    );
  }

  // Best-effort: report failure with PR info
  try {
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

    // Step 2a: Refresh GitHub token (installation tokens expire after 1h;
    // ECS placement + S3 downloads may have consumed most of that window)
    await refreshGitHubToken();

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

    // Step 3b2: Resolve the symphony run directory.
    // There is ONE run directory per chain (PLAN → RC → RC → EXECUTE).
    // - PLAN (fresh): creates a new run dir
    // - Child loops (RC, EXECUTE): reuse the parent's run dir restored by downloadState
    // This mirrors the GitHub Actions flow where symphony-artifact downloads/uploads
    // the same .claude/runs/TIMESTAMP/ directory across all steps.
    symphonyWorkDir = findExistingRunDir(workDir);
    if (symphonyWorkDir) {
      log("info", `Reusing parent run directory: ${symphonyWorkDir}`);
    } else {
      const runTs = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .slice(0, 15);
      const loopSuffix = (config.loopId || randomUUID())
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 50);
      symphonyWorkDir = path.join(
        workDir,
        ".claude",
        "runs",
        `${runTs}-loop-${loopSuffix}`
      );
      fs.mkdirSync(symphonyWorkDir, { recursive: true });
      log("info", `Created new run directory: ${symphonyWorkDir}`);
    }

    // Write PRD to the run directory (all commands that have a prompt)
    const prdPath = writePrdFile(symphonyWorkDir, contextPack);

    // For child loops: write the latest plan content from the context pack to
    // plan.json in the run dir. This picks up manual edits the user made in
    // the Liveblocks editor between runs. The context pack's primary artifact
    // contains the latest artifact version content from the DB.
    if (config.s3ParentStateKey) {
      syncPlanFromContextPack(symphonyWorkDir, contextPack);
    }

    // Step 3c: Command-level validation and branch hardening.
    validatePreRunInputs(config.command, contextPack);
    if (shouldCreateWorkingBranch()) {
      createWorkingBranch(workDir);
    }

    // Step 4: Determine execution mode and build command
    const { cmd, args } = buildCommand(workDir, symphonyWorkDir, prdPath);

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
    const modelNames = tokenUsage.tokensByModel
      ? Object.keys(tokenUsage.tokensByModel).join(", ")
      : "unknown";
    log(
      "info",
      `Token usage: input=${tokenUsage.totalInput}, output=${tokenUsage.totalOutput}, models=${modelNames}`
    );

    // Step 8: Report final status + upload
    await reportFinalStatus(workDir, output, {
      timedOut,
      exitCode,
      signal: result.signal,
      duration,
      tokenUsage,
      startTime,
      symphonyWorkDir,
    });

    // Exit with the child's exit code
    process.exit(exitCode || 0);
  } catch (err) {
    await handleFatalError(err, workDir, output, startTime, symphonyWorkDir);
    process.exit(1);
  }
}

main();
