#!/usr/bin/env node

/**
 * Harness Agent for the Claude Code Runner container.
 *
 * Orchestrates a ClosedLoop.AI loop execution inside the container:
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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LoopArtifactFile,
  LoopArtifactType,
} from "@closedloop-ai/loops-api/artifacts";
import { validateResultBundle } from "@closedloop-ai/loops-api/bundles";
import {
  LoopCommand,
  validateCommandInputs,
} from "@closedloop-ai/loops-api/commands";
import { ContextPackSchema } from "@closedloop-ai/loops-api/context-pack";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { normalizeModelName } from "@closedloop-ai/loops-api/tokens";

// ---------------------------------------------------------------------------
// AWS SDK v3 — lazy-loaded on first use (not needed for unit tests)
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
let _awsSdk = null;

function getAwsSdk() {
  if (!_awsSdk) {
    _awsSdk = require("@aws-sdk/client-s3");
  }
  return _awsSdk;
}

// Proxy classes that lazy-load the SDK on first construction
const S3Client = new Proxy(() => {}, {
  construct(_, args) {
    return new (getAwsSdk().S3Client)(...args);
  },
});
const GetObjectCommand = new Proxy(() => {}, {
  construct(_, args) {
    return new (getAwsSdk().GetObjectCommand)(...args);
  },
});
const PutObjectCommand = new Proxy(() => {}, {
  construct(_, args) {
    return new (getAwsSdk().PutObjectCommand)(...args);
  },
});
const ListObjectsV2Command = new Proxy(() => {}, {
  construct(_, args) {
    return new (getAwsSdk().ListObjectsV2Command)(...args);
  },
});

const WORKSPACE_STATE_DIR = ".closedloop-ai";
const WORKSPACE_RUNS_SUBDIR = "runs";
const WORKSPACE_STATE_PREFIX = "closedloop-state";
const LEGACY_WORKSPACE_STATE_PREFIX = "claude-state";
const HOME_STATE_PREFIX = "home-claude-state";

function getWorkspaceStateDir(workDir) {
  return path.join(workDir, WORKSPACE_STATE_DIR);
}

function getWorkspaceRunsDir(workDir) {
  return path.join(workDir, WORKSPACE_STATE_DIR, WORKSPACE_RUNS_SUBDIR);
}

function getWorkspaceStateRestorePrefixes(parentPrefix) {
  return [
    `${parentPrefix}/${WORKSPACE_STATE_PREFIX}`,
    `${parentPrefix}/${LEGACY_WORKSPACE_STATE_PREFIX}`,
  ];
}

function getWorkspaceStateUploadPrefixes(statePrefix) {
  return [
    `${statePrefix}/${WORKSPACE_STATE_PREFIX}`,
    `${statePrefix}/${LEGACY_WORKSPACE_STATE_PREFIX}`,
  ];
}

function getHomeStateTransferPrefix(prefix) {
  return `${prefix}/${HOME_STATE_PREFIX}`;
}

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
  command: process.env.COMMAND?.toUpperCase(), // LoopCommand values from @closedloop-ai/loops-api
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
  // Parent state for resume: used to download prior run workspace/session state
  s3ParentStateKey: process.env.S3_PARENT_STATE_KEY || null,
  parentSessionId: process.env.PARENT_SESSION_ID || null,
  parentBranchName: process.env.PARENT_BRANCH_NAME || null,
};

// Local aliases for shared error codes (preserves existing property names)
const ERROR_CODES = {
  runner: LoopErrorCode.RunnerError,
  config: LoopErrorCode.ConfigValidationFailed,
  secrets: LoopErrorCode.SecretsValidationFailed,
  contextPackDownload: LoopErrorCode.ContextPackDownloadFailed,
  contextPackInvalid: LoopErrorCode.ContextPackInvalid,
  contextPackWrite: LoopErrorCode.ContextPackWriteFailed,
  gitClone: LoopErrorCode.GitCloneFailed,
  branchCreate: LoopErrorCode.BranchCreateFailed,
  preRunValidation: LoopErrorCode.PreRunValidationFailed,
  runLoopNotFound: LoopErrorCode.RunLoopNotFound,
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

// Module-level set of secrets to redact from all log output.
// Populated by registerSecret() as secrets become available.
const _redactSet = new Set();

/**
 * Register a secret value to be redacted from all future log output.
 * Must be called whenever a new secret is obtained (e.g., from context pack).
 * No-op for empty / non-string values.
 */
function registerSecret(secret) {
  if (typeof secret === "string" && secret.length > 0) {
    _redactSet.add(secret);
  }
}

function redactSensitive(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  let redacted = value;
  for (const secret of _redactSet) {
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
  // Register the auth token early so it is redacted from all subsequent log output.
  registerSecret(config.authToken);

  // Validate required environment variables (available before context pack download).
  // Secrets (anthropicApiKey, githubToken) are delivered via S3 context pack,
  // so they are validated separately after download.
  const requiredEnv = ["loopId", "command", "authToken", "apiBaseUrl"];

  // targetRepo is only required for commands that operate on a repository.
  // chat/explore can run prompt-only without a repo.
  const repoCommands = new Set([
    LoopCommand.Plan,
    LoopCommand.Execute,
    LoopCommand.RequestChanges,
    LoopCommand.GeneratePrd,
    LoopCommand.EvaluatePlan,
    LoopCommand.EvaluateCode,
  ]);
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
  // EVALUATE_PRD with a targetRepo also needs a GitHub token to fetch repo context.
  // EVALUATE_PLAN and EVALUATE_CODE always need a GitHub token (unconditional).
  const repoCommands = new Set([
    LoopCommand.Plan,
    LoopCommand.Execute,
    LoopCommand.RequestChanges,
    LoopCommand.GeneratePrd,
    LoopCommand.EvaluatePlan,
    LoopCommand.EvaluateCode,
  ]);
  if (
    repoCommands.has(config.command) ||
    (config.command === LoopCommand.EvaluatePrd && config.targetRepo)
  ) {
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
 *   - {parentPrefix}/closedloop-state/  → {workDir}/.closedloop-ai/ (run state, conversations, workspace)
 *     (fallback for older runs: {parentPrefix}/claude-state/)
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

  // 1. Restore workDir/.closedloop-ai from parent state (new prefix first,
  // then legacy fallback for old runs that only uploaded claude-state).
  const workspaceStateDir = getWorkspaceStateDir(workDir);
  let workspaceStateRestored = false;
  const workspaceStatePrefixes = getWorkspaceStateRestorePrefixes(parentPrefix);
  for (const statePrefix of workspaceStatePrefixes) {
    try {
      const count = await downloadDirectoryFromS3(
        statePrefix,
        workspaceStateDir
      );
      if (count > 0) {
        workspaceStateRestored = true;
        log("info", `Restored ${count} files to ${workspaceStateDir}`);
        break;
      }
    } catch (err) {
      log(
        "error",
        `Failed to download ${statePrefix} (best-effort): ${err.message}`
      );
    }
  }
  if (!workspaceStateRestored) {
    log(
      "info",
      `No workspace state found at ${workspaceStatePrefixes.join(" or ")}`
    );
  }

  // 2. Restore ~/.claude/{projects,sessions} from parent's home-claude-state
  try {
    const homeClaudePrefix = getHomeStateTransferPrefix(parentPrefix);
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
  // plan.json, plan.md, etc.) is already restored as part of workspace state
  // above (at .closedloop-ai/runs/TIMESTAMP/). findExistingRunDir() locates it,
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
async function refreshGitHubToken(contextPack) {
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
      registerSecret(config.githubToken);
      log("info", "Refreshed GitHub token from API");
    }

    // Patch peer-repo tokens in the contextPack
    if (
      Array.isArray(body.data?.additionalRepoTokens) &&
      contextPack?.additionalRepos
    ) {
      for (const refreshed of body.data.additionalRepoTokens) {
        const entry = contextPack.additionalRepos.find(
          (r) => r.fullName === refreshed.fullName
        );
        if (entry) {
          entry.githubToken = refreshed.token;
          registerSecret(refreshed.token);
        }
      }
      log(
        "info",
        `Refreshed ${body.data.additionalRepoTokens.length} peer-repo token(s)`
      );
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

  // Validate context pack against shared schema
  const validation = ContextPackSchema.safeParse(pack);
  if (!validation.success) {
    log(
      "warn",
      "Context pack schema validation failed:",
      validation.error.issues
    );
  }

  // Extract secrets from context pack before writing anything to disk.
  // Secrets must never be persisted to the filesystem.
  if (pack.secrets) {
    if (pack.secrets.anthropicApiKey) {
      config.anthropicApiKey = pack.secrets.anthropicApiKey;
      registerSecret(config.anthropicApiKey);
    }
    if (pack.secrets.githubToken) {
      config.githubToken = pack.secrets.githubToken;
      registerSecret(config.githubToken);
    }
    log("info", "Extracted secrets from context pack");
  }

  // Extract committer identity for git attribution (not a secret — safe to log).
  if (pack.committer) {
    config.committerName = pack.committer.name || null;
    config.committerEmail = pack.committer.email || null;
    log(
      "info",
      `Committer: ${config.committerName} <${config.committerEmail}>`
    );
  }

  return pack;
}

async function writeContextPackFiles(workDir, pack) {
  if (!pack) {
    return;
  }
  try {
    const contextDir = path.join(workDir, ".closedloop-ai", "context");
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

    // Download attachments into .closedloop-ai/work/attachments/
    if (Array.isArray(pack.attachments) && pack.attachments.length > 0) {
      const attachmentsDir = path.join(
        workDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      fs.mkdirSync(attachmentsDir, { recursive: true });

      for (const attachment of pack.attachments) {
        try {
          // (1) Check expiry
          const expiresAt = new Date(attachment.signedUrlExpiresAt);
          if (expiresAt <= new Date()) {
            log(
              "warn",
              `Attachment ${attachment.id} signed URL expired at ${attachment.signedUrlExpiresAt}, skipping`
            );
            continue;
          }

          // (2) Sanitize filename
          const basename = path.basename(attachment.filename);
          const safeName = basename.replace(/[^a-zA-Z0-9._-]/g, "_");
          const diskName = `${attachment.id}-${safeName}`;

          // (3) Compute disk path and assert no path traversal
          const diskPath = path.join(attachmentsDir, diskName);
          if (
            !path.resolve(diskPath).startsWith(path.resolve(attachmentsDir))
          ) {
            log(
              "warn",
              `Attachment ${attachment.id} resolved path escapes attachments dir, skipping`
            );
            continue;
          }

          // (4) Download
          const response = await fetch(attachment.signedUrl);
          if (!response.ok) {
            log(
              "warn",
              `Attachment ${attachment.id} download failed: HTTP ${response.status}, skipping`
            );
            continue;
          }
          const buffer = Buffer.from(await response.arrayBuffer());

          // (5) Validate size
          if (buffer.length > attachment.sizeBytes) {
            log(
              "warn",
              `Attachment ${attachment.id} buffer size ${buffer.length} exceeds declared sizeBytes ${attachment.sizeBytes}, skipping`
            );
            continue;
          }
          if (buffer.length < attachment.sizeBytes) {
            log(
              "warn",
              `Attachment ${attachment.id} downloaded ${buffer.length} bytes but expected ${attachment.sizeBytes}, may be truncated — writing anyway`
            );
          }

          // (6) Write to disk
          fs.writeFileSync(diskPath, buffer);
          filesWritten++;
        } catch (attachErr) {
          log(
            "warn",
            `Failed to download attachment ${attachment.id}: ${attachErr.message}`
          );
        }
      }
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
 * downloadState() restores .closedloop-ai/ from the parent, which includes
 * .closedloop-ai/runs/TIMESTAMP/. We find that directory so child loops
 * (REQUEST_CHANGES, EXECUTE) operate on the same workspace as the parent.
 *
 * Returns the path to the most recent run directory, or null if none exists
 * (indicating this is a fresh PLAN with no parent).
 */
function findExistingRunDir(workDir) {
  const runsDir = getWorkspaceRunsDir(workDir);
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
 * 3. First FEATURE artifact — issue description used as plan input
 *
 * Without this, PLAN commands get no --prd flag and produce empty plans.
 */
function writePrdFile(targetDir, contextPack) {
  let prdContent = contextPack?.prompt ?? null;

  // Fall back to the first PRD-type artifact, then FEATURE-type
  if (!prdContent && Array.isArray(contextPack?.artifacts)) {
    const prdArtifact = contextPack.artifacts.find(
      (a) => a.type === LoopArtifactType.Prd
    );
    const featureArtifact = prdArtifact
      ? null
      : contextPack.artifacts.find((a) => a.type === LoopArtifactType.Feature);
    const source = prdArtifact || featureArtifact;

    if (source?.content) {
      prdContent = source.content;
      log(
        "info",
        `Using ${source.type} artifact (${source.id}) as prd.md content`
      );
    }
  }

  if (!prdContent) {
    return null;
  }
  const prdPath = path.join(targetDir, LoopArtifactFile.Prd);
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
 * The context pack's primary artifact (found by type, not index) contains
 * the latest artifact version content from the platform.
 */
function syncPlanFromContextPack(runDir, contextPack) {
  if (!contextPack?.artifacts?.length) {
    return;
  }

  // Find the plan artifact by type — ref artifacts (PRD/Issue) may precede
  // the primary artifact in the array, so index 0 is not reliable.
  const primaryArtifact =
    contextPack.artifacts.find(
      (a) => a.type === LoopArtifactType.ImplementationPlan
    ) ??
    contextPack.artifacts.find(
      (a) => ![LoopArtifactType.Prd, LoopArtifactType.Feature].includes(a.type)
    );
  if (!primaryArtifact?.content) {
    return;
  }

  const planJsonPath = path.join(runDir, LoopArtifactFile.Plan);

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
function buildGitAuthEnv(token) {
  const resolvedToken = token ?? config.githubToken;
  // Fail-closed: if no token is available, return empty env (no auth)
  if (!resolvedToken) {
    return {};
  }
  const authHeader = Buffer.from(
    `x-access-token:${resolvedToken}`,
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
  const gitName = config.committerName || "ClosedLoop.AI Agent";
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
// Additional peer repository cloning
// ---------------------------------------------------------------------------
function cloneAdditionalRepos(entries, peersDir = "/workspace/peers") {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  // Validate all entries before performing any filesystem or network operations
  // so callers get a clear config error without side effects on invalid input.
  for (const entry of entries) {
    if (!RE_SAFE_REPO.test(entry.fullName)) {
      throw new HarnessError(
        ERROR_CODES.config,
        redactSensitive(
          `Invalid peer repo fullName: "${entry.fullName}" — must be "owner/repo" (alphanumeric, dots, hyphens, underscores)`
        )
      );
    }
    if (!RE_SAFE_BRANCH.test(entry.branch)) {
      throw new HarnessError(
        ERROR_CODES.config,
        redactSensitive(
          `Invalid peer repo branch: "${entry.branch}" for repo "${entry.fullName}" — must be alphanumeric with /, _, ., - (max 200 chars)`
        )
      );
    }
  }

  fs.mkdirSync(peersDir, { recursive: true });

  const clonedDirs = [];

  for (const entry of entries) {
    const cloneDirName = entry.fullName.replaceAll("/", "--");
    const cloneTarget = path.join(peersDir, cloneDirName);
    const cloneUrl = `https://github.com/${entry.fullName}.git`;

    log(
      "info",
      `Cloning peer repo ${entry.fullName} (branch: ${entry.branch}) into ${cloneTarget}`
    );

    try {
      execFileSync(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          entry.branch,
          cloneUrl,
          cloneTarget,
        ],
        {
          stdio: "pipe",
          env: buildGitAuthEnv(entry.githubToken),
        }
      );
    } catch (err) {
      throw new HarnessError(
        ERROR_CODES.gitClone,
        redactSensitive(
          `Failed to clone peer repository ${entry.fullName}@${entry.branch}: ${err.message}`
        ),
        err
      );
    }

    log("info", `Peer repo ${entry.fullName} cloned successfully`);
    clonedDirs.push(cloneTarget);
  }

  return clonedDirs;
}

// ---------------------------------------------------------------------------
// Safety commit (best-effort fallback — uses --no-verify to guarantee success)
// ---------------------------------------------------------------------------
function attemptSafetyCommit(
  workDir,
  commitMessage = "[INCOMPLETE] WIP: Safety commit — loop interrupted"
) {
  if (!(config.targetRepo && config.githubToken)) {
    return;
  }
  try {
    // Stage everything except .claude and .closedloop-ai directories
    execFileSync("git", ["add", "--", ".", ":!.claude", ":!.closedloop-ai"], {
      cwd: workDir,
      stdio: "pipe",
    });

    // Check if there are staged changes (exit 1 = changes exist)
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], {
        cwd: workDir,
        stdio: "pipe",
      });
      // Exit 0 means no changes — nothing to commit
      log("info", "Safety commit: no uncommitted changes");
      return;
    } catch {
      // Exit non-zero means there are staged changes — proceed
    }

    // --no-verify: bypass pre-commit hooks — this is a safety net, not a
    // development commit. Hooks (lint, test, etc.) can fail on partial work
    // and would prevent us from preserving the code changes.
    execFileSync("git", ["commit", "--no-verify", "-m", commitMessage], {
      cwd: workDir,
      stdio: "pipe",
    });

    const currentBranch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd: workDir,
        stdio: "pipe",
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

    // --no-verify: bypass pre-push hooks for the same reason as above.
    execFileSync("git", ["push", "--no-verify", "origin", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
      env: buildGitAuthEnv(),
    });

    log("info", "Safety commit pushed successfully");
  } catch (err) {
    log("error", `Safety commit failed (best-effort): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// LLM-assisted commit (standalone Claude call for quality commits + PR)
// ---------------------------------------------------------------------------
/**
 * Spawn a standalone Claude CLI call to review changes, create a proper
 * commit, push, and open a PR. This produces much better commit messages
 * and PR descriptions than the mechanical safety commit.
 *
 * Returns PR info if Claude created a PR, or null otherwise.
 * Best-effort — failures fall through to attemptSafetyCommit.
 */
function attemptLlmCommit(workDir, resultFilePath) {
  if (!(config.targetRepo && config.githubToken && config.anthropicApiKey)) {
    return null;
  }

  const branchName = detectBranchName(workDir);
  if (!branchName) {
    log("info", "LLM commit: on target branch, skipping");
    return null;
  }

  // Quick check: are there any uncommitted changes?
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
    });
    // No tracked changes — also check for untracked files
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--exclude", ".claude"],
      { cwd: workDir, stdio: "pipe" }
    )
      .toString()
      .trim();
    if (!untracked) {
      log("info", "LLM commit: no uncommitted changes");
      return null;
    }
  } catch {
    // git diff --quiet exits non-zero when there ARE changes — proceed
  }

  const prompt = [
    `You are a commit assistant finalizing work from a ClosedLoop.AI ${config.command} loop.`,
    "",
    "Review all uncommitted changes in this repository and create a proper commit, push it, and create a pull request.",
    "",
    "STEPS:",
    "1. Run `git status` and `git diff --stat` to understand what changed",
    "2. Stage all changed/new files EXCEPT the .claude/ and .closedloop-ai/ directories:",
    "   git add -- . ':!.claude' ':!.closedloop-ai'",
    "3. Write a clear, descriptive commit message based on the actual code changes",
    "   - Summarize WHAT changed and WHY (not just 'ClosedLoop.AI loop output')",
    "   - Use conventional commit style if the changes have a clear category",
    "4. Run `git commit` (do NOT use --no-verify). If pre-commit hooks fail, attempt to fix",
    "   the issue (e.g., run the linter/formatter if the error message tells you how).",
    "   If you cannot quickly fix it, the commit fails — do not bypass hooks.",
    "5. Push to origin with: git push -u origin HEAD",
    `6. Check if a PR already exists for this branch: gh pr list --head ${branchName}`,
    "   - If NO PR exists:",
    "     a. Check if the repo has a PR template at .github/pull_request_template.md",
    "        If a template exists, use it as the base for the PR body — fill in every section appropriately.",
    "        If no template exists, write a summary of what changed and why.",
    "     b. Append the following metadata footer on its own lines at the end:",
    "        ---",
    `        Loop ID: ${config.loopId}`,
    `        Command: ${config.command}`,
    "     c. Write the complete PR body to pr-body.md",
    `     d. Create the PR: gh pr create --label symphony --base ${config.targetBranch} --title '<descriptive title>' --body-file pr-body.md`,
    "   - If a PR already exists, get its URL with: gh pr view --json url,number",
    "     Fetch the current body: gh pr view <number> --json body --jq .body",
    "     If any required template sections are missing, append them.",
    "     Write the full updated body to pr-body.md and run: gh pr edit <number> --body-file pr-body.md",
    "7. ONLY after a successful commit AND push, write this EXACT JSON file:",
    `   File path: ${resultFilePath}`,
    "   ```json",
    "   {",
    '     "has_changes": true,',
    '     "pr_url": "<full GitHub PR URL or empty string if no PR>",',
    '     "pr_number": <PR number as integer, or 0 if no PR>,',
    `     "branch_name": "${branchName}",`,
    `     "base_ref": "${config.targetBranch}",`,
    '     "commit_sha": "<output of git rev-parse HEAD>"',
    "   }",
    "   ```",
    "   Run `git rev-parse HEAD` to get the commit SHA.",
    "",
    "RULES:",
    "- NEVER stage or commit the .claude/ or .closedloop-ai/ directories",
    "- Do NOT use --no-verify on git commit",
    "- Do NOT modify any source code except to fix pre-commit hook failures (formatting, lint)",
    "- Do NOT write execution-result.json unless you successfully committed AND pushed",
    "- Keep it quick — commit, push, PR, write result file, done",
  ].join("\n");

  // Build env: git auth + API key + gh token
  const llmEnv = {
    ...buildGitAuthEnv(),
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    GH_TOKEN: config.githubToken,
    LANG: process.env.LANG || "C.UTF-8",
  };

  try {
    log("info", "Attempting LLM-assisted commit...");
    const result = spawnSync(
      "claude",
      [
        "-p",
        "--allowedTools",
        "Bash,Read,Write,Glob,Grep",
        "--max-turns",
        "50",
        prompt,
      ],
      {
        cwd: workDir,
        env: llmEnv,
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
    );

    const stdout = result.stdout?.toString() || "";
    const stderr = result.stderr?.toString() || "";

    if (result.status !== 0) {
      log(
        "error",
        `LLM commit exited with code ${result.status} (best-effort, falling through to safety commit)`
      );
    } else {
      log("info", "LLM commit completed successfully");
    }

    // Log tail of output for debugging
    if (stdout) {
      const tail = stdout.slice(-2000);
      log("info", `LLM commit stdout (tail): ${redactSensitive(tail)}`);
    }
    if (stderr) {
      const tail = stderr.slice(-1000);
      log("info", `LLM commit stderr (tail): ${redactSensitive(tail)}`);
    }

    // Read execution-result.json written by the LLM (preferred over stdout parsing)
    if (fs.existsSync(resultFilePath)) {
      try {
        const resultData = JSON.parse(fs.readFileSync(resultFilePath, "utf-8"));
        log(
          "info",
          `LLM wrote execution-result.json (has_changes=${resultData.has_changes}, pr_url=${resultData.pr_url})`
        );
        return {
          prUrl: resultData.pr_url || null,
          prNumber: resultData.pr_number || null,
          branchName: resultData.branch_name || branchName,
          commitSha: resultData.commit_sha || null,
        };
      } catch (parseErr) {
        log(
          "error",
          `Failed to parse LLM execution-result.json: ${parseErr.message}`
        );
      }
    }

    // Fallback: detect PR URL from output (if LLM didn't write the file)
    const combined = stdout + stderr;
    const prMatch = combined.match(RE_GITHUB_PR_URL);
    if (prMatch) {
      const prNumberMatch = PR_NUMBER_REGEX.exec(prMatch[0]);
      log("info", `LLM commit created PR: ${prMatch[0]}`);
      return {
        prUrl: prMatch[0],
        prNumber: prNumberMatch ? Number.parseInt(prNumberMatch[1], 10) : null,
        branchName,
        commitSha: null,
      };
    }

    return null;
  } catch (err) {
    log(
      "error",
      `LLM commit failed (best-effort): ${redactSensitive(err.message)}`
    );
    return null;
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
    // --no-verify: bypass pre-push hooks in CI (same rationale as safety commit)
    execFileSync("git", ["push", "--no-verify", "origin", "HEAD"], {
      cwd: workDir,
      stdio: "pipe",
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
      { cwd: workDir, stdio: "pipe" }
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
    const title = `ClosedLoop.AI: ${config.command} — loop ${config.loopId}`;

    // Use the repo's PR template if one exists, otherwise fall back to a
    // simple metadata body. This ensures automated PRs satisfy any CI checks
    // that validate template sections (e.g., Feature Flags attestation).
    let body;
    const templatePath = path.join(
      workDir,
      ".github",
      "pull_request_template.md"
    );
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, "utf-8");
      body = [
        "Automated PR created by ClosedLoop.AI loop runner.",
        "",
        `**Loop:** \`${config.loopId}\``,
        `**Command:** \`${config.command}\``,
        "",
        template,
      ].join("\n");
    } else {
      body = [
        "Automated PR created by ClosedLoop.AI loop runner.",
        "",
        `**Loop:** \`${config.loopId}\``,
        `**Command:** \`${config.command}\``,
      ].join("\n");
    }

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

/**
 * Extract session ID from a single output line.
 * Handles both JSONL stream-json format (init record with session_id field)
 * and human-readable format ("Session: <uuid>").
 * Returns the session ID string or null.
 */
function extractSessionId(line) {
  // Try JSONL init record first (from --output-format stream-json)
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line);
      if (
        parsed.type === "system" &&
        parsed.subtype === "init" &&
        typeof parsed.session_id === "string"
      ) {
        return parsed.session_id;
      }
    } catch {
      // Not valid JSON, fall through to regex
    }
  }
  // Fallback: regex match for human-readable output
  const match = RE_SESSION_ID.exec(line);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Run-loop discovery
// ---------------------------------------------------------------------------
function findRunLoop() {
  const pluginCachePath = path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "code"
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
      "closedloop-ai",
      "plugins",
      "code",
      "scripts",
      "run-loop.sh"
    ),
    path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "marketplaces",
      "closedloop-ai",
      "plugins",
      "code",
      "run-loop.sh"
    ),
    path.join(
      os.homedir(),
      ".claude",
      "plugins",
      "closedloop-ai",
      "code",
      "run-loop.sh"
    ),
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/plugins/closedloop-ai/code/run-loop.sh",
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

      // Capture session ID from output (first match wins).
      // With --output-format stream-json, the init record contains session_id.
      // With human-readable output, the "Session: <uuid>" line is matched by regex.
      if (!capturedSessionId) {
        capturedSessionId = extractSessionId(line);
        if (capturedSessionId) {
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
 * Ensure a model entry exists in tokensByModel and return it.
 */
function getOrCreateModelEntry(tokensByModel, model) {
  if (!tokensByModel[model]) {
    tokensByModel[model] = { input: 0, output: 0 };
  }
  return tokensByModel[model];
}

/**
 * Accumulate token counts into a model entry, including cache tokens.
 */
function accumulateModelTokens(
  tokensByModel,
  model,
  inputTk,
  outputTk,
  cacheCreationTk,
  cacheReadTk
) {
  const entry = getOrCreateModelEntry(tokensByModel, model);
  entry.input += inputTk;
  entry.output += outputTk;
  if (cacheCreationTk > 0) {
    entry.cacheCreation = (entry.cacheCreation || 0) + cacheCreationTk;
  }
  if (cacheReadTk > 0) {
    entry.cacheRead = (entry.cacheRead || 0) + cacheReadTk;
  }
}

/**
 * Try to parse a single JSONL line as an assistant message with usage data.
 * Returns { model, inputTk, outputTk, cacheCreationTk, cacheReadTk } or null.
 */
function parseJsonlAssistantUsage(line) {
  if (!line.startsWith("{")) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed.type !== "assistant") {
    return null;
  }
  const message = parsed.message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const usage = message.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const model =
    typeof message.model === "string" && message.model.length > 0
      ? normalizeModelName(message.model)
      : null;
  return {
    model,
    inputTk: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTk: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cacheCreationTk:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    cacheReadTk:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
  };
}

/**
 * Parse token usage from Claude CLI JSONL stream output.
 *
 * When Claude is invoked with `--output-format stream-json`, each stdout line
 * is a JSON record. Records with `type === "assistant"` contain a `message`
 * field with `model` and `usage` (input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens).
 *
 * This mirrors the desktop harness (closedloop-electron/src/main/token-usage.ts).
 */
function parseTokenUsageFromJsonl(outputLines) {
  const tokensByModel = {};
  let totalInput = 0;
  let totalOutput = 0;

  for (const entry of outputLines) {
    const usage = parseJsonlAssistantUsage(entry.line || "");
    if (!usage) {
      continue;
    }
    totalInput += usage.inputTk;
    totalOutput += usage.outputTk;
    if (usage.model) {
      accumulateModelTokens(
        tokensByModel,
        usage.model,
        usage.inputTk,
        usage.outputTk,
        usage.cacheCreationTk,
        usage.cacheReadTk
      );
    }
  }

  if (totalInput === 0 && totalOutput === 0) {
    return null;
  }
  const hasModelData = Object.keys(tokensByModel).length > 0;
  return {
    tokensByModel: hasModelData ? tokensByModel : null,
    totalInput,
    totalOutput,
  };
}

/**
 * Parse token usage from Claude CLI human-readable output (regex fallback).
 *
 * Used for commands routed through run-loop.sh (PLAN, EXECUTE) where the
 * harness does not control Claude's output format. Claude prints summary
 * lines like:
 *   Model: claude-opus-4-6  Input: 12345  Output: 6789  Cache creation: 100
 *   Total input tokens: 17345
 */
const RE_MODEL_USAGE =
  /Model:\s*([\w.-]+)\s+Input:\s*([\d,]+)\s+Output:\s*([\d,]+)/i;
const RE_CACHE_CREATION = /Cache creation:\s*([\d,]+)/i;
const RE_CACHE_READ = /Cache read:\s*([\d,]+)/i;
const RE_TOTAL_INPUT = /Total input tokens:\s*([\d,]+)/i;
const RE_TOTAL_OUTPUT = /Total output tokens:\s*([\d,]+)/i;

function parseTokenUsageFromRegex(outputLines) {
  const tokensByModel = {};
  let totalInput = 0;
  let totalOutput = 0;

  for (const entry of outputLines) {
    const line = entry.line || "";

    const modelMatch = RE_MODEL_USAGE.exec(line);
    if (modelMatch) {
      const modelName = normalizeModelName(modelMatch[1]);
      const input = Number.parseInt(modelMatch[2].replaceAll(",", ""), 10);
      const output = Number.parseInt(modelMatch[3].replaceAll(",", ""), 10);
      const cacheCreateMatch = RE_CACHE_CREATION.exec(line);
      const cacheReadMatch = RE_CACHE_READ.exec(line);
      accumulateModelTokens(
        tokensByModel,
        modelName,
        input,
        output,
        cacheCreateMatch
          ? Number.parseInt(cacheCreateMatch[1].replaceAll(",", ""), 10)
          : 0,
        cacheReadMatch
          ? Number.parseInt(cacheReadMatch[1].replaceAll(",", ""), 10)
          : 0
      );
    }

    const totalInputMatch = RE_TOTAL_INPUT.exec(line);
    if (totalInputMatch) {
      totalInput = Number.parseInt(totalInputMatch[1].replaceAll(",", ""), 10);
    }
    const totalOutputMatch = RE_TOTAL_OUTPUT.exec(line);
    if (totalOutputMatch) {
      totalOutput = Number.parseInt(
        totalOutputMatch[1].replaceAll(",", ""),
        10
      );
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
 * Parse token usage from a claude-output.jsonl file on disk.
 *
 * run-loop.sh pipes Claude's stream-json output through a formatter, so the
 * harness's captured stdout contains formatted text, not raw JSONL. But
 * run-loop.sh also tees the JSONL to ${CLOSEDLOOP_WORKDIR}/claude-output.jsonl.
 * This function reads that file and delegates to parseTokenUsageFromJsonl.
 *
 * Returns null if the file doesn't exist or contains no assistant records.
 */
function parseTokenUsageFromJsonlFile(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    const lines = content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => ({ line }));
    return parseTokenUsageFromJsonl(lines);
  } catch (err) {
    log("error", `Failed to parse JSONL file ${jsonlPath}: ${err.message}`);
    return null;
  }
}

/**
 * Parse token usage from captured output lines.
 *
 * Strategy order:
 * 1. JSONL from stdout (commands using --output-format stream-json directly)
 * 2. JSONL from disk (run-loop.sh tees to claude-output.jsonl)
 * 3. Regex from stdout (legacy fallback for human-readable summary lines)
 */
function parseTokenUsage(outputLines) {
  // 1. Try JSONL from captured stdout
  const jsonlResult = parseTokenUsageFromJsonl(outputLines);
  if (jsonlResult) {
    return jsonlResult;
  }

  // 2. Try JSONL file written by run-loop.sh
  if (symphonyWorkDir) {
    const jsonlPath = path.join(symphonyWorkDir, "claude-output.jsonl");
    const fileResult = parseTokenUsageFromJsonlFile(jsonlPath);
    if (fileResult) {
      return fileResult;
    }
  }

  // 3. Fall back to regex parsing of human-readable output
  return parseTokenUsageFromRegex(outputLines);
}

// normalizeModelName imported from shared package (see imports at top)

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

  // 2. Upload workspace state directory (conversation history + run state).
  // The run directory (symphonyWorkDir) lives inside .closedloop-ai/runs/.
  const workspaceStateDir = getWorkspaceStateDir(workDir);
  if (fs.existsSync(workspaceStateDir)) {
    try {
      for (const workspaceStatePrefix of getWorkspaceStateUploadPrefixes(
        statePrefix
      )) {
        await uploadDirectory(workspaceStateDir, workspaceStatePrefix);
      }
    } catch (err) {
      log("error", `Failed to upload workspace state: ${err.message}`);
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
        `${getHomeStateTransferPrefix(statePrefix)}/${relDir}`
      );
    } catch (err) {
      log("error", `Failed to upload ~/.claude/${relDir}: ${err.message}`);
    }
  }

  // 3. Upload key artifact files from the run directory.
  // The run directory (.closedloop-ai/runs/TIMESTAMP/) is the single source of truth —
  // run-loop.sh, amend-plan, and syncPlanFromContextPack all write there.
  // We upload specific files to artifacts/ at flat paths so the backend
  // ingestion pipeline can read them by name (e.g., artifacts/plan.json).
  // The full run directory is already captured in workspace state (step 2).
  const pluginArtifactDir = runDir ?? workDir;
  const CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES = [
    LoopArtifactFile.Plan,
    LoopArtifactFile.PlanMarkdown,
    LoopArtifactFile.ImplementationPlanMarkdown,
    LoopArtifactFile.OpenQuestions,
    LoopArtifactFile.ExecutionResult,
    LoopArtifactFile.Judges,
    LoopArtifactFile.PrdJudges,
    LoopArtifactFile.PlanJudges,
    LoopArtifactFile.CodeJudges,
    LoopArtifactFile.Perf,
    LoopArtifactFile.State,
  ];
  const NON_PLUGIN_ARTIFACT_FILE_NAMES = [
    LoopArtifactFile.Features,
    LoopArtifactFile.Prd,
  ];
  const artifactFiles = CLAUDE_PLUGIN_ARTIFACT_FILE_NAMES.map((fileName) => ({
    name: fileName,
    path: path.join(pluginArtifactDir, fileName),
  })).concat(
    NON_PLUGIN_ARTIFACT_FILE_NAMES.map((fileName) => ({
      name: fileName,
      path: path.join(workDir, fileName),
    }))
  );
  for (const file of artifactFiles) {
    if (fs.existsSync(file.path)) {
      log("info", `Uploading artifact ${file.name} from ${file.path}`);

      try {
        const content = fs.readFileSync(file.path);
        await uploadFile(
          `${statePrefix}/artifacts/${file.name}`,
          content,
          "application/octet-stream"
        );
      } catch (err) {
        log("error", `Failed to upload artifact ${file.name}: ${err.message}`);
      }
    } else {
      log("info", `Artifact ${file.name} not found at ${file.path}`);
    }
  }

  // Validate result bundle — warn if required artifacts are missing for this command
  const uploadedFileNames = artifactFiles
    .filter((f) => fs.existsSync(f.path))
    .map((f) => f.name);
  const missingRequired = validateResultBundle(
    config.command,
    uploadedFileNames
  );
  if (missingRequired.length > 0) {
    log(
      "warn",
      `Missing required artifacts for ${config.command}: ${missingRequired.join(", ")}`
    );
  }

  // 4. Upload agent/judge prompt snapshots as markdown files.
  // Keep this directory structure under artifacts/ so API ingestion can
  // discover prompts from artifacts/agents-snapshot/*.md.
  const agentsSnapshotDir = path.join(pluginArtifactDir, "agents-snapshot");
  if (fs.existsSync(agentsSnapshotDir)) {
    try {
      await uploadDirectory(
        agentsSnapshotDir,
        `${statePrefix}/artifacts/agents-snapshot`
      );
    } catch (err) {
      log(
        "error",
        `Failed to upload agents-snapshot directory: ${err.message}`
      );
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
/**
 * @param {string} runLoopPath
 * @param {string} workDir
 * @param {string|null|undefined} prdPath
 * @param {string[]} [additionalRepoPaths]
 */
function buildRunLoopArgs(runLoopPath, workDir, prdPath, additionalRepoPaths) {
  const args = [runLoopPath];

  // Pass workdir as positional argument so run-loop.sh knows where to operate
  args.push(workDir);

  switch (config.command) {
    case LoopCommand.Plan:
      args.push("--max-iterations", String(config.maxIterations || 50));
      // Append --add-dir for each additional repo path (PLAN only)
      if (Array.isArray(additionalRepoPaths)) {
        for (const repoPath of additionalRepoPaths) {
          args.push("--add-dir", repoPath);
        }
      }
      break;
    case LoopCommand.Execute:
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

function buildClaudeDirectArgs(workDir, symphonyWD) {
  const args = [];

  // -p: print mode (non-interactive, required for --output-format stream-json).
  // --output-format stream-json: emit structured JSONL so we can parse token
  // usage from message.usage fields (same approach as the desktop harness).
  // Grant tool permissions so claude doesn't prompt for approval in headless mode.
  // Matches the dispatch workflow's claude_args (symphony-dispatch.yml:962-964).
  args.push(
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--allowedTools",
    "Bash,Glob,Grep,Read,Write,Edit,Task,Skill,SlashCommand,TodoWrite",
    "--max-turns",
    "200"
  );

  // If resuming from a parent loop, use --resume to continue the session
  if (config.parentSessionId) {
    args.push("--resume", config.parentSessionId);
  }

  switch (config.command) {
    case LoopCommand.RequestChanges: {
      // Build the full skill invocation as a SINGLE prompt string.
      // The claude CLI treats each argv entry after flags as the prompt —
      // if we pass --workdir / --message as separate argv entries, the CLI
      // interprets them as its own flags and errors with "unknown option".
      // The dispatch workflow sends the equivalent as one prompt field:
      //   /code:amend-plan --workdir $RUN_DIR --message "$MESSAGE"
      const contextDir = path.join(workDir, ".closedloop-ai", "context");
      const promptFile = path.join(contextDir, "prompt.md");
      let prompt = "Please amend the plan based on the requested changes.";
      if (fs.existsSync(promptFile)) {
        prompt = fs.readFileSync(promptFile, "utf-8");
      }
      // Sanitize prompt to match dispatch's prepare-message step:
      // collapse newlines to spaces, escape double quotes
      const sanitized = prompt
        .replace(/[\n\r]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/"/g, '\\"');
      args.push(
        `/code:amend-plan --workdir ${symphonyWD || workDir} --message "${sanitized}"`
      );
      break;
    }
    case LoopCommand.Chat:
    case LoopCommand.Explore:
    case LoopCommand.Decompose:
    case LoopCommand.GeneratePrd: {
      const contextDir = path.join(workDir, ".closedloop-ai", "context");
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
    case LoopCommand.EvaluatePrd: {
      // prd.md is written to symphonyWD (the run directory) by writePrdFile(),
      // and uploadState() collects prd-judges.json from that same directory.
      // Use symphonyWD so the skill reads prd.md and writes prd-judges.json
      // to the correct location.
      const runDir = symphonyWD ?? workDir;

      // Build skill invocation with runDir containing PRD artifact
      let skillCall = `Activate judges:run-judges skill --artifact-type prd --workdir ${runDir}.\n`;

      // Add optional codebase path if target repo exists
      if (config.targetRepo) {
        // Target repo is cloned to workDir during prepareWorkspace()
        skillCall += `REPO_PATH=${workDir} (search here for relevant code).\n`;
      }

      args.push(skillCall);
      break;
    }
    case LoopCommand.EvaluatePlan: {
      // plan.json is written to symphonyWD (the run directory).
      // Use symphonyWD so the skill reads plan artifacts and writes plan-judges.json
      // to the correct location.
      const runDir = symphonyWD ?? workDir;

      // Build skill invocation with runDir containing plan artifact
      // REPO_PATH is mandatory for plan evaluation (codebase context)
      const skillCall =
        `Activate judges:run-judges skill --artifact-type plan --workdir ${runDir}.\n` +
        `REPO_PATH=${workDir} (search here for relevant code).\n`;

      args.push(skillCall);
      break;
    }
    case LoopCommand.EvaluateCode: {
      // Code artifacts are written to symphonyWD (the run directory).
      // Use symphonyWD so the skill reads code artifacts and writes code-judges.json
      // to the correct location.
      const runDir = symphonyWD ?? workDir;

      // Build skill invocation with runDir containing code artifact
      // REPO_PATH is mandatory for code evaluation (codebase context)
      const skillCall =
        `Activate judges:run-judges skill --artifact-type code --workdir ${runDir}.\n` +
        `REPO_PATH=${workDir} (search here for relevant code).\n`;

      args.push(skillCall);
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
// ClosedLoop.AI workdir inside the repo (e.g., .closedloop-ai/runs/YYYYMMDD-HHMMSS-loop-xxx/)
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
    const shouldCommitAndPush = config.command === LoopCommand.Execute;
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
        code: LoopErrorCode.Cancelled,
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

// ---------------------------------------------------------------------------
// Repository bootstrap (runs .closedloop-ai/loops-setup.sh if present)
// ---------------------------------------------------------------------------
// Environment variables exported by the setup script and persisted to
// .closedloop-ai/.env.setup. These are merged into the Claude child process env.
const setupEnvVars = {};

function runRepoSetup(workDir) {
  const setupScript = path.join(workDir, ".closedloop-ai", "loops-setup.sh");
  if (!fs.existsSync(setupScript)) {
    log(
      "info",
      "No .closedloop-ai/loops-setup.sh found — skipping repo bootstrap"
    );
    return;
  }

  log("info", `Running repo bootstrap: ${setupScript}`);
  try {
    const result = spawnSync("bash", [setupScript], {
      cwd: workDir,
      stdio: "inherit",
      env: {
        ...process.env,
        HOME: process.env.HOME || os.homedir(),
      },
      timeout: 300_000, // 5 minute timeout for install
    });
    if (result.error || result.status !== 0) {
      log(
        "warn",
        `Repo bootstrap exited with status ${result.status}${result.error ? `: ${result.error.message}` : ""}`
      );
    } else {
      log("info", "Repo bootstrap completed");
    }
  } catch (err) {
    // Non-fatal: log and continue. The LLM can still try to bootstrap itself.
    log("error", `Repo bootstrap failed: ${err.message}`);
  }

  // Read persisted env vars from the setup script (if written)
  const envSetupFile = path.join(workDir, ".closedloop-ai", ".env.setup");
  if (fs.existsSync(envSetupFile)) {
    const content = fs.readFileSync(envSetupFile, "utf-8");
    for (const line of content.split("\n")) {
      const match = /^export\s+([A-Z_]+)="?(.*?)"?\s*$/.exec(line);
      if (match) {
        setupEnvVars[match[1]] = match[2];
      }
    }
    log(
      "info",
      `Loaded setup env vars: ${Object.keys(setupEnvVars).join(", ")}`
    );
  }
}

function shouldCreateWorkingBranch() {
  return config.command === LoopCommand.Execute;
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
        env: buildGitAuthEnv(),
      });
      execFileSync("git", ["checkout", config.parentBranchName], {
        cwd: workDir,
        stdio: "pipe",
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
      });
    } catch {
      // Branch may already exist in local clone (e.g., retry). Reuse it.
      execFileSync("git", ["checkout", branchName], {
        cwd: workDir,
        stdio: "pipe",
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

  const error = validateCommandInputs(command, hasPrompt, hasArtifacts);
  if (error) {
    throw new HarnessError(
      ERROR_CODES.preRunValidation,
      `Pre-run validation failed: ${error}`
    );
  }
}

/**
 * @param {string} workDir
 * @param {string|null|undefined} symphonyWD
 * @param {string|null|undefined} prdPath
 * @param {string[]} [additionalRepoPaths]
 */
function buildCommand(workDir, symphonyWD, prdPath, additionalRepoPaths) {
  const usesRunLoop =
    config.command === LoopCommand.Plan ||
    config.command === LoopCommand.Execute;

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
    return buildRunLoopArgs(
      runLoopPath,
      symphonyWD || workDir,
      prdPath,
      additionalRepoPaths
    );
  }
  return buildClaudeDirectArgs(workDir, symphonyWD);
}

function toHarnessError(err) {
  if (err instanceof HarnessError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HarnessError(ERROR_CODES.runner, message, err);
}

// ---------------------------------------------------------------------------
// Harness-level safety net (ECS task timeout is the real operational guard)
// ---------------------------------------------------------------------------
const MAX_RUNTIME_MS = 24 * 60 * 60 * 1000; // 24 hours

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
// Execute command with safety-net time limit
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
    const filePath = path.join(workDir, LoopArtifactFile.ExecutionResult);

    // Don't overwrite if the LLM commit step already wrote it —
    // the LLM's version has first-hand PR/commit info from its own operations.
    if (fs.existsSync(filePath)) {
      log(
        "info",
        "execution-result.json already exists (written by LLM commit), skipping"
      );
      return;
    }

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
  // Step 0: Refresh GitHub token before commit/push (token may have expired
  // during the run)
  await refreshGitHubToken();

  const shouldCommitAndPush = config.command === LoopCommand.Execute;

  const isIncomplete = timedOut || exitCode !== 0;
  const safetyCommitMsg = isIncomplete
    ? "[INCOMPLETE] WIP: Safety commit — leftover changes"
    : "Post-run: uncommitted changes from loop execution";

  let prInfo = null;

  if (shouldCommitAndPush) {
    const resultFilePath = path.join(
      swDir || workDir,
      LoopArtifactFile.ExecutionResult
    );

    // Step 1: LLM-assisted commit — standalone Claude call that reviews
    // changes, writes a good commit message, pushes, creates a PR, and
    // writes execution-result.json directly with first-hand info.
    // The LLM ONLY writes execution-result.json on successful commit+push.
    const llmPrInfo = attemptLlmCommit(workDir, resultFilePath);

    // Step 2: Check if the LLM handled everything.
    // execution-result.json exists = LLM committed + pushed successfully.
    // No need for safety commit, branch push, or mechanical PR creation.
    if (llmPrInfo && fs.existsSync(resultFilePath)) {
      log("info", "LLM commit handled everything — skipping safety commit");
      prInfo = llmPrInfo;
    } else {
      // Fallback: safety commit + push + mechanical PR creation
      log(
        "info",
        "LLM commit did not produce execution-result.json — running safety fallback"
      );
      attemptSafetyCommit(workDir, safetyCommitMsg);
      ensureBranchPushed(workDir);

      prInfo = parsePrInfo(workDir, output);
      if (llmPrInfo?.prUrl) {
        prInfo = { ...(prInfo || {}), ...llmPrInfo };
      }
      prInfo = createPullRequest(workDir, prInfo);

      // Write execution-result.json ourselves since the LLM didn't
      writeExecutionResult(swDir || workDir, prInfo);
    }

    // Label incomplete PRs regardless of which path created the PR
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

  // Step 6: Upload state + metadata
  await uploadState(workDir, output, swDir);
  await uploadMetadata(workDir, output, tokenUsage, startTime);

  // Step 7: Report event
  if (timedOut) {
    await reportEvent({
      type: "error",
      code: LoopErrorCode.TimedOut,
      message: `Loop exceeded maximum runtime of ${MAX_RUNTIME_MS / 1000}s`,
      result: {
        ...prInfo,
        ...(capturedSessionId ? { sessionId: capturedSessionId } : {}),
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
        ...prInfo,
        ...(capturedSessionId ? { sessionId: capturedSessionId } : {}),
      },
      tokensUsed: {
        input: tokenUsage.totalInput,
        output: tokenUsage.totalOutput,
      },
      ...(tokenUsage.tokensByModel
        ? { tokensByModel: tokenUsage.tokensByModel }
        : {}),
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported COMPLETED event");
  } else {
    await reportEvent({
      type: "error",
      code: LoopErrorCode.ProcessFailed,
      message: `Process exited with code ${exitCode}`,
      result: {
        ...prInfo,
        ...(capturedSessionId ? { sessionId: capturedSessionId } : {}),
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
  log("info", "ClosedLoop.AI Claude Runner - Harness Agent");
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

    // Register per-repo tokens so they are redacted from all subsequent log output
    // before the first log call that might include a repo URL with embedded credentials.
    if (Array.isArray(contextPack?.additionalRepos)) {
      for (const repo of contextPack.additionalRepos) {
        registerSecret(repo.githubToken);
      }
    }

    // Step 2: Report started event (triggers backend secret scrubbing)
    await reportEvent({
      type: "started",
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported STARTED event");

    // Step 2a: Refresh GitHub token (installation tokens expire after 1h;
    // ECS placement + S3 downloads may have consumed most of that window)
    await refreshGitHubToken(contextPack);

    // Step 3: Clone the target repository or prepare an empty workspace
    prepareWorkspace(workDir);

    // Step 3-peer: Clone additional peer repositories specified in the context pack.
    // Returns an array of local directory paths (e.g., ["/workspace/peers/org--repo"]).
    const additionalRepoPaths = cloneAdditionalRepos(
      contextPack?.additionalRepos
    );

    // Step 3-bootstrap: Run repo-level setup script if present.
    // This installs dependencies (pnpm install), generates env stubs, sets
    // NODE_OPTIONS, and runs prisma generate — saving the LLM from having to
    // figure all this out on its own (wasting tokens and risking bad decisions
    // like making env vars optional in source code).
    runRepoSetup(workDir);

    // Step 3a: Restore prior run state from parent loop (if resuming).
    // This restores .closedloop-ai/ and ~/.claude/ so run-loop can continue
    // where the parent left off.
    await downloadState(workDir);

    // Step 3b: Write context files into the prepared workspace.
    // This must happen after clone AND after downloadState — clone fails on
    // non-empty dir, and we want fresh context to overwrite .closedloop-ai/context/.
    await writeContextPackFiles(workDir, contextPack);

    // Step 3b2: Resolve the symphony run directory.
    // There is ONE run directory per chain (PLAN → RC → RC → EXECUTE).
    // - PLAN (fresh): creates a new run dir
    // - Child loops (RC, EXECUTE): reuse the parent's run dir restored by downloadState
    // This mirrors the GitHub Actions flow where symphony-artifact downloads/uploads
    // the same .closedloop-ai/runs/TIMESTAMP/ directory across all steps.
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
        WORKSPACE_STATE_DIR,
        WORKSPACE_RUNS_SUBDIR,
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
    const { cmd, args } = buildCommand(
      workDir,
      symphonyWorkDir,
      prdPath,
      additionalRepoPaths
    );

    // Step 5: Build environment for the child process
    const childEnv = {
      ...setupEnvVars, // env vars from .closedloop-ai/loops-setup.sh (NODE_OPTIONS, etc.)
      ANTHROPIC_API_KEY: config.anthropicApiKey,
      GITHUB_TOKEN: config.githubToken,
      GH_TOKEN: config.githubToken,
      HOME: process.env.HOME || os.homedir(),
      PATH: process.env.PATH,
      LANG: process.env.LANG || "C.UTF-8",
    };

    // Step 6: Execute
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
      symphonyWorkDir,
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

    // Best-effort: refresh token, LLM commit, safety commit, push, create PR
    // Mirrors dispatch workflow's `if: always()` pattern — preserve work
    // even on fatal errors.
    const shouldCommitAndPush = config.command === LoopCommand.Execute;

    try {
      await refreshGitHubToken();
    } catch (_) {
      // ignore
    }

    let prInfo = null;
    if (shouldCommitAndPush) {
      const errorResultPath = path.join(
        symphonyWorkDir || workDir,
        LoopArtifactFile.ExecutionResult
      );

      // Try LLM commit first (writes execution-result.json on success)
      let llmPrInfo = null;
      try {
        llmPrInfo = attemptLlmCommit(workDir, errorResultPath);
      } catch {
        // ignore
      }

      // Check if LLM handled everything
      if (llmPrInfo && fs.existsSync(errorResultPath)) {
        prInfo = llmPrInfo;
      } else {
        // Fallback: safety commit + push + mechanical PR
        try {
          attemptSafetyCommit(
            workDir,
            "[INCOMPLETE] WIP: Safety commit — harness error"
          );
          ensureBranchPushed(workDir);
        } catch {
          // ignore
        }

        try {
          prInfo = parsePrInfo(workDir, output);
          if (llmPrInfo?.prUrl) {
            prInfo = { ...(prInfo || {}), ...llmPrInfo };
          }
          prInfo = createPullRequest(workDir, prInfo);
        } catch {
          // ignore
        }

        // Write execution-result.json ourselves since LLM didn't
        try {
          writeExecutionResult(symphonyWorkDir || workDir, prInfo);
        } catch {
          // ignore
        }
      }

      // Label incomplete PRs regardless of path
      if (prInfo?.prNumber) {
        try {
          labelPrIncomplete(workDir, prInfo.prNumber);
        } catch {
          // ignore
        }
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
          ...prInfo,
          ...(capturedSessionId ? { sessionId: capturedSessionId } : {}),
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

// ---------------------------------------------------------------------------
// Exports — testable pure functions (no I/O side effects at import time)
// ---------------------------------------------------------------------------
export {
  buildClaudeDirectArgs,
  buildCommand,
  buildRunLoopArgs,
  cloneAdditionalRepos,
  config,
  ERROR_CODES,
  findExistingRunDir,
  getHomeStateTransferPrefix,
  getWorkspaceStateRestorePrefixes,
  getWorkspaceStateUploadPrefixes,
  HarnessError,
  extractSessionId,
  parseTokenUsage,
  parseTokenUsageFromJsonl,
  parseTokenUsageFromJsonlFile,
  parseTokenUsageFromRegex,
  parsePrInfo,
  redactSensitive,
  refreshGitHubToken,
  registerSecret,
  syncPlanFromContextPack,
  validateConfig,
  validatePreRunInputs,
  validateSecrets,
  writeContextPackFiles,
  writeExecutionResult,
  writePrdFile,
};

// Guard main() so the script does not execute when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
