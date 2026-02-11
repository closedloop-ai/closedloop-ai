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
};

function redactSensitive(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  const secrets = [config.anthropicApiKey, config.githubToken, config.authToken].filter(
    (secret) => typeof secret === "string" && secret.length > 0
  );

  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(/x-access-token:[^@]+@/g, "x-access-token:[REDACTED]@");
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
  const requiredEnv = [
    "loopId",
    "command",
    "authToken",
    "apiBaseUrl",
    "targetRepo",
  ];
  const missing = requiredEnv.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

function validateSecrets() {
  // Validate secrets extracted from S3 context pack.
  const requiredSecrets = ["anthropicApiKey"];
  const missing = requiredSecrets.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(
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
async function downloadContextPack(workDir) {
  if (!config.s3ContextKey) {
    log("info", "No S3_CONTEXT_KEY set, skipping context pack download");
    return;
  }

  const buf = await downloadFromS3(config.s3ContextKey);
  const contextDir = path.join(workDir, ".claude", "context");
  fs.mkdirSync(contextDir, { recursive: true });

  // Context packs are always JSON (uploaded by the backend via uploadContextPack).
  // Reject non-JSON payloads rather than attempting archive extraction, which
  // would introduce tar-slip risk and an unnecessary attack surface.
  let pack;
  try {
    pack = JSON.parse(buf.toString("utf-8"));
  } catch {
    throw new Error(
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
    delete pack.secrets;
    log("info", "Extracted secrets from context pack");
  }

  // Write remaining context data to disk (no secrets).
  for (const [relPath, content] of Object.entries(pack)) {
    const absPath = path.join(contextDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(
      absPath,
      typeof content === "string" ? content : JSON.stringify(content, null, 2)
    );
  }
  log("info", `Wrote ${Object.keys(pack).length} context pack files`);
}

// ---------------------------------------------------------------------------
// Repository cloning
// ---------------------------------------------------------------------------
function cloneRepo(workDir) {
  const cloneUrl = `https://github.com/${config.targetRepo}.git`;
  const authHeader = Buffer.from(
    `x-access-token:${config.githubToken}`,
    "utf-8"
  ).toString("base64");
  log("info", `Cloning ${config.targetRepo} (branch: ${config.targetBranch})`);

  // Use execFileSync with array args to prevent shell injection via branch/repo names
  execFileSync(
    "git",
    ["clone", "--depth", "50", "--branch", config.targetBranch, cloneUrl, workDir],
    {
      stdio: "pipe",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || os.homedir(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authHeader}`,
      },
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

  // 3. Upload key work directory files (plan.json, plan.md, etc.)
  const keyFiles = [
    "plan.json",
    "plan.md",
    "implementation-plan.md",
    ".claude/symphony-loop.local.md",
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
  const args = ["claude"];

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

  return { cmd: "npx", args };
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

    // Kill the child process if still running
    if (currentChild && !currentChild.killed) {
      log("info", "Terminating child process...");
      currentChild.kill("SIGTERM");

      // Give it 10 seconds, then force kill
      setTimeout(() => {
        if (currentChild && !currentChild.killed) {
          log("info", "Force killing child process...");
          currentChild.kill("SIGKILL");
        }
      }, 10_000);
    }

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
  log("info", `Target Repo:    ${config.targetRepo}`);
  log("info", `Target Branch:  ${config.targetBranch}`);
  log("info", `Correlation ID: ${config.correlationId}`);
  log("info", `Max Iterations: ${config.maxIterations}`);

  validateConfig();
  setupShutdownHandlers(workDir);

  let output = [];

  try {
    // Step 1: Report started event
    await reportEvent({
      type: "started",
      correlationId: config.correlationId,
      loopId: config.loopId,
    });
    log("info", "Reported STARTED event");

    // Step 2: Clone the target repository
    cloneRepo(workDir);

    // Step 3: Download and extract context pack from S3 (secrets are extracted here)
    await downloadContextPack(workDir);
    validateSecrets();

    // Step 4: Determine execution mode and build command
    const command = config.command.toLowerCase();
    const usesRunLoop = command === "plan" || command === "execute";
    let cmd, args;

    if (usesRunLoop) {
      const runLoopPath = findRunLoop();
      ({ cmd, args } = buildRunLoopArgs(runLoopPath, workDir));
    } else {
      ({ cmd, args } = buildClaudeDirectArgs(workDir));
    }

    // Step 5: Build environment for the child process
    const childEnv = {
      ANTHROPIC_API_KEY: config.anthropicApiKey,
      GITHUB_TOKEN: config.githubToken,
      GH_TOKEN: config.githubToken,
      HOME: process.env.HOME || os.homedir(),
      PATH: process.env.PATH,
      LANG: process.env.LANG || "C.UTF-8",
    };

    // Step 6: Execute the command
    log("info", `Executing: ${cmd} ${args.join(" ")}`);

    const result = await spawnProcess(cmd, args, workDir, childEnv);
    output = result.output;

    const exitCode = result.code;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    log(
      "info",
      `Process exited with code ${exitCode} (signal: ${result.signal}) after ${duration}s`
    );

    // Step 7: Parse token usage from output
    const tokenUsage = parseTokenUsage(output);
    log(
      "info",
      `Token usage: input=${tokenUsage.totalInput}, output=${tokenUsage.totalOutput}, models=${
        tokenUsage.tokensByModel
          ? Object.keys(tokenUsage.tokensByModel).join(", ")
          : "unknown"
      }`
    );

    // Step 8: Upload state + metadata to S3
    await uploadState(workDir, output);
    await uploadMetadata(workDir, output, tokenUsage, startTime);

    // Step 9: Report final status with token breakdown
    if (exitCode === 0) {
      await reportEvent({
        type: "completed",
        result: {
          exitCode,
          signal: result.signal,
          durationSeconds: Number.parseFloat(duration),
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
        correlationId: config.correlationId,
        loopId: config.loopId,
      });
      log("info", "Reported FAILED event");
    }

    // Exit with the child's exit code
    process.exit(exitCode || 0);
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log("error", `Fatal error after ${duration}s: ${redactSensitive(errorMessage)}`);
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

    // Best-effort: report failure
    try {
      await reportEvent({
        type: "error",
        code: "RUNNER_ERROR",
        message: redactSensitive(errorMessage),
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
