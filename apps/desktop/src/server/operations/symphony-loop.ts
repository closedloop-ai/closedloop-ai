import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExecutionResultV2,
  RepoExecutionResult,
} from "@closedloop-ai/loops-api/execution-result";
import {
  emitDecisionTableVerificationTelemetry,
  getDecisionTableVerificationTelemetryOffset,
} from "../../main/decision-table-verification-telemetry.js";
import {
  readLogTail,
  readStderrTail,
  readTextFile,
  sanitizeErrorMessage,
  stripAnsi,
} from "../../main/diagnostics-helpers.js";
import { gatewayLog } from "../../main/gateway-logger.js";
import type {
  JobStore,
  LocalJob,
  LocalJobCommand,
  LocalJobCommitter,
  LocalJobExecuteFinalizationPath,
  LocalJobExecuteFinalizationStatus,
  LocalJobFinalizationSource,
} from "../../main/job-store.js";
import { createStubJobStore } from "../../main/job-store.js";
import { parseJwtExpiry } from "../../main/jwt-utils.js";
import {
  EXECUTE_NO_WORK_MESSAGE,
  finalizeLoopFromRuntime,
  isExecuteNoWorkCompletion,
  isRetryableFinalizationError,
  type LoopCompletedHook,
  type LoopFinalizerDeps,
  makeHeartbeatFinalizeFn,
  tryUploadArtifacts,
  tryUploadSupportBundle,
} from "../../main/loop-finalizer.js";
import type { LoopPopDeps } from "../../main/loop-lifecycle.js";
import {
  getLoopPerfTelemetryOffset,
  type LoopPerfTelemetryWatcherHandle,
  reconcileLoopPerfTelemetry,
  startLoopPerfTelemetryWatcher,
} from "../../main/loop-perf-telemetry.js";
import type { LoopSchedulerContext } from "../../main/loop-scheduler-context.js";
import type {
  LoopTokenMeta,
  LoopTokenStore,
} from "../../main/loop-token-store.js";
import { Observability } from "../../main/observability.js";
import type { ExecutePlanSourceDiagnostics } from "../../main/telemetry-protocol.js";
import {
  type ModelTokenUsage,
  parseTokenUsage,
  resolveClaudeOutputPath,
} from "../../main/token-usage.js";
import {
  clearUserVisibleLoopFailureMarker,
  readUserVisibleLoopFailure,
  toUserVisibleLoopFailurePayload,
  USER_VISIBLE_LOOP_FAILURE_SECRET_ENV,
} from "../../main/user-visible-loop-failure.js";
import {
  IMPORTED_PLAN_MARKDOWN_FILE,
  isRawPlanArtifact,
  PLAN_SOURCE_MARKDOWN_FILE,
  toUploadedPlanArtifact,
} from "../../shared/plan-artifact-utils.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import {
  type ClaudeCodeShellEnvProvider,
  getClaudeCodeShellEnv,
} from "../otel/claude-code-env.js";
import { validateOutboundUrlForSurface } from "../outbound-url-policy.js";
import { readJsonFileSync } from "../read-json-file-sync.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import {
  getShellEnv,
  getShellPath,
  resetShellPathCache,
  resolveBinaryFromLoginShell,
  resolveBinaryFromLoginShellSync,
} from "../shell-path.js";
import { withMcpTools } from "./chat-tools.js";
import {
  CommandPackLaunchMode,
  createClosedloopWebCommandPackFactory,
  outputInstructionForCommand,
  type RuntimeSelection,
} from "./command-pack-factory.js";
import {
  findWorktreeForBranch as findWorktreeForBranchImpl,
  resolveRepoFullName,
} from "./git-helpers.js";
import {
  postLoopEvent,
  postLoopEventBounded,
  uploadArtifacts,
} from "./loop-http.js";
import {
  createNativeLoopObservabilitySession,
  type NativeLoopObservabilitySession,
} from "./observability/native-loop-observability.js";
import { startOutputTailer } from "./output-tailer.js";
import {
  findPluginScript,
  findPluginVersions,
  getPluginCacheRoot,
} from "./plugin-cache.js";
import { addRepo } from "./repos-config-utils.js";
import { sanitizeCommitMessage } from "./symphony-interactive.js";
import {
  clearPendingLoopExit,
  registerPendingLoopExit,
} from "./symphony-loop-lifecycle.js";
import type { BootstrapRunResult } from "./symphony-utils.js";
import {
  CLONE_GIT_TIMEOUT,
  expandHome,
  fetchOrigin,
  isProcessRunning,
  loopError,
  loopLog,
  resolveRef,
  resolveWorktreeParentDir,
  runBootstrapIfNeeded,
  runLoopsSetupScript,
  SymphonyDirNotConfiguredError,
  tryAssertRepoAllowed,
} from "./symphony-utils.js";

export {
  readFileTail,
  readLogTail,
  readStderrTail,
  stripAnsi,
} from "../../main/diagnostics-helpers.js";

// ---------------------------------------------------------------------------
// WorktreeProvider: abstraction over git worktree operations for testability
// ---------------------------------------------------------------------------

export type WorktreeProvider = {
  ensureWorktree(
    repoPath: string,
    worktreeDir: string,
    branchName: string,
    baseBranch: string,
    loopId: string
  ): Promise<void>;
  findWorktreeForBranch(repoPath: string, branchName: string): string | null;
  removeWorktree(
    worktreeDir: string,
    repoPath: string,
    loopId?: string
  ): Promise<void>;
  getCurrentBranch(worktreeDir: string): string | null;
  branchExists(repoPath: string, branch: string): Promise<boolean>;
};

export const defaultWorktreeProvider: WorktreeProvider = {
  ensureWorktree: ensureWorktreeImpl,
  findWorktreeForBranch: findWorktreeForBranchImpl,
  removeWorktree: removeWorktreeImpl,
  getCurrentBranch: getCurrentBranchImpl,
  branchExists: branchExistsImpl,
};

// Promisified execFile for non-blocking subprocess invocations (e.g. gh repo clone).
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------

/**
 * User-configured binary path overrides returned by Desktop settings.
 */
type BinaryPathOverrides = {
  claude?: string;
  gh?: string;
  codex?: string;
  cursor?: string;
  opencode?: string;
  python3?: string;
  git?: string;
};

type BinaryPathsResolver = () => BinaryPathOverrides;

/**
 * Module-level binary paths resolver, configured once in GatewayRouter constructor.
 * Loop requests can bind their router's resolver through async-local storage so
 * concurrent gateway instances in tests cannot race each other's overrides.
 */
let overrideGetBinaryPaths: BinaryPathsResolver | null = null;
const binaryPathsResolverContext = new AsyncLocalStorage<BinaryPathsResolver>();

function getActiveBinaryPathsResolver(): BinaryPathsResolver | null {
  return binaryPathsResolverContext.getStore() ?? overrideGetBinaryPaths;
}

export function configureBinaryPathsResolver(
  resolver: BinaryPathsResolver | null
): void {
  overrideGetBinaryPaths = resolver;
}

export function getOverrideBinaryPaths(): BinaryPathOverrides | null {
  return getActiveBinaryPathsResolver()?.() ?? null;
}

export function getResolvedGitPath(): string {
  const override = getOverrideBinaryPaths()?.git;
  const resolved = resolveBinaryFromLoginShellSync("git", override);
  if (resolved.source !== "override_invalid") {
    return resolved.path;
  }
  return resolveBinaryFromLoginShellSync("git").path;
}

export function getResolvedGhPath(): string {
  return resolveBinaryFromLoginShellSync("gh", getOverrideBinaryPaths()?.gh)
    .path;
}

/**
 * Reset the shared login-shell PATH cache used by sync binary wrappers.
 * Intended for tests where PATH changes between cases.
 */
export function resetResolvedClaudePath(): void {
  resetShellPathCache();
}

export function getResolvedClaudePath(): string {
  return resolveBinaryFromLoginShellSync(
    "claude",
    getOverrideBinaryPaths()?.claude
  ).path;
}

// ---------------------------------------------------------------------------
// Types — shared contract from @closedloop-ai/loops-api
// ---------------------------------------------------------------------------

import { LoopArtifactFile, LoopArtifactType } from "@closedloop-ai/loops-api/artifacts";
import { validateResultBundle } from "@closedloop-ai/loops-api/bundles";
import { LoopCommand, validateCommandInputs } from "@closedloop-ai/loops-api/commands";
import type {
  ContextPackAgent,
  ContextPackRepoConfig,
  ContextPackAttachment as SharedContextPackAttachment,
} from "@closedloop-ai/loops-api/context-pack";
import {
  LoopHarness,
  type LoopRequestBody,
} from "@closedloop-ai/loops-api/desktop-request";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { LoopEventType } from "@closedloop-ai/loops-api/events";
import {
  getPrimaryRepoResult,
  parseExecutionResultFile,
} from "@closedloop-ai/loops-api/execution-result";
import { getMultiRepoPolicy } from "@closedloop-ai/loops-api/multi-repo-policy";
import {
  buildMountPathsFooter,
  buildPeerEnvVars,
  toPeerWorktreeRefs,
  writePeerReposManifest,
} from "./peer-context.js";
import { json } from "./response-utils.js";
import {
  type CodeContextFile,
  parseSymphonyLoopRequestBody,
  type SymphonyBranchMaterializationEntry,
  type SymphonyLoopRequestBody,
  SymphonyLoopRequestValidationError,
  type SymphonyLoopSupportingArtifact,
} from "./symphony-loop-request.js";

/** Commands that have full spawn/dispatch support in this gateway version. */
const SUPPORTED_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
  LoopCommand.RequestPrdChanges,
  LoopCommand.Decompose,
  LoopCommand.EvaluatePrd,
  LoopCommand.GeneratePrd,
  LoopCommand.EvaluatePlan,
  LoopCommand.EvaluateCode,
  LoopCommand.EvaluateFeature,
  LoopCommand.Bootstrap,
]);
const VALID_COMMANDS = SUPPORTED_COMMANDS;
type RepoRequirement = "REQUIRED" | "OPTIONAL" | "NOT_REQUIRED";
const REPO_REQUIREMENT_BY_COMMAND: Record<LoopCommand, RepoRequirement> = {
  [LoopCommand.Plan]: "REQUIRED",
  [LoopCommand.Execute]: "REQUIRED",
  [LoopCommand.Chat]: "NOT_REQUIRED",
  [LoopCommand.Explore]: "NOT_REQUIRED",
  [LoopCommand.RequestChanges]: "REQUIRED",
  [LoopCommand.RequestPrdChanges]: "REQUIRED",
  [LoopCommand.EvaluatePrd]: "OPTIONAL",
  [LoopCommand.GeneratePrd]: "REQUIRED",
  [LoopCommand.Decompose]: "NOT_REQUIRED",
  [LoopCommand.EvaluatePlan]: "REQUIRED",
  [LoopCommand.EvaluateCode]: "REQUIRED",
  [LoopCommand.EvaluateFeature]: "OPTIONAL",
  [LoopCommand.Bootstrap]: "NOT_REQUIRED",
  [LoopCommand.Manual]: "NOT_REQUIRED",
};
const LOCAL_CALLBACK_FAIL_FAST_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
  LoopCommand.RequestPrdChanges,
  LoopCommand.GeneratePrd,
]);
const BOOTSTRAP_PREFLIGHT_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
  LoopCommand.RequestPrdChanges,
  LoopCommand.GeneratePrd,
]);
type LoopArtifact = {
  id: string;
  type: LoopArtifactType;
  title?: string;
  content: string;
  raw?: Record<string, unknown>;
};

/** Artifact types that represent an implementation plan. */
export const PLAN_ARTIFACT_TYPES: readonly LoopArtifactType[] = [
  LoopArtifactType.ImplementationPlan,
] as const;

/** Response-payload keys for artifacts produced by loop commands. */
export const LoopOutputArtifactKey = {
  Plan: "plan",
  OpenQuestions: "openQuestions",
  Judges: "judges",
  ExecutionResult: "executionResult",
  CodeJudges: "codeJudges",
  Features: "features",
  Prd: "prd",
  PrdJudges: "prdJudges",
  PlanJudges: "planJudges",
  FeatureJudges: "featureJudges",
  BootstrapResult: "bootstrapResult",
} as const;
export type LoopOutputArtifactKey =
  (typeof LoopOutputArtifactKey)[keyof typeof LoopOutputArtifactKey];

type LoopOutputArtifacts = Partial<Record<LoopOutputArtifactKey, unknown>>;

/** Discriminator for outputs produced by an EVALUATE_{type} loop iteration. */
export const EvaluateArtifact = {
  Prd: "Prd",
  Plan: "Plan",
  Code: "Code",
  Feature: "Feature",
} as const;
export type EvaluateArtifact =
  (typeof EvaluateArtifact)[keyof typeof EvaluateArtifact];

const EVALUATE_ARTIFACT_OUTPUT = {
  [EvaluateArtifact.Prd]: {
    file: LoopArtifactFile.PrdJudges,
    key: LoopOutputArtifactKey.PrdJudges,
  },
  [EvaluateArtifact.Plan]: {
    file: LoopArtifactFile.PlanJudges,
    key: LoopOutputArtifactKey.PlanJudges,
  },
  [EvaluateArtifact.Code]: {
    file: LoopArtifactFile.CodeJudges,
    key: LoopOutputArtifactKey.CodeJudges,
  },
  [EvaluateArtifact.Feature]: {
    file: LoopArtifactFile.FeatureJudges,
    key: LoopOutputArtifactKey.FeatureJudges,
  },
} as const satisfies Record<
  EvaluateArtifact,
  { file: string; key: LoopOutputArtifactKey }
>;

/** Maps each EVALUATE_* loop command to its artifact discriminator. */
export const EVALUATE_COMMAND_ARTIFACT = {
  EVALUATE_PRD: EvaluateArtifact.Prd,
  EVALUATE_PLAN: EvaluateArtifact.Plan,
  EVALUATE_CODE: EvaluateArtifact.Code,
  EVALUATE_FEATURE: EvaluateArtifact.Feature,
} as const satisfies Record<string, EvaluateArtifact>;

function readExecutePlanArtifact(
  claudeWorkDir: string
): ReturnType<typeof toUploadedPlanArtifact> {
  return (
    toUploadedPlanArtifact(
      readJsonFileSync(path.join(claudeWorkDir, LoopArtifactFile.Plan))
    ) ??
    toUploadedPlanArtifact(
      readTextFile(path.join(claudeWorkDir, IMPORTED_PLAN_MARKDOWN_FILE))
    )
  );
}

function readPlanJsonContent(planJsonPath: string): string | null {
  const localPlan = readJsonFileSync(planJsonPath);
  return isRawPlanArtifact(localPlan) && typeof localPlan.content === "string"
    ? localPlan.content
    : null;
}

function shortContentHash(value: string | undefined | null): string | null {
  return value == null
    ? null
    : crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the primary artifact of a given type from a list of artifacts.
 *
 * Selection priority:
 * 1. When `primaryArtifactId` is a non-empty string, find by id — preferred
 *    because it unambiguously identifies the artifact the caller cares about.
 * 2. Fall through to `findLast` by type — the backend's context-pack assembler
 *    (symphony-alpha apps/api/lib/loops/loop-context-pack.ts) appends the
 *    primary artifact last, so findLast returns the primary even when
 *    same-type context refs precede it.
 * 3. Throw if neither strategy finds a match.
 */
export function resolvePrimaryArtifact(
  artifacts: LoopArtifact[],
  type: string,
  primaryArtifactId?: string
): LoopArtifact {
  const found = findPrimaryArtifact(artifacts, type, primaryArtifactId);
  if (found !== undefined) {
    return found;
  }
  throw new Error(`resolvePrimaryArtifact: no ${type} artifact found`);
}

/**
 * Non-throwing variant of resolvePrimaryArtifact.
 * Returns undefined instead of throwing when no matching artifact is found.
 * Same selection priority: id match > findLast by type.
 */
function findPrimaryArtifact(
  artifacts: LoopArtifact[],
  type: string,
  primaryArtifactId?: string
): LoopArtifact | undefined {
  if (primaryArtifactId) {
    const byId = artifacts.find((a) => a.id === primaryArtifactId);
    if (byId !== undefined) {
      return byId;
    }
  }
  return artifacts.findLast((a) => a.type === type);
}

/**
 * Write prd.md to a work directory from a list of artifacts and an optional
 * explicit prompt.
 *
 * The PRD artifact content is always preferred for prd.md when present.
 * Fallback priority: PRD artifact > FEATURE artifact > prompt.
 *
 * When a prompt is provided alongside a PRD artifact, both are written:
 * - prd.md  ← artifact content (what Claude needs to read)
 * - prompt.md ← decompose/evaluate instructions (written by caller)
 */
export async function writePrdArtifact(
  workDir: string,
  artifacts: LoopArtifact[],
  prompt?: string,
  primaryArtifactId?: string
): Promise<void> {
  const prdArtifact = findPrimaryArtifact(
    artifacts,
    LoopArtifactType.Prd,
    primaryArtifactId
  );
  const featureArtifact = prdArtifact
    ? null
    : findPrimaryArtifact(
        artifacts,
        LoopArtifactType.Feature,
        primaryArtifactId
      );
  const source = prdArtifact ?? featureArtifact;

  const prdContent = source?.content || prompt || "";

  if (prdContent) {
    await fs.writeFile(path.join(workDir, LoopArtifactFile.Prd), prdContent);
  }
}

/** Internal helper: writes plan.md to workDir from the last matching plan artifact. */
async function writePlanFileToWorkDir(
  workDir: string,
  artifacts: LoopArtifact[],
  primaryArtifactId?: string
): Promise<void> {
  const artifact = findPrimaryArtifact(
    artifacts,
    LoopArtifactType.ImplementationPlan,
    primaryArtifactId
  );
  if (artifact?.content) {
    await fs.writeFile(
      path.join(workDir, LoopArtifactFile.PlanMarkdown),
      artifact.content
    );
  }
}

/** Write both prd.md and plan.md to a work directory from a list of artifacts. */
export async function writePlanArtifact(
  workDir: string,
  artifacts: LoopArtifact[],
  prompt?: string,
  primaryArtifactId?: string
): Promise<void> {
  await writePrdArtifact(workDir, artifacts, prompt, primaryArtifactId);
  await writePlanFileToWorkDir(workDir, artifacts, primaryArtifactId);
}

/** Write plan.md to a work directory from a list of artifacts. */
export async function writeCodeArtifact(
  workDir: string,
  artifacts: LoopArtifact[],
  primaryArtifactId?: string
): Promise<void> {
  await writePlanFileToWorkDir(workDir, artifacts, primaryArtifactId);
}

/**
 * Write prd.md to a work directory from a Feature artifact.
 *
 * Unlike writePrdArtifact, this helper is strict: it requires a
 * LoopArtifactType.Feature artifact and does not fall back to PRD or
 * prompt. If no Feature artifact is present, it throws.
 *
 * When `primaryArtifactId` is provided, id-based selection is preferred;
 * otherwise the backend ordering convention applies — the primary is
 * appended last by the context-pack assembler, so findLast scores the
 * loop's actual document even when same-type refs precede it.
 */
export async function writeFeatureArtifact(
  workDir: string,
  artifacts: LoopArtifact[],
  primaryArtifactId?: string
): Promise<void> {
  const featureArtifact = resolvePrimaryArtifact(
    artifacts,
    LoopArtifactType.Feature,
    primaryArtifactId
  );
  // Keep prd.md for legacy Feature judges while also exposing the primary
  // Feature on its own runtime path for judge-input mapping.
  await fs.writeFile(
    path.join(workDir, LoopArtifactFile.Prd),
    featureArtifact.content
  );
  await fs.writeFile(
    path.join(workDir, FEATURE_PRIMARY_FILE),
    featureArtifact.content
  );
}

/**
 * Read outputs produced by an EVALUATE_{type} loop iteration.
 * Returns undefined values for missing or unreadable files.
 */
export function readEvaluateOutputs(
  workDir: string,
  artifact: EvaluateArtifact
): LoopOutputArtifacts {
  const output = EVALUATE_ARTIFACT_OUTPUT[artifact];
  const judges = readJsonFileSync(path.join(workDir, output.file));
  return { [output.key]: judges ?? undefined };
}

type LoopCommitter = LocalJobCommitter;

type ContextPackAttachment = SharedContextPackAttachment;

const EVALUATE_CONTEXT_DIR = path.join(".closedloop-ai", "context");
const EVALUATE_ATTACHMENTS_DIR = path.join(
  ".closedloop-ai",
  "work",
  "attachments"
);
const FEATURE_PRIMARY_FILE = "feature.md";

export const SKIPPED_ATTACHMENTS_WARNING_FILE = "skipped-attachments.json";

type ExecutionResult = {
  prUrl: string;
  prNumber: number;
  branchName: string;
  commitSha: string;
};

function isExecutionResult(value: unknown): value is ExecutionResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.prUrl !== "string" ||
    typeof v.prNumber !== "number" ||
    typeof v.branchName !== "string" ||
    typeof v.commitSha !== "string"
  ) {
    return false;
  }
  // Sanity-check field shapes to reject garbage values from the LLM
  if (!/^https?:\/\//.test(v.prUrl)) {
    return false;
  }
  if (!/^[a-f0-9]{7,}$/i.test(v.commitSha)) {
    return false;
  }
  if (!v.branchName.trim()) {
    return false;
  }
  return true;
}

/** Track running loop processes for cancellation and to prevent GC of ChildProcess. */
type RunningLoop = {
  pid: number;
  child?: ReturnType<typeof spawn>;
  stage: "running" | "post-processing";
};
const runningLoops = new Map<string, RunningLoop>();

export function getActiveLoopPid(loopId: string): number | null {
  const entry = runningLoops.get(loopId);
  return entry?.pid ?? null;
}

export function registerRecoveredLoop(loopId: string, pid: number): void {
  runningLoops.set(loopId, { pid, stage: "running" });
}

export function unregisterLoop(loopId: string): void {
  clearPendingLoopExit(loopId);
  runningLoops.delete(loopId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseJsonBody(
  context: OperationRequestContext
): Record<string, unknown> | null {
  if (!context.body.trim()) {
    return null;
  }
  try {
    return JSON.parse(context.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function bootstrapMarkerForResult(result: BootstrapRunResult): string {
  switch (result.status) {
    case "completed":
      return "[bootstrap-completed] Bootstrap completed.";
    case "skipped-artifacts":
      return "[bootstrap-skipped] Bootstrap skipped; artifacts already exist.";
    case "skipped-plugin-missing":
      return "[bootstrap-skipped] Bootstrap skipped; plugin is not installed.";
    case "failed":
      return "[bootstrap-failed] Bootstrap failed; continuing without generated agents.";
    case "timed-out":
      return "[bootstrap-timeout] Bootstrap timed out; continuing without generated agents.";
  }
}

async function postBootstrapOutput(args: {
  apiBaseUrl: string;
  loopId: string;
  token: string;
  chunk: string;
}): Promise<void> {
  const result = await postLoopEventBounded(
    args.apiBaseUrl,
    args.loopId,
    () => args.token,
    {
      type: LoopEventType.Output,
      data: { chunk: args.chunk },
    }
  );
  if (!result.success) {
    loopError(
      args.loopId,
      `Failed to post bootstrap progress event: ${result.error ?? "unknown error"}`
    );
  }
}

async function runLoopBootstrapPreflight(args: {
  worktreeDir: string;
  loopId: string;
  apiBaseUrl: string;
  token: string;
  getClaudeShellEnv?: ClaudeCodeShellEnvProvider;
}): Promise<BootstrapRunResult> {
  await postBootstrapOutput({
    ...args,
    chunk: "[bootstrap-started] Checking bootstrap artifacts.",
  });
  const result = await runBootstrapIfNeeded(
    args.worktreeDir,
    args.loopId,
    args.getClaudeShellEnv
  );
  await postBootstrapOutput({
    ...args,
    chunk: bootstrapMarkerForResult(result),
  });
  return result;
}

/**
 * Find the stream_formatter.py script from the code plugin.
 * Reuses getPluginCacheRoot() and findPluginVersions() from plugin-cache.ts.
 * Falls back to null if not installed — caller should degrade gracefully.
 */
function findStreamFormatter(): string | null {
  // Unit/integration tests set this to exercise the raw `claude` bash wrapper
  // without grep/tee/python (stub claude output is not a full formatter stream).
  if (process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE === "1") {
    return null;
  }
  const pluginDir = path.join(getPluginCacheRoot(), "code");
  const versions = findPluginVersions(pluginDir);
  for (const v of versions) {
    const p = path.join(pluginDir, v, "tools", "python", "stream_formatter.py");
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Build a bash pipeline command that runs claude with stream-json output,
 * filters JSON lines, tees to a jsonl log, and formats for human reading.
 * Falls back to raw claude if formatter is not available.
 */
function buildClaudePipeline(
  claudeArgs: string[],
  claudeWorkDir: string,
  claudeBinary: string,
  stdinFile?: string
): { cmd: string; args: string[] } {
  const formatter = findStreamFormatter();
  const stderrFile = path.join(claudeWorkDir, "claude-stderr.log");
  const jsonlFile = path.join(claudeWorkDir, "claude-output.jsonl");

  // Build the claude command with properly escaped args
  const escapedArgs = claudeArgs.map(shellEscape).join(" ");
  const escapedBinary = shellEscape(claudeBinary);
  const claudeCmd = stdinFile
    ? `${escapedBinary} ${escapedArgs} < ${shellEscape(stdinFile)}`
    : `${escapedBinary} ${escapedArgs}`;

  if (formatter) {
    // Full pipeline matching run-loop.sh:
    // claude ... 2>stderr | grep JSON | tee jsonl | formatter
    const pipeline = [
      `${claudeCmd} 2>${shellEscape(stderrFile)}`,
      "grep --line-buffered '^{'",
      `tee -a ${shellEscape(jsonlFile)}`,
      `python3 ${shellEscape(formatter)}`,
    ].join(" | ");
    return { cmd: "bash", args: ["-c", `${pipeline}; exit \${PIPESTATUS[0]}`] };
  }

  // No formatter — wrap in bash pipeline so grep|tee still writes claude-output.jsonl
  const pipeline = [
    `${claudeCmd} 2>${shellEscape(stderrFile)}`,
    "grep --line-buffered '^{'",
    `tee -a ${shellEscape(jsonlFile)}`,
  ].join(" | ");
  return { cmd: "bash", args: ["-c", `${pipeline}; exit \${PIPESTATUS[0]}`] };
}

type SupportedRuntimeSelection = Extract<RuntimeSelection, { ok: true }>;

function buildCodexPromptPipeline(
  codexBinary: string,
  promptFile: string,
  claudeWorkDir: string
): { cmd: string; args: string[] } {
  const stderrFile = path.join(claudeWorkDir, "claude-stderr.log");
  const jsonlFile = path.join(claudeWorkDir, "claude-output.jsonl");
  const codexCmd = [
    shellEscape(codexBinary),
    "exec",
    "--full-auto",
    "--json",
    "-",
    "<",
    shellEscape(promptFile),
  ].join(" ");
  // Tee the Codex `--json` event stream to claude-output.jsonl (mirrors the
  // Claude pipeline) so the output tailer + native observability adapter can
  // read it. `grep '^{'` keeps only JSON event lines; PIPESTATUS[0] preserves
  // Codex's exit code through the pipeline.
  const pipeline = [
    `${codexCmd} 2>${shellEscape(stderrFile)}`,
    "grep --line-buffered '^{'",
    `tee -a ${shellEscape(jsonlFile)}`,
  ].join(" | ");
  return { cmd: "bash", args: ["-c", `${pipeline}; exit \${PIPESTATUS[0]}`] };
}

function buildNativePromptPipeline(
  runtime: SupportedRuntimeSelection,
  claudeArgs: string[],
  claudeWorkDir: string,
  harnessBinary: string,
  promptFile: string
): { cmd: string; args: string[] } {
  if (runtime.harness.adapter.harness === LoopHarness.Codex) {
    return buildCodexPromptPipeline(harnessBinary, promptFile, claudeWorkDir);
  }
  return buildClaudePipeline(
    claudeArgs,
    claudeWorkDir,
    harnessBinary,
    promptFile
  );
}

function harnessUsesNativePrompt(runtime: SupportedRuntimeSelection): boolean {
  return runtime.harness.launchMode === CommandPackLaunchMode.NativePrompt;
}

function buildPromptWithOutputContract(
  runtime: SupportedRuntimeSelection,
  command: LoopCommand,
  prompt: string,
  workDir: string
): string {
  return harnessUsesNativePrompt(runtime)
    ? appendCommandPackOutputInstruction(command, prompt, workDir)
    : prompt;
}

function buildJudgePromptText(
  runtime: SupportedRuntimeSelection,
  artifactType: "prd" | "feature" | "plan" | "code",
  workDir: string
): string {
  // Native-prompt evaluator path for both Claude and Codex — no claude-plugins
  // (judges:run-judges skill) dependency, per the move to generic Claude Code /
  // Codex usage. Only non-native launch modes fall back to the skill contract.
  return harnessUsesNativePrompt(runtime)
    ? `Evaluate the ${artifactType} artifact in ${workDir}.\n`
    : `Activate judges:run-judges skill --artifact-type ${artifactType} --workdir ${workDir}.\n`;
}

function appendCommandPackOutputInstruction(
  command: LoopCommand,
  prompt: string,
  workDir: string
): string {
  return [
    prompt.trimEnd(),
    "",
    "Closedloop command-pack output contract:",
    outputInstructionForCommand(command),
    `Use work directory: ${workDir}.`,
    "Do not finish until every required output file exists.",
  ].join("\n");
}

const COMMAND_PACK_NATIVE_LOOP_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
]);
const LEGACY_CLAUDE_RUN_LOOP_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
]);

function commandPackPlanOutputContract(): string {
  return [
    `Write ${LoopArtifactFile.Plan} as JSON.`,
    'The JSON must include a top-level "content" string containing the full markdown plan.',
    `Also write the same markdown to ${LoopArtifactFile.PlanMarkdown} when practical.`,
    `If there are unresolved questions, write them to ${LoopArtifactFile.OpenQuestions}.`,
    `If you run plan evaluation, write judge output to ${LoopArtifactFile.Judges}.`,
  ].join("\n");
}

function commandPackExecutionResultContract(): string {
  return [
    `Always write ${LoopArtifactFile.ExecutionResult} before finishing.`,
    "Use this JSON shape:",
    "{",
    '  "has_changes": true,',
    '  "pr_url": "https://github.com/OWNER/REPO/pull/123",',
    '  "pr_number": 123,',
    '  "pr_title": "PR title",',
    '  "branch_name": "current-branch",',
    '  "base_ref": "base-branch",',
    '  "base_branch": "base-branch",',
    '  "commit_sha": "HEAD_SHA"',
    "}",
    'If there are no changes to push, set "has_changes" to false, "pr_number" to 0, and string fields to "".',
  ].join("\n");
}

function buildCommandPackLoopPrompt(params: {
  command: LoopCommand;
  workDir: string;
  worktreeDir: string;
  repoPath: string | null;
  planFile: string | null;
  prompt: string | null | undefined;
  mountedPathsFooter: string;
}): string {
  const prdPath = path.join(params.workDir, LoopArtifactFile.Prd);
  const planJsonPath = path.join(params.workDir, LoopArtifactFile.Plan);
  const promptPath = path.join(params.workDir, "prompt.md");
  const lines = [
    "You are running the Closedloop Web Command Pack.",
    `Command: ${params.command}.`,
    `Primary worktree: ${params.worktreeDir}.`,
    `Closedloop work directory: ${params.workDir}.`,
  ];

  if (params.repoPath) {
    lines.push(`Source repository path: ${params.repoPath}.`);
  }

  if (existsSync(prdPath)) {
    lines.push(`PRD input: ${prdPath}.`);
  }
  if (params.planFile) {
    lines.push(`Imported plan source: ${params.planFile}.`);
  }
  if (existsSync(planJsonPath)) {
    lines.push(`Existing plan JSON: ${planJsonPath}.`);
  }
  if (existsSync(promptPath)) {
    lines.push(`Requested-change prompt: ${promptPath}.`);
  }
  if (params.prompt) {
    lines.push("", "User prompt:", params.prompt.trim());
  }

  lines.push(
    "",
    "Command behavior:",
    commandPackBehaviorForCommand(params.command),
    "",
    "Output contract:",
    outputInstructionForCommand(params.command),
    params.command === LoopCommand.Execute
      ? commandPackExecutionResultContract()
      : commandPackPlanOutputContract(),
    "",
    "Rules:",
    "- Do not require or invoke claude-plugins, /code:* slash commands, or run-loop.sh.",
    "- Work inside the primary worktree unless a mounted path is explicitly listed.",
    "- Do not finish until every required output file exists in the Closedloop work directory.",
    params.mountedPathsFooter
  );

  return lines.filter((line) => line.length > 0).join("\n");
}

function commandPackBehaviorForCommand(command: LoopCommand): string {
  switch (command) {
    case LoopCommand.Plan:
      return [
        `Read ${LoopArtifactFile.Prd} from the Closedloop work directory.`,
        "Inspect the repository enough to produce an implementation plan grounded in the current codebase.",
        "Do not modify source files for PLAN.",
      ].join("\n");
    case LoopCommand.Execute:
      return [
        `Read the plan from ${LoopArtifactFile.Plan}, imported-plan.md, or plan-source.md in the Closedloop work directory.`,
        "Implement the plan in the worktree.",
        "Commit, push, and open or update a pull request when changes are produced.",
      ].join("\n");
    case LoopCommand.RequestChanges:
      return [
        `Read the current plan from ${LoopArtifactFile.Plan}, imported-plan.md, or plan-source.md in the Closedloop work directory.`,
        "Read requested changes from prompt.md or the user prompt.",
        "Amend the plan only; do not modify source files.",
      ].join("\n");
    default:
      return "Follow the command-specific user prompt.";
  }
}

/** Find the local repo path for a given fullName (e.g. "org/repo"). */
function findLocalRepo(fullName: string, allowedDirs: string[]): string | null {
  const repoName = fullName.split("/").pop();
  if (!repoName) {
    return null;
  }

  for (const dir of allowedDirs) {
    const expanded = expandHome(dir);
    // Check if the directory itself is the repo
    if (path.basename(expanded) === repoName && existsSync(expanded)) {
      return expanded;
    }
    // Check subdirectory
    const candidate = path.join(expanded, repoName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bootstrap helpers (FEA-652)
// ---------------------------------------------------------------------------

type BootstrapRepoParam = {
  fullName: string;
  branch?: string;
  localPath?: string;
};

type BootstrapParams = {
  repos: BootstrapRepoParam[];
  options?: {
    depth?: "quick" | "medium" | "deep";
    update?: boolean;
  };
};

type BootstrapManifestEntry = {
  fullName: string;
  localPath: string;
  branch: string;
  skip: boolean;
  skipReason?: string;
};

type BootstrapRepoResult = {
  fullName: string;
  branch: string;
  success: boolean;
  error?: string;
  agents: Array<{
    name: string;
    slug: string;
    role: string;
    description: string;
    prompt: string;
  }>;
  criticGates: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  duration: number;
};

function parseBootstrapParams(
  prompt: string | undefined
): BootstrapParams | null {
  if (!prompt) {
    return null;
  }
  try {
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    if (!Array.isArray(parsed.repos)) {
      return null;
    }
    for (const entry of parsed.repos) {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      if (typeof (entry as Record<string, unknown>).fullName !== "string") {
        return null;
      }
    }
    return parsed as unknown as BootstrapParams;
  } catch {
    return null;
  }
}

function parseAgentFrontmatter(content: string): {
  name: string;
  description: string;
} {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!fmMatch) {
    return { name: "", description: "" };
  }
  const fm = fmMatch[1];

  const nameMatch = /^name:\s*(.+)$/m.exec(fm);
  const descMatch = /^description:\s*(.+)$/m.exec(fm);
  return {
    name: nameMatch?.[1]?.trim() ?? "",
    description: descMatch?.[1]?.trim() ?? "",
  };
}

export function readBootstrapRepoOutputs(
  repoPath: string,
  agentsDir?: string
): Omit<
  BootstrapRepoResult,
  "fullName" | "branch" | "success" | "error" | "duration"
> {
  const agents: BootstrapRepoResult["agents"] = [];
  const effectiveAgentsDir =
    agentsDir ?? path.join(repoPath, ".claude", "agents");
  try {
    for (const file of readdirSync(effectiveAgentsDir)) {
      if (!file.endsWith(".md")) {
        continue;
      }
      const slug = file.slice(0, -3);
      const content = readFileSync(
        path.join(effectiveAgentsDir, file),
        "utf-8"
      );
      const { name, description } = parseAgentFrontmatter(content);
      agents.push({
        name: name || slug,
        slug,
        role: slug,
        description,
        prompt: content,
      });
    }
  } catch {
    // agents dir may not exist
  }

  const criticGatesPath = path.join(
    repoPath,
    ".closedloop-ai",
    "settings",
    "critic-gates.json"
  );
  const criticGates = readJsonFileSync(criticGatesPath) as Record<
    string,
    unknown
  > | null;

  const metadataPath = path.join(
    repoPath,
    ".closedloop-ai",
    "bootstrap-metadata.json"
  );
  const metadata = readJsonFileSync(metadataPath) as Record<
    string,
    unknown
  > | null;

  return { agents, criticGates, metadata };
}

// ---------------------------------------------------------------------------
// ContextPack agent/config materialization
// ---------------------------------------------------------------------------

export async function materializeAgents(
  worktreeDir: string,
  agents: ContextPackAgent[]
): Promise<number> {
  if (agents.length === 0) {
    return 0;
  }

  const agentsDir = path.join(worktreeDir, ".claude", "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  const resolvedAgentsDir = path.resolve(agentsDir);
  let written = 0;
  for (const agent of agents) {
    if (typeof agent.slug !== "string" || typeof agent.prompt !== "string") {
      continue;
    }
    const safeSlug = slugifyLoopId(agent.slug);
    if (!safeSlug) {
      continue;
    }
    const filePath = path.resolve(agentsDir, `${safeSlug}.md`);
    if (!filePath.startsWith(resolvedAgentsDir + path.sep)) {
      continue;
    }
    let content = agent.prompt;
    if (!content.endsWith("\n")) {
      content += "\n";
    }
    await fs.writeFile(filePath, content, "utf-8");
    written++;
  }

  return written;
}

export async function materializeCriticGates(
  worktreeDir: string,
  repoFullName: string,
  repoConfigs: ContextPackRepoConfig[]
): Promise<boolean> {
  const config = repoConfigs.find((c) => c.repoFullName === repoFullName);
  if (!config) {
    return false;
  }

  const settingsDir = path.join(worktreeDir, ".closedloop-ai", "settings");
  await fs.mkdir(settingsDir, { recursive: true });

  const filePath = path.join(settingsDir, "critic-gates.json");
  await fs.writeFile(
    filePath,
    `${JSON.stringify(config.criticGates, null, 2)}\n`,
    "utf-8"
  );

  return true;
}

async function materializeContextPack(
  worktreeDir: string,
  repoFullName: string | undefined,
  loopId: string,
  agents: ContextPackAgent[] | undefined,
  repoConfigs: ContextPackRepoConfig[] | undefined
): Promise<void> {
  if (agents && agents.length > 0) {
    const n = await materializeAgents(worktreeDir, agents);
    loopLog(loopId, `Materialized ${n} agents to ${worktreeDir}`);
  }
  if (repoConfigs && repoFullName) {
    const wrote = await materializeCriticGates(
      worktreeDir,
      repoFullName,
      repoConfigs
    );
    if (wrote) {
      loopLog(loopId, `Materialized critic-gates for ${repoFullName}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-clone helper
// ---------------------------------------------------------------------------

/** Result of an attempted `gh repo clone` operation. */
export type CloneResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Attempt to clone a GitHub repository via the authenticated `gh` CLI into an
 * allowed sandbox directory, then persist the result to `repos.json`.
 *
 * @param fullName  GitHub repository full name, e.g. `"org/repo"`.
 * @param allowedDirs  List of sandbox-allowed directories (from `getAllowedDirectories()`).
 * @param loopId  The loop request ID, used for scoped log lines.
 * @param configDir  Path to the symphony config directory that holds `repos.json`.
 * @param timeout  Override for the clone timeout (default: `CLONE_GIT_TIMEOUT` = 300 s).
 */
export async function cloneRepoViaGh(
  fullName: string,
  allowedDirs: string[],
  loopId: string,
  configDir: string,
  timeout?: number
): Promise<CloneResult> {
  if (allowedDirs.length === 0) {
    return { ok: false, reason: "no allowed directories configured" };
  }

  // --- compute clone destination ---
  const repoName = fullName.split("/").pop();
  if (!repoName) {
    return { ok: false, reason: `invalid fullName: ${fullName}` };
  }

  const expandedAllowedDir = expandHome(allowedDirs[0]);

  let allowedDirStat: ReturnType<typeof statSync>;
  try {
    allowedDirStat = statSync(expandedAllowedDir);
  } catch {
    return {
      ok: false,
      reason: `allowed directory does not exist or is not a directory: ${expandedAllowedDir}`,
    };
  }
  if (!allowedDirStat.isDirectory()) {
    return {
      ok: false,
      reason: `allowed directory does not exist or is not a directory: ${expandedAllowedDir}`,
    };
  }

  // Clone into the allowed dir as a subdirectory (works whether or not
  // the allowed dir is itself a git repo).
  const destPath = path.join(expandedAllowedDir, repoName);

  if (existsSync(destPath)) {
    return {
      ok: false,
      reason: `clone destination already exists: ${destPath}`,
    };
  }

  // --- pre-clone path validation (fail-fast before any network I/O) ---
  try {
    assertPathAllowed(destPath, allowedDirs);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: sanitizeErrorMessage(raw) };
  }

  // --- log attempt ---
  const attemptMsg = `repository not found locally, attempting to clone via gh: ${fullName} → ${destPath}`;
  loopLog(loopId, attemptMsg);
  gatewayLog.info("loop-auto-clone", `${attemptMsg} loopId=${loopId}`);

  // --- invoke clone ---
  try {
    await execFileAsync(
      getResolvedGhPath(),
      ["repo", "clone", fullName, destPath],
      {
        timeout: timeout ?? CLONE_GIT_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
        env: await getShellEnv(),
      }
    );
  } catch (err) {
    const stderrRaw = String(
      (err as { stderr?: unknown }).stderr ??
        (err instanceof Error ? err.message : String(err))
    )
      .trim()
      .slice(0, 500);
    const sanitizedReason = sanitizeErrorMessage(stderrRaw);
    const failMsg = `clone failed: ${sanitizedReason}`;
    loopError(loopId, failMsg);
    gatewayLog.warn(
      "loop-auto-clone",
      `${failMsg} loopId=${loopId} fullName=${fullName} destPath=${destPath}`
    );
    return { ok: false, reason: sanitizedReason };
  }

  // --- post-clone defense-in-depth path check ---
  try {
    assertPathAllowed(destPath, allowedDirs);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const sanitizedReason = sanitizeErrorMessage(raw);
    // Best-effort cleanup: remove the orphaned clone
    try {
      await fs.rm(destPath, { recursive: true, force: true });
    } catch (cleanupErr) {
      gatewayLog.warn(
        "loop-auto-clone",
        `orphan cleanup failed for ${destPath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
      );
    }
    loopError(
      loopId,
      `post-clone path check failed, cleaned up: ${sanitizedReason}`
    );
    gatewayLog.warn(
      "loop-auto-clone",
      `post-clone path check failed: ${sanitizedReason} loopId=${loopId} fullName=${fullName} destPath=${destPath}`
    );
    return { ok: false, reason: sanitizedReason };
  }

  // --- persist to repos.json ---
  const addResult = await addRepo(destPath, undefined, configDir);
  if (
    !addResult.success &&
    addResult.error !== "Repository already configured"
  ) {
    // non-fatal: log but still return success
    const warnMsg = `addRepo failed after clone (non-fatal): ${addResult.error ?? "unknown error"}`;
    loopError(loopId, warnMsg);
    gatewayLog.warn(
      "loop-auto-clone",
      `${warnMsg} loopId=${loopId} fullName=${fullName} destPath=${destPath}`
    );
  }

  // --- log success ---
  const successMsg = `clone succeeded: ${destPath}`;
  loopLog(loopId, successMsg);
  gatewayLog.info(
    "loop-auto-clone",
    `${successMsg} loopId=${loopId} fullName=${fullName}`
  );

  return { ok: true, path: destPath };
}

// ---------------------------------------------------------------------------
// Additional repos
// ---------------------------------------------------------------------------

/** Shape returned by resolveAdditionalRepos for each validated entry. */
export type ResolvedAdditionalRepo = {
  readonly repoPath: string;
  readonly branch: string;
};

/**
 * Per-additional-repo worktree entry tracked in-process and persisted on
 * `LocalJob`. `fullName` and `baseBranch` are required by recovery to run
 * `finalizeMultiRepoExecute` after a desktop restart; older persisted jobs
 * may lack them.
 */
export type AdditionalWorktreeEntry = {
  dir: string;
  repoPath: string;
  fullName?: string;
  baseBranch?: string;
};

/** Typed error thrown when an additional repo entry fails validation. */
export class AdditionalRepoError extends Error {
  constructor(
    public readonly code: LoopErrorCode,
    public readonly repoRef: string,
    message: string
  ) {
    super(message);
    this.name = "AdditionalRepoError";
  }
}

const ADDITIONAL_REPOS_MAX = 5;

/** Remove only additional-repo worktrees that are clean and safe to discard. */
export async function cleanupAdditionalWorktrees(
  entries: readonly AdditionalWorktreeEntry[],
  loopId: string,
  wt: WorktreeProvider
): Promise<void> {
  for (const entry of entries) {
    if (decideAdditionalWorktreeCleanup(entry.dir, loopId) === "retain") {
      continue;
    }
    try {
      await wt.removeWorktree(entry.dir, entry.repoPath, loopId);
    } catch (err) {
      gatewayLog.warn(
        "cleanup-additional-worktree",
        `removeWorktree failed for ${entry.dir} (loop ${loopId}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Default-provider cleanup helper. Exposed so recovery-time callers that do
 * not own a `WorktreeProvider` (e.g. `boot-recovery.ts`) can reuse the same
 * teardown semantics used on the live path.
 */
export async function cleanupAdditionalWorktreesWithDefaultProvider(
  entries: readonly AdditionalWorktreeEntry[],
  loopId: string
): Promise<void> {
  await cleanupAdditionalWorktrees(entries, loopId, defaultWorktreeProvider);
}

function isEnoentError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}

/** Detect whether an additional-repo worktree carries any code changes. */
function decideAdditionalWorktreeCleanup(
  worktreeDir: string,
  loopId: string
): "retain" | "remove" {
  const gitBin = getResolvedGitPath();

  let uncommitted: string;
  try {
    uncommitted = execFileSync(
      gitBin,
      ["status", "--porcelain", "--", ".", ":!.claude", ":!.closedloop-ai"],
      { cwd: worktreeDir, encoding: "utf-8", stdio: "pipe", timeout: 10_000 }
    ).trim();
  } catch (err) {
    if (isEnoentError(err)) {
      return "remove";
    }
    gatewayLog.warn(
      "cleanup-additional-worktree",
      `git status failed for ${worktreeDir} (loop ${loopId}); retaining worktree to avoid data loss: ${err instanceof Error ? err.message : String(err)}`
    );
    return "retain";
  }
  if (uncommitted.length > 0) {
    gatewayLog.info(
      "cleanup-additional-worktree",
      `Retaining worktree with uncommitted changes: ${worktreeDir} (loop ${loopId})`
    );
    return "retain";
  }

  let comparisonRefs: string[];
  try {
    const refsOut = execFileSync(
      gitBin,
      [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      { cwd: worktreeDir, encoding: "utf-8", stdio: "pipe", timeout: 10_000 }
    );
    comparisonRefs = refsOut
      .split("\n")
      .map((line) => line.trim())
      .filter((ref) => ref.length > 0)
      .filter(
        (ref) =>
          !(
            ref.startsWith("refs/heads/symphony/") ||
            /^refs\/remotes\/[^/]+\/symphony\//.test(ref)
          )
      );
  } catch (err) {
    if (isEnoentError(err)) {
      return "remove";
    }
    gatewayLog.warn(
      "cleanup-additional-worktree",
      `git for-each-ref failed for ${worktreeDir} (loop ${loopId}); retaining worktree to avoid data loss: ${err instanceof Error ? err.message : String(err)}`
    );
    return "retain";
  }

  if (comparisonRefs.length === 0) {
    gatewayLog.warn(
      "cleanup-additional-worktree",
      `No non-symphony refs found in ${worktreeDir} (loop ${loopId}); retaining worktree to avoid data loss`
    );
    return "retain";
  }

  let unique: string;
  try {
    unique = execFileSync(
      gitBin,
      ["rev-list", "-n", "1", "HEAD", "--not", ...comparisonRefs],
      { cwd: worktreeDir, encoding: "utf-8", stdio: "pipe", timeout: 10_000 }
    ).trim();
  } catch (err) {
    if (isEnoentError(err)) {
      return "remove";
    }
    gatewayLog.warn(
      "cleanup-additional-worktree",
      `git rev-list failed for ${worktreeDir} (loop ${loopId}); retaining worktree to avoid data loss: ${err instanceof Error ? err.message : String(err)}`
    );
    return "retain";
  }
  if (unique.length > 0) {
    gatewayLog.info(
      "cleanup-additional-worktree",
      `Retaining worktree with committed changes unique to HEAD: ${worktreeDir} (loop ${loopId})`
    );
    return "retain";
  }

  return "remove";
}

/** Resolve an additional repo entry to a validated local path, or throw. */
function resolveAndValidateRepoPath(
  entry: { localRepoPath?: string; fullName?: string },
  allowedDirs: string[],
  repoRef: string
): string {
  let candidate: string;
  if (entry.localRepoPath) {
    candidate = expandHome(entry.localRepoPath);
  } else if (entry.fullName) {
    const found = findLocalRepo(entry.fullName, allowedDirs);
    if (!found) {
      throw new AdditionalRepoError(
        LoopErrorCode.RepoNotFound,
        entry.fullName,
        `Additional repo not found locally: ${entry.fullName}`
      );
    }
    candidate = found;
  } else {
    throw new AdditionalRepoError(
      LoopErrorCode.RepoNotFound,
      repoRef,
      "Additional repo entry must have localRepoPath or fullName"
    );
  }

  const result = tryAssertRepoAllowed(candidate, allowedDirs);
  if ("error" in result) {
    // Surface fullName explicitly when known so the LoopEvent message names
    // the offending peer rather than a path that may be sanitized in logs.
    const offender = entry.fullName ?? repoRef;
    throw new AdditionalRepoError(
      LoopErrorCode.RepoNotAllowed,
      repoRef,
      `Additional repo path not allowed: ${offender}`
    );
  }
  return result.path;
}

/** Validate and resolve additionalRepos entries. Throws AdditionalRepoError on failure. */
export async function resolveAdditionalRepos(
  entries: NonNullable<LoopRequestBody["additionalRepos"]>,
  allowedDirs: string[],
  wt: WorktreeProvider
): Promise<ResolvedAdditionalRepo[]> {
  if (entries.length === 0) {
    return [];
  }

  if (entries.length > ADDITIONAL_REPOS_MAX) {
    throw new AdditionalRepoError(
      LoopErrorCode.PreRunValidationFailed,
      "",
      `additionalRepos exceeds maximum of ${ADDITIONAL_REPOS_MAX} entries (got ${entries.length})`
    );
  }

  const resolved: ResolvedAdditionalRepo[] = [];

  for (const entry of entries) {
    const repoRef = entry.localRepoPath ?? entry.fullName ?? "";
    const resolvedPath = resolveAndValidateRepoPath(
      entry,
      allowedDirs,
      repoRef
    );
    const canonicalPath = path.resolve(resolvedPath);

    const branchFound = await wt.branchExists(canonicalPath, entry.branch);
    if (!branchFound) {
      // Embed fullName explicitly so the offending peer can be identified
      // from the LoopEvent message alone (resolvedPath may be ambiguous).
      const offender = entry.fullName ?? repoRef;
      throw new AdditionalRepoError(
        LoopErrorCode.PreRunValidationFailed,
        repoRef,
        `Branch "${entry.branch}" not found in additional repo: ${offender}`
      );
    }

    resolved.push({ repoPath: canonicalPath, branch: entry.branch });
  }

  return resolved;
}

function resolveLoopPrimaryFullName(
  body: LoopRequestBody,
  expandedRepoPath: string | null
): string {
  return (
    body.repo?.fullName ??
    (expandedRepoPath ? (resolveRepoFullName(expandedRepoPath) ?? "") : "")
  );
}

function normalizeLoopRepoFullName(value: string): string {
  return value.trim().toLowerCase();
}

function requireVerifiedLoopRepositoryFullName(args: {
  declaredFullName?: string | null;
  repoPath: string;
  role: "primary" | "additional";
}): string {
  const declaredFullName = args.declaredFullName?.trim();
  if (!declaredFullName) {
    throw new Error(`${args.role} repository fullName is required`);
  }
  const resolvedFullName = resolveRepoFullName(args.repoPath);
  if (!resolvedFullName) {
    throw new Error(
      `Unable to resolve ${args.role} repository origin fullName for ${args.repoPath}`
    );
  }
  if (
    normalizeLoopRepoFullName(resolvedFullName) !==
    normalizeLoopRepoFullName(declaredFullName)
  ) {
    throw new Error(
      `${args.role} repository fullName ${declaredFullName} does not match local origin ${resolvedFullName}`
    );
  }
  return declaredFullName;
}

function requireExpectedLoopBranch(args: {
  body: SymphonyLoopRequestBody;
  role: SymphonyBranchMaterializationEntry["role"];
  repositoryFullName: string;
  baseBranch: string;
}): SymphonyBranchMaterializationEntry {
  const materialization = args.body.branchMaterialization;
  if (!materialization) {
    throw new Error("branchMaterialization is required for new loop worktree");
  }
  if (!args.repositoryFullName) {
    throw new Error(
      "repositoryFullName is required to match branchMaterialization"
    );
  }

  const matches = materialization.branches.filter(
    (entry) =>
      entry.role === args.role &&
      normalizeLoopRepoFullName(entry.repositoryFullName) ===
        normalizeLoopRepoFullName(args.repositoryFullName) &&
      entry.baseBranch === args.baseBranch
  );

  if (matches.length === 0) {
    throw new Error(
      `Missing branchMaterialization entry for ${args.role} repo ${args.repositoryFullName} base ${args.baseBranch}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous branchMaterialization entries for ${args.role} repo ${args.repositoryFullName} base ${args.baseBranch}`
    );
  }
  return matches[0];
}

function shouldUseBranchMaterialization(
  body: SymphonyLoopRequestBody
): boolean {
  return body.branchMaterialization !== undefined;
}

async function failBranchCreate(args: {
  body: SymphonyLoopRequestBody;
  apiBaseUrl: string;
  context: OperationRequestContext;
  message: string;
  status?: number;
}): Promise<void> {
  const message = sanitizeLoopErrorMessage(args.message);
  await postLoopEventBounded(
    args.apiBaseUrl,
    args.body.loopId,
    () => args.body.closedLoopAuthToken,
    {
      type: LoopEventType.Error,
      code: LoopErrorCode.BranchCreateFailed,
      message,
    }
  );
  json(args.context, args.status ?? 500, { error: message });
}

async function preflightAdditionalRepoBranchMaterialization(args: {
  resolvedAdditionalRepos: readonly ResolvedAdditionalRepo[];
  worktreeKey: string;
  allowedDirs: string[];
  body: SymphonyLoopRequestBody;
  apiBaseUrl: string;
  context: OperationRequestContext;
  wt: WorktreeProvider;
  reuseStaleWorktree: boolean;
}): Promise<boolean> {
  if (!shouldUseBranchMaterialization(args.body)) {
    return true;
  }

  for (let addIdx = 0; addIdx < args.resolvedAdditionalRepos.length; addIdx++) {
    const addRepo = args.resolvedAdditionalRepos[addIdx];
    const requestEntry = args.body.additionalRepos?.[addIdx];
    const peerOffenderLabel = (): string =>
      requestEntry?.fullName ??
      resolveRepoFullName(addRepo.repoPath) ??
      addRepo.repoPath;
    const baseBranch = addRepo.branch;
    const addRepoSlug = slugifyLoopId(baseBranch);
    const addRepoKey = `${args.worktreeKey}-${addRepoSlug}-${additionalRepoDisambiguator(addRepo.repoPath)}`;
    const canonicalAddWorktreeDir = resolveLoopWorktreeDir(
      addRepo.repoPath,
      addRepoKey
    );

    let expectedBranch: SymphonyBranchMaterializationEntry;
    try {
      const repositoryFullName = requireVerifiedLoopRepositoryFullName({
        declaredFullName: requestEntry?.fullName,
        repoPath: addRepo.repoPath,
        role: "additional",
      });
      expectedBranch = requireExpectedLoopBranch({
        body: args.body,
        role: "additional",
        repositoryFullName,
        baseBranch,
      });
    } catch (err) {
      const msg = sanitizeUnknownError(err);
      const offender = peerOffenderLabel();
      await postLoopEventBounded(
        args.apiBaseUrl,
        args.body.loopId,
        () => args.body.closedLoopAuthToken,
        {
          type: LoopEventType.Error,
          code: LoopErrorCode.BranchCreateFailed,
          message: `Additional repo branch materialization is not available for ${offender}: ${msg}`,
        }
      );
      json(args.context, 500, {
        error: `Additional repo branch materialization is not available for ${offender}: ${msg}`,
      });
      return false;
    }

    const staleAddWorktree = args.wt.findWorktreeForBranch(
      addRepo.repoPath,
      expectedBranch.branchName
    );
    const addWorktreeDir =
      args.reuseStaleWorktree && staleAddWorktree
        ? staleAddWorktree
        : canonicalAddWorktreeDir;
    try {
      assertPathAllowed(addWorktreeDir, args.allowedDirs);
    } catch (err) {
      if (err instanceof DirectoryNotAllowedError) {
        const offender = peerOffenderLabel();
        await postLoopEventBounded(
          args.apiBaseUrl,
          args.body.loopId,
          () => args.body.closedLoopAuthToken,
          {
            type: LoopEventType.Error,
            code: LoopErrorCode.RepoNotAllowed,
            message: `Additional repo worktree path not allowed for ${offender}: ${addWorktreeDir}`,
          }
        );
        json(args.context, 403, {
          error: `Additional repo worktree path not allowed for ${offender}: ${addWorktreeDir}`,
        });
        return false;
      }
      throw err;
    }
  }
  return true;
}

/**
 * Resolve worktree directory for a loop.
 * Uses full untruncated stable ID for directory naming.
 */
function resolveLoopWorktreeDir(
  expandedRepoPath: string,
  stableId: string
): string {
  const repoName = path.basename(expandedRepoPath);
  return path.join(
    resolveWorktreeParentDir(expandedRepoPath),
    `${repoName}-loop-${stableId}`
  );
}

export function additionalRepoDisambiguator(repoPath: string): string {
  return crypto
    .createHash("sha1")
    .update(path.resolve(repoPath))
    .digest("hex")
    .slice(0, 8);
}

/**
 * Slugify a loop ID for worktree/branch naming.
 * Matches ECS harness convention: lowercase, non-alnum to dashes, max 50 chars.
 */
function slugifyLoopId(loopId: string): string {
  return loopId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 50);
}

/**
 * Pick the stable ID for worktree/branch naming.
 * Uses loopId (matching ECS harness branch/run-dir naming).
 */
function pickStableId(body: LoopRequestBody): string {
  return slugifyLoopId(body.loopId);
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

async function ensureWorktreeImpl(
  expandedRepoPath: string,
  worktreeDir: string,
  branchName: string,
  baseBranch: string,
  loopId: string
): Promise<void> {
  const created = await createWorktreeCheckoutImpl(
    expandedRepoPath,
    worktreeDir,
    branchName,
    baseBranch,
    loopId
  );
  if (!created) {
    return;
  }

  await runLoopsSetupScript(worktreeDir, loopId);
}

async function createWorktreeCheckoutImpl(
  expandedRepoPath: string,
  worktreeDir: string,
  branchName: string,
  baseBranch: string,
  _loopId: string
): Promise<boolean> {
  if (existsSync(worktreeDir)) {
    return false;
  }

  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });

  const gitBin = getResolvedGitPath();
  try {
    execSync(`${shellEscape(gitBin)} fetch origin`, {
      cwd: expandedRepoPath,
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch {
    // non-fatal
  }

  // Resolve base ref
  let baseRef = `origin/${baseBranch}`;
  try {
    execSync(
      `${shellEscape(gitBin)} rev-parse --verify ${shellEscape(baseRef)}`,
      {
        cwd: expandedRepoPath,
        stdio: "pipe",
        timeout: 10_000,
      }
    );
  } catch {
    baseRef = baseBranch;
  }

  execSync(
    `${shellEscape(gitBin)} worktree add -B ${shellEscape(branchName)} ${shellEscape(worktreeDir)} ${shellEscape(baseRef)}`,
    {
      cwd: expandedRepoPath,
      stdio: "pipe",
      timeout: 30_000,
    }
  );

  return true;
}

async function ensureLoopWorktreeMaterialized(args: {
  expandedRepoPath: string;
  worktreeDir: string;
  branchName: string;
  baseBranch: string;
  loopId: string;
  repositoryFullName: string;
  apiBaseUrl: string;
  token: string;
  wt?: WorktreeProvider;
}): Promise<void> {
  if (args.wt && args.wt !== defaultWorktreeProvider) {
    throw new Error(
      "branch materialization requires the default worktree provider"
    );
  }

  if (existsSync(args.worktreeDir)) {
    loopLog(
      args.loopId,
      `Removing stale loop worktree path before branch materialization: ${args.worktreeDir}`
    );
    await defaultWorktreeProvider.removeWorktree(
      args.worktreeDir,
      args.expandedRepoPath,
      args.loopId
    );
  }

  const created = await createWorktreeCheckoutImpl(
    args.expandedRepoPath,
    args.worktreeDir,
    args.branchName,
    args.baseBranch,
    args.loopId
  );
  if (!created) {
    throw new Error(
      `Failed to create fresh loop worktree at ${args.worktreeDir}`
    );
  }

  await pushAndRecordLoopBranch(args);
  await runLoopsSetupScript(args.worktreeDir, args.loopId);
}

async function ensureLoopWorktreeForRequest(args: {
  body: SymphonyLoopRequestBody;
  expandedRepoPath: string;
  worktreeDir: string;
  branchName: string;
  baseBranch: string;
  loopId: string;
  repositoryFullName: string;
  apiBaseUrl: string;
  token: string;
  wt: WorktreeProvider;
}): Promise<void> {
  if (shouldUseBranchMaterialization(args.body)) {
    await ensureLoopWorktreeMaterialized(args);
    return;
  }

  await args.wt.ensureWorktree(
    args.expandedRepoPath,
    args.worktreeDir,
    args.branchName,
    args.baseBranch,
    args.loopId
  );
}

async function pushAndRecordLoopBranch(args: {
  expandedRepoPath: string;
  worktreeDir: string;
  branchName: string;
  baseBranch: string;
  loopId: string;
  repositoryFullName: string;
  apiBaseUrl: string;
  token: string;
}): Promise<void> {
  const gitBin = getResolvedGitPath();
  const headSha = await runGitForMaterialization(
    gitBin,
    ["rev-parse", "HEAD"],
    args.worktreeDir,
    "resolve branch HEAD",
    10_000
  );
  const defaultBranch = await resolveOriginDefaultBranch(
    gitBin,
    args.expandedRepoPath,
    args.baseBranch
  );

  await runGitForMaterialization(
    gitBin,
    ["push", "-u", "origin", args.branchName],
    args.worktreeDir,
    "push loop branch",
    60_000
  );

  const url = `${args.apiBaseUrl}/loops/${args.loopId}/branch-artifact`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repositoryFullName: args.repositoryFullName,
          branchName: args.branchName,
          baseBranch: args.baseBranch,
          defaultBranch,
          headSha,
        }),
      },
      60_000
    );
  } catch (err) {
    throw new Error(
      `Failed to record loop branch artifact: ${sanitizeUnknownError(err)}`
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Failed to record loop branch artifact: HTTP ${resp.status} ${resp.statusText} ${sanitizeLoopErrorMessage(body)}`.trim()
    );
  }
}

async function runGitForMaterialization(
  gitBin: string,
  args: string[],
  cwd: string,
  action: string,
  timeoutMs: number
): Promise<string> {
  try {
    const result = await execFileAsync(gitBin, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return result.stdout.trim();
  } catch (err) {
    throw new Error(`Failed to ${action}: ${sanitizeUnknownError(err)}`);
  }
}

async function resolveOriginDefaultBranch(
  gitBin: string,
  repoPath: string,
  baseBranch: string
): Promise<string> {
  try {
    const result = await execFileAsync(
      gitBin,
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      {
        cwd: repoPath,
        encoding: "utf8",
        timeout: 10_000,
      }
    );
    const branch = result.stdout.trim().replace(/^origin\//, "");
    return branch || baseBranch;
  } catch {
    return baseBranch;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Check whether a branch exists locally or on the remote. */
async function branchExistsImpl(
  repoPath: string,
  branch: string
): Promise<boolean> {
  fetchOrigin(repoPath);
  return resolveRef(repoPath, branch) !== null;
}

// findExistingLoopWorktree was removed — it greedy-matched ANY loop worktree
// from ANY prior loop, causing new PLAN loops to reuse stale worktrees.
// PLAN always creates a fresh worktree. EXECUTE/REQUEST_CHANGES reuse via
// findWorktreeForBranch(parentBranchName) which matches the specific parent.

/**
 * Remove a worktree via git worktree remove, falling back to
 * fs.rm + git worktree prune. Used from both handleProcessCompletion and
 * early-return cleanup in handleLoopRequest.
 */
async function removeWorktreeImpl(
  worktreeDir: string,
  expandedRepoPath: string,
  loopId?: string
): Promise<void> {
  const gitBin = getResolvedGitPath();
  try {
    execSync(
      `${shellEscape(gitBin)} worktree remove --force ${shellEscape(worktreeDir)}`,
      {
        cwd: expandedRepoPath,
        stdio: "pipe",
        timeout: 15_000,
      }
    );
  } catch {
    if (loopId) {
      loopLog(
        loopId,
        "git worktree remove failed for GENERATE_PRD, falling back to fs.rm"
      );
    }
    await fs.rm(worktreeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    try {
      execSync(`${shellEscape(gitBin)} worktree prune`, {
        cwd: expandedRepoPath,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {
      // Best-effort
    }
  }
}

/** Read the current branch name from a worktree directory. */
function getCurrentBranchImpl(worktreeDir: string): string | null {
  try {
    return (
      execSync(
        `${shellEscape(getResolvedGitPath())} rev-parse --abbrev-ref HEAD`,
        {
          cwd: worktreeDir,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 5000,
        }
      ).trim() || null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-command artifact writing
// ---------------------------------------------------------------------------

/**
 * Download attachment files under the command's runtime attachment root.
 * Non-fatal: logs warnings and skips individual failures without aborting.
 */
async function downloadAttachmentsToDisk(
  claudeWorkDir: string,
  attachments?: ContextPackAttachment[],
  options?: { useEvaluateRuntimePath?: boolean }
): Promise<void> {
  if (!attachments || attachments.length === 0) {
    return;
  }

  const attachmentsDir = options?.useEvaluateRuntimePath
    ? path.join(claudeWorkDir, EVALUATE_ATTACHMENTS_DIR)
    : path.join(claudeWorkDir, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });
  const skippedAttachments: Array<{
    id: string;
    reason: string;
  }> = [];

  for (const attachment of attachments) {
    try {
      const expiresAt = new Date(attachment.signedUrlExpiresAt);
      if (expiresAt <= new Date()) {
        gatewayLog.warn(
          "loop-attachment",
          `Attachment ${attachment.id} signedUrl expired at ${attachment.signedUrlExpiresAt}, skipping`
        );
        continue;
      }

      const safeName = path
        .basename(attachment.filename)
        .replaceAll(/[^a-zA-Z0-9._-]/g, "_");
      const diskName = `${attachment.id}-${safeName}`;
      const diskPath = path.resolve(attachmentsDir, diskName);

      if (
        !diskPath.startsWith(attachmentsDir + path.sep) &&
        diskPath !== attachmentsDir
      ) {
        gatewayLog.warn(
          "loop-attachment",
          `Attachment ${attachment.id} resolved path escapes attachmentsDir, skipping`
        );
        continue;
      }

      const policyDecision = validateOutboundUrlForSurface(
        "loop_attachment_download",
        attachment.signedUrl
      );
      if (!policyDecision.allowed) {
        Observability.outboundNetworkDecision(policyDecision.diagnostics);
        skippedAttachments.push({
          id: attachment.id,
          reason: policyDecision.diagnostics.reason,
        });
        gatewayLog.warn(
          "loop-attachment",
          `Attachment ${attachment.id} denied by outbound policy: ${policyDecision.diagnostics.reason}`
        );
        continue;
      }

      Observability.outboundNetworkDecision(policyDecision.diagnostics);
      const response = await fetch(attachment.signedUrl, { redirect: "error" });
      if (!response.ok) {
        gatewayLog.warn(
          "loop-attachment",
          `Attachment ${attachment.id} fetch failed: ${response.status} ${response.statusText}, skipping`
        );
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > attachment.sizeBytes) {
        gatewayLog.warn(
          "loop-attachment",
          `Attachment ${attachment.id} buffer size ${buffer.length} exceeds declared sizeBytes ${attachment.sizeBytes}, skipping`
        );
        continue;
      }
      if (buffer.length < attachment.sizeBytes) {
        gatewayLog.warn(
          "loop-attachment",
          `Attachment ${attachment.id} downloaded ${buffer.length} bytes but expected ${attachment.sizeBytes}, may be truncated -- writing anyway`
        );
      }

      writeFileSync(diskPath, buffer);
    } catch (err) {
      gatewayLog.warn(
        "loop-attachment",
        `Failed to download attachment ${attachment.id}: ${formatAttachmentDownloadError(err)}`
      );
    }
  }

  if (skippedAttachments.length > 0) {
    await fs.writeFile(
      path.join(claudeWorkDir, SKIPPED_ATTACHMENTS_WARNING_FILE),
      JSON.stringify(
        {
          skippedAttachments,
          allAttachmentsSkipped:
            skippedAttachments.length === attachments.length,
        },
        null,
        2
      )
    );
  }
}

function formatAttachmentDownloadError(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return typeof error;
}

/**
 * Write PRD for PLAN command.
 * Matches ECS harness writePrdFile(): prompt first, then PRD artifact, then FEATURE.
 */
async function writeArtifactsForPlan(
  claudeWorkDir: string,
  artifacts: LoopArtifact[],
  prdContent: string | null = null,
  userContext?: string,
  attachments?: ContextPackAttachment[]
): Promise<void> {
  // Priority: explicit prompt > PRD artifact > FEATURE artifact (matches harness)

  if (!prdContent) {
    const prdArtifact = artifacts.find((a) => a.type === LoopArtifactType.Prd);
    const featureArtifact = prdArtifact
      ? null
      : artifacts.find((a) => a.type === LoopArtifactType.Feature);
    const source = prdArtifact ?? featureArtifact;
    if (source?.content) {
      prdContent = source.content;
    }
  }

  // Append user-supplied Additional Context to the PRD so the planning agent
  // sees it as part of the requirements (guaranteed to be read). Written as a
  // clearly delineated section at the end of prd.md.
  const safeUserContext =
    typeof userContext === "string" ? userContext.trim() : "";
  if (safeUserContext) {
    const section =
      "\n\n---\n\n## User Context / Additional Constraints\n\n" +
      safeUserContext +
      "\n";
    prdContent = prdContent ? prdContent + section : section;
  }

  if (prdContent) {
    await fs.writeFile(
      path.join(claudeWorkDir, LoopArtifactFile.Prd),
      prdContent
    );
  }

  await downloadAttachmentsToDisk(claudeWorkDir, attachments);
}

/** @internal Exported for testing only. */
export async function writeArtifactsForExecuteOrAmend(
  claudeWorkDir: string,
  artifacts: LoopArtifact[],
  prompt?: string,
  attachments?: ContextPackAttachment[],
  options?: {
    command: "EXECUTE" | "REQUEST_CHANGES";
    loopId: string;
    commandId?: string;
    operationId?: string;
  }
): Promise<{ importedPlanFile: string | null }> {
  if (options !== undefined && options.command === LoopCommand.Execute) {
    await fs.rm(path.join(claudeWorkDir, LoopArtifactFile.ExecutionResult), {
      force: true,
    });
  }
  let importedPlanFile: string | null = null;
  for (const artifact of artifacts) {
    if (artifact.type === LoopArtifactType.ImplementationPlan) {
      // For EXECUTE, hosted markdown is canonical. Reuse remote raw plan state
      // only when it still matches that markdown; otherwise force the
      // imported-plan compatibility path from the hosted markdown.
      const planJsonPath = path.join(claudeWorkDir, LoopArtifactFile.Plan);
      if (options !== undefined && options.command === LoopCommand.Execute) {
        const rawPlanPayload = isRawPlanArtifact(artifact.raw)
          ? artifact.raw
          : null;
        const rawPlanContent =
          typeof rawPlanPayload?.content === "string"
            ? rawPlanPayload.content
            : undefined;
        const rawPlanAligned =
          rawPlanContent !== undefined && rawPlanContent === artifact.content;
        const localPlanJsonPresent = existsSync(planJsonPath);
        const localPlanJsonAligned =
          localPlanJsonPresent &&
          readPlanJsonContent(planJsonPath) === artifact.content;
        const importedPlanPath = path.join(
          claudeWorkDir,
          IMPORTED_PLAN_MARKDOWN_FILE
        );
        await fs.rm(importedPlanPath, { force: true });
        const basePlanSource = {
          rawPlanPayload: rawPlanPayload !== null,
          rawPlanAligned,
          localPlanJsonPresent,
          localPlanJsonAligned,
          planArtifactContentLength: artifact.content.length,
          rawPlanContentLength: rawPlanContent?.length ?? null,
          planArtifactContentHash: shortContentHash(artifact.content),
          rawPlanContentHash: shortContentHash(rawPlanContent),
        };
        const emitPlanSource = (
          source: ExecutePlanSourceDiagnostics["source"],
          importedPlanFileStaged: boolean,
          closedLoopPlanFileSet: boolean
        ): void => {
          Observability.jobPlanSourceResolved(
            options.commandId,
            options.operationId,
            options.loopId,
            {
              source,
              ...basePlanSource,
              importedPlanFileStaged,
              closedLoopPlanFileSet,
            }
          );
        };

        if (rawPlanAligned) {
          importedPlanFile = null;
          await fs.writeFile(
            planJsonPath,
            JSON.stringify(
              { ...rawPlanPayload!, content: artifact.content },
              null,
              2
            )
          );
          const message =
            "EXECUTE plan source=raw-artifact " +
            "rawPlanPayload=true rawPlanAligned=true " +
            `localPlanJsonPresent=${localPlanJsonPresent}`;
          loopLog(options.loopId, message);
          gatewayLog.info(
            "loop-harness",
            `loopId=${options.loopId} ${message}`
          );
          emitPlanSource("raw-artifact", false, false);
        } else if (localPlanJsonAligned) {
          importedPlanFile = null;
          const message =
            "EXECUTE plan source=local-plan-json " +
            `rawPlanPayload=${rawPlanPayload !== null} rawPlanAligned=false ` +
            "localPlanJsonPresent=true localPlanJsonAligned=true";
          loopLog(options.loopId, message);
          gatewayLog.info(
            "loop-harness",
            `loopId=${options.loopId} ${message}`
          );
          emitPlanSource("local-plan-json", false, false);
        } else {
          if (localPlanJsonPresent) {
            await fs.rm(planJsonPath, { force: true });
          }
          importedPlanFile = importedPlanPath;
          await fs.writeFile(importedPlanPath, artifact.content);
          const message =
            "EXECUTE plan source=imported-plan-compat " +
            `rawPlanPayload=${rawPlanPayload !== null} rawPlanAligned=false ` +
            `localPlanJsonPresent=${localPlanJsonPresent} ` +
            `localPlanJsonAligned=${localPlanJsonAligned} ` +
            `importedPlanFile=${importedPlanFile}`;
          loopLog(options.loopId, message);
          gatewayLog.info(
            "loop-harness",
            `loopId=${options.loopId} ${message}`
          );
          emitPlanSource("imported-plan-compat", true, true);
        }
        continue;
      }

      // When artifact.content is not valid JSON it is raw markdown from an
      // older gateway; write it to plan-source.md so the plugin can import it.
      if (!isValidJson(artifact.content)) {
        const planSourcePath = path.join(
          claudeWorkDir,
          PLAN_SOURCE_MARKDOWN_FILE
        );
        await fs.rm(planJsonPath, { force: true });
        await fs.writeFile(planSourcePath, artifact.content);
        importedPlanFile = planSourcePath;
      } else if (existsSync(planJsonPath)) {
        try {
          const existing = JSON.parse(
            readFileSync(planJsonPath, "utf-8")
          ) as Record<string, unknown>;
          existing.content = artifact.content;
          await fs.writeFile(planJsonPath, JSON.stringify(existing, null, 2));
        } catch {
          // If existing plan.json is corrupt, overwrite entirely
          if (isRawPlanArtifact(artifact.raw)) {
            await fs.writeFile(
              planJsonPath,
              JSON.stringify(
                { ...artifact.raw, content: artifact.content },
                null,
                2
              )
            );
          } else {
            await fs.writeFile(planJsonPath, artifact.content);
          }
        }
      } else {
        // No existing plan.json — prefer the uploaded raw plan state when the
        // worktree was recreated from a later desktop resume.
        if (isRawPlanArtifact(artifact.raw)) {
          await fs.writeFile(
            planJsonPath,
            JSON.stringify(
              { ...artifact.raw, content: artifact.content },
              null,
              2
            )
          );
        } else {
          // artifact.content is valid JSON (checked above), write directly.
          await fs.writeFile(planJsonPath, artifact.content);
        }
      }
    } else if (
      artifact.type === LoopArtifactType.Prd ||
      artifact.type === LoopArtifactType.Feature
    ) {
      await fs.writeFile(
        path.join(claudeWorkDir, LoopArtifactFile.Prd),
        artifact.content
      );
    }
  }
  if (prompt) {
    await fs.writeFile(path.join(claudeWorkDir, "prompt.md"), prompt);
  }

  await downloadAttachmentsToDisk(claudeWorkDir, attachments);
  return { importedPlanFile };
}

/**
 * Write context pack files for GENERATE_PRD and REQUEST_PRD_CHANGES commands.
 * Mirrors writeContextPackFiles in harness-agent.mjs (lines 744-816).
 * Files go under worktreeDir/.closedloop-ai/context/ (NOT claudeWorkDir).
 */
async function writeArtifactsForGeneratePrd(
  worktreeDir: string,
  artifacts: LoopArtifact[],
  prompt: string,
  repo?: unknown,
  additionalWorktrees: ReadonlyArray<AdditionalWorktreeEntry> = []
): Promise<void> {
  const contextDir = path.join(worktreeDir, ".closedloop-ai", "context");
  const artifactsDir = path.join(contextDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  // Write prompt
  await fs.writeFile(path.join(contextDir, "prompt.md"), prompt);

  // Write repo-info.json when present
  if (repo) {
    await fs.writeFile(
      path.join(contextDir, "repo-info.json"),
      JSON.stringify(repo, null, 2)
    );
  }

  // Write peer-repos.json so the agent can discover peer mounts by structured
  // metadata (mirrors the ECS harness's writeContextPackFiles peer manifest).
  // No-op when there are no peers.
  await writePeerReposManifest(
    contextDir,
    toPeerWorktreeRefs(additionalWorktrees)
  );

  // Write each artifact
  for (const artifact of artifacts) {
    const safeName = artifact.type
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]/g, "_");
    const safeId = (artifact.id ?? "unknown").replaceAll(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );
    const header = `# ${artifact.title ?? "Untitled"}\n\n`;
    await fs.writeFile(
      path.join(artifactsDir, `${safeName}-${safeId}.md`),
      header + artifact.content
    );
  }
}

/**
 * Materialize FEA-585 evaluate context into the same runtime tree passed to
 * judges:run-judges. The helper is local to Desktop until loops-api publishes
 * the expanded request contract.
 */
async function materializeEvaluateRuntimeContext(
  claudeWorkDir: string,
  body: SymphonyLoopRequestBody,
  expandedRepoPath: string | null
): Promise<void> {
  const contextDir = path.join(claudeWorkDir, EVALUATE_CONTEXT_DIR);
  let contextDirCreated = false;

  async function ensureContextDir(): Promise<string> {
    if (!contextDirCreated) {
      await fs.mkdir(contextDir, { recursive: true });
      contextDirCreated = true;
    }
    return contextDir;
  }

  if (body.prompt?.trim()) {
    await fs.writeFile(
      path.join(await ensureContextDir(), "prompt.md"),
      body.prompt
    );
  }

  const repoInfo = buildEvaluateRepoInfo(body, expandedRepoPath);
  if (repoInfo !== null) {
    await fs.writeFile(
      path.join(await ensureContextDir(), "repo-info.json"),
      JSON.stringify(repoInfo, null, 2)
    );
  }

  if (body.priorLoopSummaries !== undefined) {
    await fs.writeFile(
      path.join(await ensureContextDir(), "prior-loop-summaries.json"),
      JSON.stringify(body.priorLoopSummaries, null, 2)
    );
  }

  if (body.supportingArtifacts.length > 0) {
    await writeEvaluateSupportingArtifacts(
      path.join(await ensureContextDir(), "artifacts"),
      body.supportingArtifacts
    );
  }

  if (body.command === LoopCommand.EvaluateCode) {
    await fs.writeFile(
      path.join(await ensureContextDir(), "code-context.json"),
      JSON.stringify(buildCodeContextFile(body, expandedRepoPath), null, 2)
    );
  }

  await downloadAttachmentsToDisk(claudeWorkDir, body.attachments, {
    useEvaluateRuntimePath: true,
  });
}

function buildEvaluateRepoInfo(
  body: SymphonyLoopRequestBody,
  expandedRepoPath: string | null
): Record<string, unknown> | null {
  const repoInfo: Record<string, unknown> = {};
  if (body.repo) {
    repoInfo.repo = body.repo;
  }
  if (expandedRepoPath) {
    repoInfo.localRepoPath = expandedRepoPath;
  }
  return Object.keys(repoInfo).length > 0 ? repoInfo : null;
}

async function writeEvaluateSupportingArtifacts(
  artifactsDir: string,
  artifacts: readonly SymphonyLoopSupportingArtifact[]
): Promise<void> {
  await fs.mkdir(artifactsDir, { recursive: true });
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    const filename = buildSupportingArtifactFilename(artifact, index);
    const artifactPath = path.resolve(artifactsDir, filename);
    if (!isPathWithinDirectory(artifactPath, artifactsDir)) {
      throw new Error(
        `Supporting artifact ${artifact.id ?? index} path escapes context directory`
      );
    }
    await fs.writeFile(artifactPath, artifact.content);
  }
}

function buildSupportingArtifactFilename(
  artifact: SymphonyLoopSupportingArtifact,
  index: number
): string {
  const typeSlug = sanitizePathSegment(artifact.type ?? "artifact");
  const idSlug = sanitizePathSegment(
    artifact.id ?? artifact.title ?? `item-${index}`
  );
  const suppliedName = artifact.filename ?? artifact.fileName;
  const suppliedExt = suppliedName
    ? path.extname(path.basename(suppliedName))
    : "";
  const ext =
    suppliedExt && /^[.][A-Za-z0-9]+$/.test(suppliedExt)
      ? suppliedExt.toLowerCase()
      : ".md";
  return `${String(index).padStart(3, "0")}-${typeSlug}-${idSlug}${ext}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return sanitized || "item";
}

function isPathWithinDirectory(filePath: string, directory: string): boolean {
  const resolvedDir = path.resolve(directory);
  return (
    filePath === resolvedDir || filePath.startsWith(resolvedDir + path.sep)
  );
}

function buildCodeContextFile(
  body: SymphonyLoopRequestBody,
  expandedRepoPath: string | null
): CodeContextFile {
  const provided =
    body.codeEvaluationContext ?? ({} as Partial<CodeContextFile>);
  const codeContext: CodeContextFile = { schemaVersion: 1 };

  if (provided.repo === undefined) {
    const repo = buildCodeContextRepo(body);
    if (repo !== null) {
      codeContext.repo = repo;
    }
  } else {
    codeContext.repo = provided.repo;
  }

  if (expandedRepoPath !== null) {
    codeContext.localRepoPath = expandedRepoPath;
  }

  const parentBranchName =
    provided.parentBranchName ?? body.parentBranchName ?? null;
  if (parentBranchName !== null) {
    codeContext.parentBranchName = parentBranchName;
  }

  const parentSessionId =
    provided.parentSessionId ?? body.parentSessionId ?? null;
  if (parentSessionId !== null) {
    codeContext.parentSessionId = parentSessionId;
  }

  const artifactSlug = provided.artifactSlug ?? body.artifactSlug ?? null;
  if (artifactSlug !== null) {
    codeContext.artifactSlug = artifactSlug;
  }

  if (provided.pullRequest !== undefined) {
    codeContext.pullRequest = provided.pullRequest;
  }

  const detected =
    expandedRepoPath === null
      ? provided.detected
      : {
          ...(provided.detected ?? {}),
          ...detectGitContext(expandedRepoPath),
        };
  if (detected !== undefined) {
    codeContext.detected = detected;
  }

  return codeContext;
}

function buildCodeContextRepo(
  body: SymphonyLoopRequestBody
): NonNullable<CodeContextFile["repo"]> | null {
  if (!body.repo) {
    return null;
  }
  const repo: NonNullable<CodeContextFile["repo"]> = {};
  if (body.repo.fullName !== undefined) {
    repo.fullName = body.repo.fullName;
  }
  if (body.repo.branch !== undefined) {
    repo.branch = body.repo.branch;
  }
  return Object.keys(repo).length > 0 ? repo : null;
}

function detectGitContext(
  repoPath: string
): NonNullable<CodeContextFile["detected"]> {
  const detected: NonNullable<CodeContextFile["detected"]> = {};
  const errors: string[] = [];

  const branchResult = readGitMetadata(repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (branchResult.ok) {
    detected.branch = branchResult.value;
  } else {
    errors.push(`branch: ${branchResult.error}`);
  }

  const headResult = readGitMetadata(repoPath, ["rev-parse", "HEAD"]);
  if (headResult.ok) {
    detected.headSha = headResult.value;
  } else {
    errors.push(`headSha: ${headResult.error}`);
  }

  detected.gitDetectionError = errors.length > 0 ? errors.join("; ") : null;
  return detected;
}

function readGitMetadata(
  repoPath: string,
  args: readonly string[]
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const output = execFileSync(getResolvedGitPath(), [...args], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();
    return { ok: true, value: output };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeErrorMessage(
        err instanceof Error ? err.message : String(err)
      ),
    };
  }
}
// ---------------------------------------------------------------------------
// Per-command output reading
// ---------------------------------------------------------------------------

function readPlanOutputs(claudeWorkDir: string): LoopOutputArtifacts {
  const plan = toUploadedPlanArtifact(
    readJsonFileSync(path.join(claudeWorkDir, LoopArtifactFile.Plan))
  );
  const openQuestions = readTextFile(
    path.join(claudeWorkDir, LoopArtifactFile.OpenQuestions)
  );
  const judges = readJsonFileSync(
    path.join(claudeWorkDir, LoopArtifactFile.Judges)
  );

  return {
    [LoopOutputArtifactKey.Plan]: plan ?? undefined,
    [LoopOutputArtifactKey.OpenQuestions]: openQuestions ?? undefined,
    [LoopOutputArtifactKey.Judges]: judges ?? undefined,
  };
}

function readExecuteOutputs(claudeWorkDir: string): LoopOutputArtifacts {
  const plan = readExecutePlanArtifact(claudeWorkDir);
  const executionResult = readJsonFileSync(
    path.join(claudeWorkDir, LoopArtifactFile.ExecutionResult)
  );
  const codeJudges = readJsonFileSync(
    path.join(claudeWorkDir, LoopArtifactFile.CodeJudges)
  );

  return {
    [LoopOutputArtifactKey.Plan]: plan ?? undefined,
    [LoopOutputArtifactKey.ExecutionResult]: executionResult ?? undefined,
    [LoopOutputArtifactKey.CodeJudges]: codeJudges ?? undefined,
  };
}

function parseWarningEntries(warning: string | undefined): string[] {
  if (!warning) {
    return [];
  }

  return warning
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function mergeWarningEntries(
  existingWarning: string | undefined,
  warnings: readonly string[]
): string | undefined {
  if (warnings.length === 0) {
    return existingWarning;
  }

  const mergedWarnings = [
    ...new Set([...parseWarningEntries(existingWarning), ...warnings]),
  ];
  return mergedWarnings.map(sanitizeErrorMessage).join("; ");
}

function readDecomposeOutputs(workDir: string): LoopOutputArtifacts {
  const features = readJsonFileSync(
    path.join(workDir, LoopArtifactFile.Features)
  );
  return { [LoopOutputArtifactKey.Features]: features ?? undefined };
}

function readGeneratePrdOutputs(worktreeDir: string): LoopOutputArtifacts {
  const prdContent = readTextFile(path.join(worktreeDir, LoopArtifactFile.Prd));
  return {
    [LoopOutputArtifactKey.Prd]: prdContent
      ? { content: prdContent }
      : undefined,
  };
}

export function readBootstrapOutputs(
  claudeWorkDir: string
): LoopOutputArtifacts {
  const manifestFile = path.join(claudeWorkDir, "bootstrap-manifest.json");
  const manifest = readJsonFileSync(manifestFile) as
    | BootstrapManifestEntry[]
    | null;
  if (!manifest) {
    return {};
  }

  const repos: BootstrapRepoResult[] = [];
  let runnableIndex = 0;
  for (const entry of manifest) {
    if (entry.skip) {
      repos.push({
        fullName: entry.fullName,
        branch: entry.branch ?? "main",
        success: false,
        error: entry.skipReason ?? "skipped",
        agents: [],
        criticGates: null,
        metadata: null,
        duration: 0,
      });
      continue;
    }

    const markerPath = path.join(claudeWorkDir, `repo-${runnableIndex}-done`);
    const marker = readTextFile(markerPath)?.trim() ?? "fail:unknown";
    const success = marker === "ok";
    const error = success ? undefined : marker.replace(/^fail:/, "");

    const outputDir = path.join(claudeWorkDir, `repo-${runnableIndex}-agents`);
    const outputs = readBootstrapRepoOutputs(entry.localPath, outputDir);
    const hasAgents = outputs.agents.length > 0;

    repos.push({
      fullName: entry.fullName,
      branch: entry.branch ?? "main",
      success: success || hasAgents,
      error: hasAgents && !success ? `partial:${error}` : error,
      ...(success || hasAgents
        ? outputs
        : { agents: [], criticGates: null, metadata: null }),
      duration: 0,
    });
    runnableIndex += 1;
  }

  const result = { repos, totalDuration: 0 };
  return { [LoopOutputArtifactKey.BootstrapResult]: result };
}

// ---------------------------------------------------------------------------
// Failure diagnostics helpers
// ---------------------------------------------------------------------------

/**
 * Patterns matching common credential / secret formats.
 * Applied to log tail before including in telemetry events.
 * Each entry is a [pattern, replacement] tuple with a string replacement.
 */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  // Credential-bearing HTTPS remotes: https://user:token@github.com/owner/repo.git
  [
    /\bhttps:\/\/[^:\s/@]+:[^@\s/]+@([^/\s]+\/[^\s"'<>]+)/gi,
    "https://[REDACTED]@$1",
  ],
  // AWS keys: AKIA... style (20 uppercase alphanum after AKIA/ASIA/AROA prefix)
  [/\b(AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]"],
  // Generic bearer / API tokens: "Bearer <token>"
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  // sk- prefixed API keys (OpenAI, Anthropic, etc.)
  [/\bsk-[A-Za-z0-9\-_]{10,}/g, "[REDACTED_SK_KEY]"],
  // GitHub personal access tokens and installation tokens.
  [/\b(ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH_TOKEN]"],
  // Generic "password=..." or "secret=..." in query strings / env
  [
    /\b(password|secret|passwd|api_key|apikey|auth_token|access_token|token|client_secret)=[^\s&"']+/gi,
    "$1=[REDACTED]",
  ],
];

/**
 * Apply credential-pattern filters to redact common secret formats from a string.
 */
function redactCredentials(text: string): string {
  let result = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function sanitizeLoopErrorMessage(message: string): string {
  return redactCredentials(sanitizeErrorMessage(message));
}

function messageFromUnknownError(err: unknown): string {
  if (err instanceof Error) {
    const details: string[] = [err.message];
    const maybeOutput = err as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      signal?: unknown;
    };
    if (typeof maybeOutput.stderr === "string" && maybeOutput.stderr.trim()) {
      details.push(maybeOutput.stderr.trim());
    }
    if (typeof maybeOutput.stdout === "string" && maybeOutput.stdout.trim()) {
      details.push(maybeOutput.stdout.trim());
    }
    if (maybeOutput.code !== undefined) {
      details.push(`exit code ${String(maybeOutput.code)}`);
    }
    if (maybeOutput.signal !== undefined) {
      details.push(`signal ${String(maybeOutput.signal)}`);
    }
    return details.join("; ");
  }
  return String(err);
}

function sanitizeUnknownError(err: unknown): string {
  return sanitizeLoopErrorMessage(messageFromUnknownError(err));
}

/**
 * Redact spawn args to avoid leaking user prompt/code content into telemetry.
 * Replaces long args (likely prompt text) and values following message/prompt flags.
 */
function redactSpawnArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    if (arg.length > 200) {
      return "[REDACTED_LONG_ARG]";
    }
    // Redact values after --message, --prompt, -p flags
    if (i > 0) {
      const prev = args[i - 1];
      if (prev === "--message" || prev === "--prompt" || prev === "-p") {
        return "[REDACTED]";
      }
    }
    return arg;
  });
}

/**
 * Collect failure diagnostics for a failed loop process.
 * Returns an object suitable for inclusion in the error telemetry event.
 */
function collectFailureDiagnostics(claudeWorkDir: string): {
  logTail: string | undefined;
  stderrTail: string | undefined;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  tokensByModel: Record<string, ModelTokenUsage>;
  diagnosticsVersion: number;
} {
  const logPath = path.join(claudeWorkDir, "symphony-loop.log");
  const rawTail = readLogTail(logPath);
  const logTail = rawTail ? redactCredentials(stripAnsi(rawTail)) : undefined;
  const rawStderr = readStderrTail(claudeWorkDir);
  const stderrTail = rawStderr
    ? redactCredentials(stripAnsi(rawStderr))
    : undefined;
  const {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    tokensByModel,
  } = parseTokenUsage(claudeWorkDir);
  return {
    logTail,
    stderrTail,
    tokenUsage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
    tokensByModel,
    diagnosticsVersion: 2,
  };
}

/** Pattern that matches known session/context limit error messages. */
export const SESSION_LIMIT_PATTERN =
  /prompt is too long|exceed context limit|context limit reached|conversation too long/i;

/**
 * Scan the current Claude JSONL output for a result record with
 * `is_error: true` whose message matches a known session/context limit pattern.
 * Returns the error text (e.g. "Prompt is too long") or null if not found
 * or if the error is unrelated to context limits.
 */
export function detectSessionLimitFromJsonl(
  claudeWorkDir: string
): string | null {
  const outputFile = resolveClaudeOutputPath(claudeWorkDir);
  if (outputFile === null) {
    return null;
  }
  try {
    const content = readFileSync(outputFile, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (
          entry.type === "result" &&
          entry.is_error === true &&
          typeof entry.result === "string" &&
          SESSION_LIMIT_PATTERN.test(entry.result)
        ) {
          return entry.result;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file read error
  }
  return null;
}

/**
 * Check whether a log tail string contains Claude Code session/context limit
 * error patterns. The log file contains both stdout and stderr.
 */
export function isSessionLimitError(logTail: string): boolean {
  return SESSION_LIMIT_PATTERN.test(logTail);
}

// ---------------------------------------------------------------------------
// Auth challenge detection
// ---------------------------------------------------------------------------

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
 * Scan an in-memory JSONL buffer for a result record with `is_error: true`
 * (or an `isApiErrorMessage` API-error entry) matching a known
 * auth/rate-limit/billing pattern. Returns the error text or null if not found.
 */
export function scanJsonlForAuthChallenge(content: string): string | null {
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
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
 * Scan the current Claude JSONL output file for an auth/rate-limit/billing
 * error record. Thin wrapper that reads the file then delegates to
 * `scanJsonlForAuthChallenge`.
 */
export function detectAuthChallengeFromJsonl(
  claudeWorkDir: string
): string | null {
  const outputFile = resolveClaudeOutputPath(claudeWorkDir);
  if (outputFile === null) {
    return null;
  }
  try {
    return scanJsonlForAuthChallenge(readFileSync(outputFile, "utf-8"));
  } catch {
    // file read error
    return null;
  }
}

/**
 * Check whether a log tail string contains Claude CLI auth/rate-limit/billing
 * error patterns.
 */
export function isAuthChallengeError(logTail: string): boolean {
  return AUTH_CHALLENGE_PATTERN.test(logTail);
}

// ---------------------------------------------------------------------------
// LLM-assisted commit (EXECUTE only)
// ---------------------------------------------------------------------------

type LlmCommitFailureReason =
  | { kind: "auth_challenge"; authChallengeMessage: string }
  | { kind: "timeout" }
  | { kind: "other" };

type LlmCommitResult =
  | { status: "success"; result: ExecutionResult }
  | {
      status: "failed";
      reason: LlmCommitFailureReason;
      logTail: string;
    };

/** Shorthand for a non-auth, non-timeout LLM commit failure. */
function llmCommitFailed(logTail: string): LlmCommitResult {
  return { status: "failed", reason: { kind: "other" }, logTail };
}

async function attemptLlmCommit(
  worktreeDir: string,
  baseBranch: string,
  loopId: string,
  command: string,
  artifactSlug: string | undefined,
  webAppOrigin: string,
  committer: LoopCommitter | undefined,
  getAllowedDirectories: () => string[],
  expectedMcpUrl?: string,
  onTimeout?: () => void,
  jobStore?: JobStore,
  claudeWorkDir?: string,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv
): Promise<LlmCommitResult> {
  // Build metadata footer for PR body
  // Strip newlines from user-controlled fields to prevent prompt injection
  const safeBranch = baseBranch.replace(/[\r\n]/g, "");
  const safeLoopId = sanitizeCommitMessage(loopId).replace(/[\r\n]/g, "");
  const safeSlug = artifactSlug
    ? sanitizeCommitMessage(artifactSlug).replace(/[\r\n]/g, "")
    : null;

  let footer: string;
  if (safeSlug) {
    // safeSlug contains only alphanumerics, hyphens, and underscores after
    // sanitizeCommitMessage() + newline stripping — no backticks that would
    // break shell heredocs or prompt injection via template literals.
    const artifactLink = `${webAppOrigin}/implementation-plans/${safeSlug}`;
    footer = `---\nLoop ID: ${safeLoopId}\nArtifact: ${artifactLink}`;
  } else {
    footer = `---\nLoop ID: ${safeLoopId}`;
  }

  // Build slug instruction for the prompt
  const slugInstruction = safeSlug
    ? `The artifact slug is ${safeSlug}. ` +
      `You MUST prefix the PR title with "${safeSlug}: " ` +
      `(e.g., "${safeSlug}: Add feature X"). ` +
      "Also prefix the commit message the same way."
    : "No artifact slug is available — use a descriptive title without a prefix.";

  const prompt = [
    `You are a commit assistant finalizing work from a Closedloop.AI ${command} loop.`,
    "",
    slugInstruction,
    "",
    "Review all uncommitted changes in this repository and create a proper commit, push it, and create a pull request.",
    "",
    "STEPS:",
    "1. Run `git status` and `git diff --stat` to understand what changed",
    "2. Stage all changed/new files EXCEPT the .claude/ and .closedloop-ai/ directories:",
    "   git add -- . ':!.claude' ':!.closedloop-ai'",
    "3. Write a clear, descriptive commit message based on the actual code changes",
    "   - First check if a `.gitmessage` file exists at the repo root. If it does, read it and",
    "     follow its format exactly (subject line format, body structure, required sections).",
    "   - Summarize WHAT changed and WHY (not just 'Closedloop.AI loop output')",
    "   - Use conventional commit style if the changes have a clear category",
    "   - If an artifact slug is provided, prefix the commit message with it",
    "4. Run `git commit` (do NOT use --no-verify). If pre-commit hooks fail, attempt to fix",
    "   the issue (e.g., run the linter/formatter if the error message tells you how).",
    "   If you cannot quickly fix it, the commit fails — do not bypass hooks.",
    "5. Push to origin with: git push -u origin HEAD",
    "6. Check if a PR already exists for this branch: gh pr list --head <branch>",
    "   - If NO PR exists:",
    "     a. Check if the repo has a PR template at .github/pull_request_template.md",
    "        If a template exists, use it as the base for the PR body — fill in every section appropriately.",
    "        If no template exists, write a summary of what changed and why.",
    "     b. Append the following metadata footer on its own lines at the end:",
    `        ${footer}`,
    "     c. Write the complete PR body to pr-body.md",
    `     d. Create the PR: gh pr create --label symphony --base ${shellEscape(safeBranch)} --title '<slug-prefixed descriptive title>' --body-file pr-body.md`,
    "   - If a PR already exists, get its URL with: gh pr view --json url,number",
    "     The existing PR may have been created by a prior failed/interrupted run with",
    "     a generic title and empty description. You must bring it up to quality:",
    `     a. Run \`git diff --stat origin/${shellEscape(safeBranch)}...HEAD\` to understand ALL changes on the branch (not just this commit)`,
    "     b. Update the PR title to accurately describe the full feature/change:",
    `        gh pr edit <number> --title '<slug-prefixed descriptive title>'`,
    "     c. Rewrite the PR body from scratch based on the full branch diff.",
    "        Check if the repo has a PR template at .github/pull_request_template.md",
    "        If a template exists, use it as the base — fill in every section.",
    "        If no template exists, write a summary of all changes and why.",
    "        Append the following metadata footer on its own lines at the end:",
    `        ${footer}`,
    "        Write the full body to pr-body.md and run: gh pr edit <number> --body-file pr-body.md",
    "7. ONLY after a successful commit AND push, write this EXACT JSON file:",
    "   File path: execution-result.json",
    "   ```json",
    "   {",
    '     "prUrl": "<full GitHub PR URL>",',
    '     "prNumber": <PR number as integer>,',
    '     "branchName": "<current branch name>",',
    '     "commitSha": "<output of git rev-parse HEAD>"',
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

  loopLog(loopId, "Attempting LLM-assisted commit...");

  // Sandbox gate: verify the worktree directory is within an allowed path
  // before spawning any child process on it. This mirrors the assertPathAllowed
  // check performed in handleLoopRequest before the main loop spawn.
  try {
    assertPathAllowed(worktreeDir, getAllowedDirectories());
  } catch (sandboxErr) {
    if (sandboxErr instanceof DirectoryNotAllowedError) {
      loopError(
        loopId,
        `LLM commit aborted: worktreeDir not in allowed sandbox: ${worktreeDir}`
      );
      return llmCommitFailed(
        "Sandbox gate failed: worktree not in allowed directory"
      );
    }
    throw sandboxErr;
  }

  const spawnEnv: Record<string, string> = await getClaudeShellEnv();
  if (committer) {
    spawnEnv.GIT_AUTHOR_NAME = committer.name;
    spawnEnv.GIT_AUTHOR_EMAIL = committer.email;
    spawnEnv.GIT_COMMITTER_NAME = committer.name;
    spawnEnv.GIT_COMMITTER_EMAIL = committer.email;
  }

  // Resolve the absolute path to the `claude` binary through the shared
  // login-shell PATH cache. Electron strips PATH to a minimal system set when
  // launching via the app bundle or service managers, so sync callers must use
  // the same resolver path as async health and preflight checks.
  const claudeBinary = getResolvedClaudePath();
  const allowedTools = await withMcpTools(
    "Bash,Read,Write,Glob,Grep",
    expectedMcpUrl
  );
  const spawnArgs = [
    "-p",
    prompt,
    "--allowedTools",
    allowedTools,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  loopLog(
    loopId,
    `LLM commit spawn: binary=${claudeBinary} args=["-p", "<prompt omitted>", "--allowedTools", "${allowedTools}", "--output-format", "stream-json", "--verbose"] cwd=${worktreeDir} PATH=${spawnEnv.PATH ?? "(unset)"}`
  );

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(claudeBinary, spawnArgs, {
      cwd: worktreeDir,
      detached: true,
      stdio: "pipe",
      env: spawnEnv,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    const enoentDetail =
      code === "ENOENT"
        ? ` — '${claudeBinary}' binary not found; PATH=${spawnEnv.PATH ?? "(unset)"}`
        : "";
    loopError(
      loopId,
      `LLM commit spawn failed [code=${code}${enoentDetail}]`,
      err
    );
    return llmCommitFailed(
      code === "ENOENT"
        ? `Claude binary not found at path: ${claudeBinary}`
        : `Spawn failed with code: ${code}`
    );
  }

  const pid = child.pid ?? null;
  if (!pid) {
    loopError(loopId, "LLM commit: spawn returned no PID");
    return llmCommitFailed("Failed to get PID from spawned process");
  }

  // Track the LLM commit PID so kill routes and snapshot enrichment see the current process
  const existing = runningLoops.get(loopId);
  if (existing) {
    runningLoops.set(loopId, { pid, child, stage: "post-processing" });
  }
  if (jobStore) {
    const existingJob = jobStore.getByLoopId(loopId);
    if (existingJob) {
      jobStore.upsert({
        ...existingJob,
        pid,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  // Update on-disk PID file so readProcessPidSync (used by plan-loop cancel and
  // status endpoint liveness checks) sees the LLM commit child, not the dead
  // main-loop PID.  Write atomically via a .pid.tmp temp file renamed into
  // place to prevent a concurrent reader from observing a partial write.
  if (claudeWorkDir) {
    try {
      const pidFilePath = path.join(claudeWorkDir, "process.pid");
      const pidTmpPath = path.join(claudeWorkDir, "process.pid.tmp");
      writeFileSync(pidTmpPath, String(pid));
      renameSync(pidTmpPath, pidFilePath);
    } catch {
      loopLog(loopId, "Failed to update process.pid for LLM commit child");
    }
  }

  return new Promise<LlmCommitResult>((resolve) => {
    let killed = false;

    // Process group kill behavior:
    // The child is spawned with `detached: true`, which places it in its own
    // process group (pgid === child.pid on POSIX). Sending SIGTERM/SIGKILL to
    // -pid (negative PID) targets the entire process group, ensuring that any
    // subprocesses spawned by claude (git, gh, etc.) are also terminated and
    // do not become orphans when the timeout fires or cancel is requested.
    const killTimer = setTimeout(() => {
      if (!killed) {
        killed = true;
        loopError(loopId, "LLM commit timed out after 30m — sending SIGTERM");
        onTimeout?.();
        try {
          process.kill(-pid, "SIGTERM");
        } catch (killErr) {
          loopError(loopId, "Failed to kill LLM commit process:", killErr);
        }
        // Escalate to SIGKILL after 5s if the process group survives SIGTERM
        setTimeout(() => {
          try {
            process.kill(pid, 0); // check alive
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already gone
          }
        }, 5000);
      }
    }, 30 * 60_000);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(killTimer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (stdout) {
        loopLog(loopId, `LLM commit stdout (tail): ${stdout.slice(-2000)}`);
      }
      if (stderr) {
        loopLog(loopId, `LLM commit stderr (tail): ${stderr.slice(-1000)}`);
      }

      const logOutput = [stdout.slice(-2000), stderr.slice(-1000)]
        .filter(Boolean)
        .join("\n");
      const fallbackLogTail = (codeLabel: string): string =>
        logOutput || `LLM commit process exited with code ${codeLabel}`;

      // code is null when the process was killed by a signal
      if (killed || code == null) {
        loopError(loopId, `LLM commit exited with code ${code ?? "killed"}`);
        resolve({
          status: "failed",
          reason: { kind: "timeout" },
          logTail: fallbackLogTail(String(code ?? "killed")),
        });
        return;
      }

      if (code !== 0) {
        loopError(loopId, `LLM commit exited with code ${code}`);

        // The LLM commit spawn uses --output-format stream-json, so stdout is
        // valid JSONL — scan it directly for auth/rate-limit/billing errors.
        const authChallengeMsg = scanJsonlForAuthChallenge(stdout);

        if (authChallengeMsg !== null) {
          loopError(
            loopId,
            `LLM commit detected auth challenge: ${authChallengeMsg}`
          );
        }
        const failureReason: LlmCommitFailureReason =
          authChallengeMsg === null
            ? { kind: "other" }
            : {
                kind: "auth_challenge",
                authChallengeMessage: authChallengeMsg,
              };
        resolve({
          status: "failed",
          reason: failureReason,
          logTail: fallbackLogTail(String(code)),
        });
        return;
      }

      // Read execution-result.json written by the LLM, then clean up scratch
      // files unconditionally so they never leak into subsequent worktree runs.
      const resultFilePath = path.join(
        worktreeDir,
        LoopArtifactFile.ExecutionResult
      );
      const prBodyFilePath = path.join(worktreeDir, "pr-body.md");
      let result: ExecutionResult | null = null;
      try {
        const raw = readFileSync(resultFilePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (isExecutionResult(parsed)) {
          loopLog(
            loopId,
            `LLM commit wrote execution-result.json, pr=${parsed.prUrl}`
          );
          result = parsed;
        } else {
          loopError(
            loopId,
            "LLM execution-result.json failed type guard, returning null"
          );
        }
      } catch (err) {
        loopError(
          loopId,
          "LLM commit: failed to read execution-result.json:",
          err
        );
      }
      // Always remove LLM scratch files from the worktree
      try {
        unlinkSync(resultFilePath);
      } catch {
        /* may not exist */
      }
      try {
        unlinkSync(prBodyFilePath);
      } catch {
        /* may not exist */
      }
      if (result) {
        resolve({ status: "success", result });
      } else {
        resolve(
          llmCommitFailed(
            logOutput ||
              "LLM commit succeeded but execution-result.json was missing or invalid"
          )
        );
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(killTimer);
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      const enoentDetail =
        code === "ENOENT"
          ? ` — '${claudeBinary}' binary not found; PATH=${spawnEnv.PATH ?? "(unset)"}`
          : "";
      loopError(
        loopId,
        `LLM commit process error [code=${code}${enoentDetail}]:`,
        err
      );
      resolve(
        llmCommitFailed(
          code === "ENOENT"
            ? `Claude binary not found at path: ${claudeBinary}`
            : `LLM commit process error: ${code}`
        )
      );
    });

    // unref AFTER event listeners are attached so the ChildProcess handle
    // is not garbage-collected before exit/error events fire.
    child.unref();
  });
}

// ---------------------------------------------------------------------------
// Git operations (EXECUTE only)
// ---------------------------------------------------------------------------

type GitOperationResult =
  | {
      status: "success";
      prUrl: string;
      prNumber: number;
      branchName: string;
      commitSha: string;
    }
  | { status: "no-changes" }
  | { status: "error"; reason: string };

export type ExecuteFinalizationPath = LocalJobExecuteFinalizationPath;

export type ExecuteFinalizationSource = LocalJobFinalizationSource;

export type ExecuteFinalizationResult =
  | {
      status: "success";
      path: ExecuteFinalizationPath;
      executionResultPersisted: boolean;
      reason?: string;
      prUrl?: string;
      prNumber?: number;
      branchName?: string;
      commitSha?: string;
    }
  | {
      status: "no-changes";
      path: ExecuteFinalizationPath;
      executionResultPersisted: boolean;
      reason?: string;
      branchName?: string;
      commitSha?: string;
    }
  | {
      status: "skipped";
      path: ExecuteFinalizationPath;
      executionResultPersisted: boolean;
      reason?: string;
    }
  | {
      status: "error";
      path: ExecuteFinalizationPath;
      executionResultPersisted: boolean;
      reason: string;
      isAuthChallenge?: boolean;
      branchName?: string;
    };

type ExecuteFinalizationParams = {
  worktreeDir: string | null | undefined;
  claudeWorkDir: string;
  loopId: string;
  artifactSlug: string | undefined;
  baseBranch: string;
  webAppOrigin: string;
  committer: LoopCommitter | undefined;
  getAllowedDirectories: () => string[];
  expectedMcpUrl?: string;
  jobStore?: JobStore;
  source: ExecuteFinalizationSource;
  getClaudeShellEnv?: ClaudeCodeShellEnvProvider;
  /**
   * Primary repo `owner/name` for the V2 envelope's `fullName` field.
   * Empty string when caller has none (rare boot-recovery path for jobs
   * persisted before the field existed).
   */
  primaryFullName: string;
};

function sanitizeExecuteFinalizationReason(
  reason: string | undefined
): string | undefined {
  const sanitized = reason ? sanitizeErrorMessage(reason).trim() : "";
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, 500);
}

function getExecuteFinalizationArtifactPresence(claudeWorkDir: string): {
  executionResultPresent: boolean;
  prBodyPresent: boolean;
} {
  return {
    executionResultPresent: existsSync(
      path.join(claudeWorkDir, LoopArtifactFile.ExecutionResult)
    ),
    prBodyPresent: existsSync(path.join(claudeWorkDir, "pr-body.md")),
  };
}

function getExecuteFinalizationSandboxBlockReason(
  worktreeDir: string,
  getAllowedDirectories: () => string[],
  loopId: string
): string | undefined {
  try {
    assertPathAllowed(worktreeDir, getAllowedDirectories());
  } catch (sandboxErr) {
    if (sandboxErr instanceof DirectoryNotAllowedError) {
      loopError(
        loopId,
        `EXECUTE finalization skipped: worktreeDir not in allowed sandbox: ${worktreeDir}`
      );
      return "worktree directory not allowed by current sandbox";
    }
    throw sandboxErr;
  }
  return undefined;
}

function buildExecutionResultV2(
  results: RepoExecutionResult[]
): ExecutionResultV2 {
  return {
    schemaVersion: 2,
    results,
  };
}

function parseGitHubFullNameFromPrUrl(prUrl: string): string | null {
  try {
    const parsed = new URL(prUrl);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") {
      return null;
    }
    const [owner, repo] = parts;
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

function getSuccessExecutionResultFullName(
  preferredFullName: string,
  prUrl: string
): string {
  return (
    preferredFullName.trim() || (parseGitHubFullNameFromPrUrl(prUrl) ?? "")
  );
}

export function scrubObjectCredentials(obj: unknown): unknown {
  if (typeof obj === "string") {
    return redactCredentials(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(scrubObjectCredentials);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = scrubObjectCredentials(value);
    }
    return result;
  }
  return obj;
}

function persistExecutionResultArtifact(
  claudeWorkDir: string,
  executionResult: unknown
): boolean {
  try {
    const scrubbed = scrubObjectCredentials(executionResult);
    const json = JSON.stringify(scrubbed, null, 2);
    writeFileSync(
      path.join(claudeWorkDir, LoopArtifactFile.ExecutionResult),
      json
    );
    return true;
  } catch {
    return false;
  }
}

function getHeadCommitShaFromWorktree(worktreeDir: string): string | null {
  try {
    return (
      execSync(`${shellEscape(getResolvedGitPath())} rev-parse HEAD`, {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function getAuthoritativeExecutionResult(
  value: unknown
): ExecuteFinalizationResult | null {
  const parsed = parseExecutionResultFile(value, "");
  if (!parsed.ok) {
    return null;
  }
  const primary = parsed.results[0];
  if (!primary || primary.status === "failed") {
    return null;
  }
  if (primary.status === "skipped" || !primary.hasChanges) {
    return {
      status: "no-changes",
      path: "artifact-existing",
      reason: "existing execution-result.json reused",
      executionResultPersisted: true,
      branchName: primary.status === "success" ? primary.branchName : undefined,
      commitSha:
        primary.status === "success"
          ? (primary.commitSha ?? undefined)
          : undefined,
    };
  }
  if (primary.commitSha) {
    return {
      status: "success",
      path: "artifact-existing",
      reason: "existing execution-result.json reused",
      executionResultPersisted: true,
      prUrl: primary.prUrl,
      prNumber: primary.prNumber,
      branchName: primary.branchName,
      commitSha: primary.commitSha,
    };
  }
  return null;
}

function upsertExecuteFinalizationDiagnostics(
  jobStore: JobStore | undefined,
  loopId: string,
  updates: Partial<{
    finalizationSource: ExecuteFinalizationSource;
    executeFinalizationStatus: LocalJobExecuteFinalizationStatus;
    executeFinalizationPath: ExecuteFinalizationPath;
    executeFinalizationStartedAt: string;
    executeFinalizationCompletedAt: string;
    executeFinalizationReason: string | undefined;
    executeFinalizationPreExecutionResultPresent: boolean;
    executeFinalizationPrePrBodyPresent: boolean;
    executeFinalizationPostExecutionResultPresent: boolean;
    executeFinalizationPostPrBodyPresent: boolean;
  }>
): void {
  if (!jobStore) {
    return;
  }
  const current = jobStore.getByLoopId(loopId);
  if (!current) {
    return;
  }
  jobStore.upsert({
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}

function completeExecuteFinalization(
  jobStore: JobStore | undefined,
  loopId: string,
  source: ExecuteFinalizationSource,
  claudeWorkDir: string,
  startedAt: string,
  result: ExecuteFinalizationResult,
  preArtifacts: {
    executionResultPresent: boolean;
    prBodyPresent: boolean;
  }
): ExecuteFinalizationResult {
  const postArtifacts = getExecuteFinalizationArtifactPresence(claudeWorkDir);
  upsertExecuteFinalizationDiagnostics(jobStore, loopId, {
    finalizationSource: source,
    executeFinalizationStatus: result.status,
    executeFinalizationPath: result.path,
    executeFinalizationStartedAt: startedAt,
    executeFinalizationCompletedAt: new Date().toISOString(),
    executeFinalizationReason: sanitizeExecuteFinalizationReason(result.reason),
    executeFinalizationPreExecutionResultPresent:
      preArtifacts.executionResultPresent,
    executeFinalizationPrePrBodyPresent: preArtifacts.prBodyPresent,
    executeFinalizationPostExecutionResultPresent:
      postArtifacts.executionResultPresent,
    executeFinalizationPostPrBodyPresent: postArtifacts.prBodyPresent,
  });
  const sanitizedReason = sanitizeExecuteFinalizationReason(result.reason);
  if (result.status === "error") {
    return { ...result, reason: sanitizedReason ?? result.reason };
  }
  return { ...result, reason: sanitizedReason };
}

function isAcceptedExecuteFinalization(
  result: ExecuteFinalizationResult | null | undefined
): boolean {
  return result?.status === "success" || result?.status === "no-changes";
}

export async function runExecuteFinalization(
  params: ExecuteFinalizationParams
): Promise<ExecuteFinalizationResult> {
  const startedAt = new Date().toISOString();
  const preArtifacts = getExecuteFinalizationArtifactPresence(
    params.claudeWorkDir
  );

  upsertExecuteFinalizationDiagnostics(params.jobStore, params.loopId, {
    finalizationSource: params.source,
    executeFinalizationStatus: "pending",
    executeFinalizationPath: "none",
    executeFinalizationStartedAt: startedAt,
    executeFinalizationCompletedAt: undefined,
    executeFinalizationReason: undefined,
    executeFinalizationPreExecutionResultPresent:
      preArtifacts.executionResultPresent,
    executeFinalizationPrePrBodyPresent: preArtifacts.prBodyPresent,
    executeFinalizationPostExecutionResultPresent: undefined,
    executeFinalizationPostPrBodyPresent: undefined,
  });

  const existingExecutionResult = readJsonFileSync(
    path.join(params.claudeWorkDir, LoopArtifactFile.ExecutionResult)
  );
  const authoritativeExisting = getAuthoritativeExecutionResult(
    existingExecutionResult
  );
  if (authoritativeExisting) {
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      authoritativeExisting,
      preArtifacts
    );
  }

  if (!(params.worktreeDir && existsSync(params.worktreeDir))) {
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      {
        status: "skipped",
        path: "none",
        reason: "worktree directory unavailable for execute finalization",
        executionResultPersisted: false,
      },
      preArtifacts
    );
  }

  const sandboxBlockReason = getExecuteFinalizationSandboxBlockReason(
    params.worktreeDir,
    params.getAllowedDirectories,
    params.loopId
  );
  if (sandboxBlockReason) {
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      {
        status: "skipped",
        path: "none",
        reason: sandboxBlockReason,
        executionResultPersisted: false,
      },
      preArtifacts
    );
  }

  const llmResult = await attemptLlmCommit(
    params.worktreeDir,
    params.baseBranch,
    params.loopId,
    LoopCommand.Execute,
    params.artifactSlug,
    params.webAppOrigin,
    params.committer,
    params.getAllowedDirectories,
    params.expectedMcpUrl,
    undefined,
    params.jobStore,
    params.claudeWorkDir,
    params.getClaudeShellEnv
  );

  if (llmResult.status === "success") {
    const { result: llmExecResult } = llmResult;
    const executionResult = buildExecutionResultV2([
      {
        status: "success",
        fullName: getSuccessExecutionResultFullName(
          params.primaryFullName,
          llmExecResult.prUrl
        ),
        prUrl: llmExecResult.prUrl,
        prNumber: llmExecResult.prNumber,
        branchName: llmExecResult.branchName,
        baseBranch: params.baseBranch,
        hasChanges: true,
        commitSha: llmExecResult.commitSha,
      },
    ]);
    const persisted = persistExecutionResultArtifact(
      params.claudeWorkDir,
      executionResult
    );
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      persisted
        ? {
            status: "success",
            path: "llm",
            executionResultPersisted: true,
            prUrl: llmExecResult.prUrl,
            prNumber: llmExecResult.prNumber,
            branchName: llmExecResult.branchName,
            commitSha: llmExecResult.commitSha,
          }
        : {
            status: "error",
            path: "llm",
            reason:
              "failed to persist execution-result.json after LLM commit finalization",
            executionResultPersisted: false,
          },
      preArtifacts
    );
  }

  if (
    llmResult.status === "failed" &&
    llmResult.reason.kind === "auth_challenge"
  ) {
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      {
        status: "error",
        path: "llm",
        reason: `LLM commit failed: ${llmResult.reason.authChallengeMessage}`,
        executionResultPersisted: false,
        isAuthChallenge: true,
      },
      preArtifacts
    );
  }

  const gitFallbackSandboxBlockReason =
    getExecuteFinalizationSandboxBlockReason(
      params.worktreeDir,
      params.getAllowedDirectories,
      params.loopId
    );
  if (gitFallbackSandboxBlockReason) {
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      {
        status: "skipped",
        path: "none",
        reason: gitFallbackSandboxBlockReason,
        executionResultPersisted: false,
      },
      preArtifacts
    );
  }

  try {
    unlinkSync(path.join(params.worktreeDir, LoopArtifactFile.ExecutionResult));
  } catch {
    /* may not exist */
  }
  try {
    unlinkSync(path.join(params.worktreeDir, "pr-body.md"));
  } catch {
    /* may not exist */
  }

  const gitShellPath = await getShellPath();
  const gitResult = executeGitOperations(
    params.worktreeDir,
    params.committer,
    params.baseBranch,
    params.loopId,
    LoopCommand.Execute,
    params.artifactSlug,
    params.webAppOrigin,
    gitShellPath
  );

  if (gitResult.status === "success") {
    const executionResult = buildExecutionResultV2([
      {
        status: "success",
        fullName: getSuccessExecutionResultFullName(
          params.primaryFullName,
          gitResult.prUrl
        ),
        prUrl: gitResult.prUrl,
        prNumber: gitResult.prNumber,
        branchName: gitResult.branchName,
        baseBranch: params.baseBranch,
        hasChanges: true,
        commitSha: gitResult.commitSha,
      },
    ]);
    const persisted = persistExecutionResultArtifact(
      params.claudeWorkDir,
      executionResult
    );
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      persisted
        ? {
            status: "success",
            path: "git-fallback",
            executionResultPersisted: true,
            prUrl: gitResult.prUrl,
            prNumber: gitResult.prNumber,
            branchName: gitResult.branchName,
            commitSha: gitResult.commitSha,
          }
        : {
            status: "error",
            path: "git-fallback",
            reason:
              "failed to persist execution-result.json after git finalization",
            executionResultPersisted: false,
          },
      preArtifacts
    );
  }

  if (gitResult.status === "no-changes") {
    const branchName = getCurrentBranchImpl(params.worktreeDir);
    const commitSha = getHeadCommitShaFromWorktree(params.worktreeDir);
    if (!branchName) {
      return completeExecuteFinalization(
        params.jobStore,
        params.loopId,
        params.source,
        params.claudeWorkDir,
        startedAt,
        {
          status: "error",
          path: "git-fallback",
          reason:
            "could not determine branch name for no-changes execution result",
          executionResultPersisted: false,
        },
        preArtifacts
      );
    }
    const executionResult = buildExecutionResultV2([
      {
        status: "skipped",
        fullName: params.primaryFullName,
        reason: "no_changes",
      },
    ]);
    const persisted = persistExecutionResultArtifact(
      params.claudeWorkDir,
      executionResult
    );
    return completeExecuteFinalization(
      params.jobStore,
      params.loopId,
      params.source,
      params.claudeWorkDir,
      startedAt,
      persisted
        ? {
            status: "no-changes",
            path: "git-fallback",
            reason: "no local changes detected",
            executionResultPersisted: true,
            branchName,
            commitSha: commitSha ?? undefined,
          }
        : {
            status: "error",
            path: "git-fallback",
            reason:
              "failed to persist execution-result.json for no-changes finalization",
            executionResultPersisted: false,
          },
      preArtifacts
    );
  }

  return completeExecuteFinalization(
    params.jobStore,
    params.loopId,
    params.source,
    params.claudeWorkDir,
    startedAt,
    {
      status: "error",
      path: "git-fallback",
      reason: gitResult.reason,
      executionResultPersisted: false,
    },
    preArtifacts
  );
}

export async function finalizeMultiRepoExecute(
  entries: Array<{ fullName: string; worktreeDir: string; baseBranch: string }>,
  deps: {
    loopId: string;
    apiBaseUrl: string;
    getToken: () => string | null;
    webAppOrigin: string;
    getAllowedDirectories: () => string[];
    artifactSlug?: string;
    expectedMcpUrl?: string;
    committer?: LoopCommitter;
    getClaudeShellEnv?: ClaudeCodeShellEnvProvider;
  }
): Promise<RepoExecutionResult[]> {
  const results: RepoExecutionResult[] = [];

  for (const entry of entries) {
    try {
      const entryClaudeWorkDir = path.join(
        entry.worktreeDir,
        ".closedloop-ai",
        "work"
      );
      mkdirSync(entryClaudeWorkDir, { recursive: true });
      const finalization = await runExecuteFinalization({
        worktreeDir: entry.worktreeDir,
        claudeWorkDir: entryClaudeWorkDir,
        loopId: deps.loopId,
        artifactSlug: deps.artifactSlug,
        baseBranch: entry.baseBranch,
        webAppOrigin: deps.webAppOrigin,
        committer: deps.committer,
        getAllowedDirectories: deps.getAllowedDirectories,
        expectedMcpUrl: deps.expectedMcpUrl,
        jobStore: undefined,
        source: "live-exit",
        getClaudeShellEnv: deps.getClaudeShellEnv ?? getClaudeCodeShellEnv,
        primaryFullName: entry.fullName,
      });
      results.push(
        buildPrimaryRepoResult(entry.fullName, entry.baseBranch, finalization)
      );
    } catch (err) {
      loopError(
        deps.loopId,
        "multi-repo-finalization-failed",
        entry.fullName,
        String(err)
      );
      await postLoopEventBounded(deps.apiBaseUrl, deps.loopId, deps.getToken, {
        type: LoopEventType.Error,
        code: LoopErrorCode.RunnerError,
        message: redactCredentials(
          sanitizeErrorMessage(err instanceof Error ? err.message : String(err))
        ),
        result: { repo: entry.fullName },
      });
      results.push({
        status: "failed",
        fullName: entry.fullName,
        error: String(err),
      });
    }
  }

  return results;
}

/**
 * Outcome of `finalizeAdditionalReposAndPersist`.
 *
 * - `skipped:no-additionals`: caller passed an empty entries array.
 * - `skipped:already-finalized`: existing on-disk V2 already contains the
 *   multi-repo envelope (idempotent re-entry from recovery).
 * - `skipped:incomplete-metadata`: an entry persisted by an older build
 *   lacks the `fullName` or `baseBranch` required to finalize. Recovery
 *   logs a warning and falls through to worktree cleanup only.
 * - `ok`: finalization ran; combined V2 envelope was persisted.
 */
export type FinalizeAdditionalReposOutcome =
  | { status: "skipped:no-additionals" }
  | { status: "skipped:already-finalized" }
  | { status: "skipped:incomplete-metadata"; missingRepoPaths: string[] }
  | { status: "ok"; results: RepoExecutionResult[] };

/**
 * Run `finalizeMultiRepoExecute` for the additional-repo worktrees and
 * persist the combined V2 envelope (primary + additional results) to
 * `execution-result.json`. Used by both the live-exit path in
 * `handleProcessCompletion` and by recovery in `finalizeLoopFromRuntime`,
 * so the same git push / PR creation runs after a desktop restart.
 *
 * Idempotent: if the on-disk V2 already carries multiple results, returns
 * without doing further work.
 */
export async function finalizeAdditionalReposAndPersist(args: {
  additionalEntries: readonly AdditionalWorktreeEntry[];
  primaryFullName: string;
  primaryBaseBranch: string;
  /**
   * Fresh primary finalization result from the live path or from a recovery
   * call that just ran `runExecuteFinalization`. When `null`, the helper
   * falls back to the primary entry already on disk in `execution-result.json`
   * (recovery path where primary was finalized in a prior attempt).
   */
  executeFinalization: ExecuteFinalizationResult | null;
  claudeWorkDir: string;
  loopId: string;
  apiBaseUrl: string;
  getToken: () => string | null;
  webAppOrigin: string;
  getAllowedDirectories: () => string[];
  artifactSlug?: string;
  expectedMcpUrl?: string;
  committer?: LoopCommitter;
  getClaudeShellEnv?: ClaudeCodeShellEnvProvider;
}): Promise<FinalizeAdditionalReposOutcome> {
  if (args.additionalEntries.length === 0) {
    return { status: "skipped:no-additionals" };
  }

  // Idempotency guard: a prior run (live-exit pre-crash, or earlier recovery
  // attempt) may have already persisted the multi-repo envelope.
  const existing = readJsonFileSync(
    path.join(args.claudeWorkDir, LoopArtifactFile.ExecutionResult)
  );
  const parsedExisting = parseExecutionResultFile(existing, "");
  if (parsedExisting.ok && parsedExisting.results.length > 1) {
    return { status: "skipped:already-finalized" };
  }

  const finalizable: Array<{
    fullName: string;
    worktreeDir: string;
    baseBranch: string;
  }> = [];
  const missingRepoPaths: string[] = [];
  for (const entry of args.additionalEntries) {
    const fullName =
      entry.fullName ?? resolveRepoFullName(entry.repoPath) ?? undefined;
    const baseBranch = entry.baseBranch;
    if (!(fullName && baseBranch)) {
      missingRepoPaths.push(entry.repoPath);
      continue;
    }
    finalizable.push({
      fullName,
      worktreeDir: entry.dir,
      baseBranch,
    });
  }

  if (missingRepoPaths.length > 0) {
    gatewayLog.warn(
      "loop-harness",
      `Skipping additional-repo recovery for loopId=${args.loopId}: ` +
        `missing fullName/baseBranch metadata for repos [${missingRepoPaths.join(", ")}]`
    );
    return { status: "skipped:incomplete-metadata", missingRepoPaths };
  }

  const additionalResults = await finalizeMultiRepoExecute(finalizable, {
    loopId: args.loopId,
    apiBaseUrl: args.apiBaseUrl,
    getToken: args.getToken,
    webAppOrigin: args.webAppOrigin,
    getAllowedDirectories: args.getAllowedDirectories,
    artifactSlug: args.artifactSlug,
    expectedMcpUrl: args.expectedMcpUrl,
    committer: args.committer,
    getClaudeShellEnv: args.getClaudeShellEnv,
  });

  // Prefer the primary entry already on disk so we preserve any prUrl /
  // branchName / commitSha values previously written. Fall back to building
  // one from `executeFinalization` (live path or fresh recovery).
  const existingPrimary =
    parsedExisting.ok && parsedExisting.results.length >= 1
      ? parsedExisting.results[0]
      : null;
  const primaryResult: RepoExecutionResult =
    existingPrimary ??
    buildPrimaryRepoResult(
      args.primaryFullName,
      args.primaryBaseBranch,
      args.executeFinalization
    );

  const v2Envelope = buildExecutionResultV2([
    primaryResult,
    ...additionalResults,
  ]);
  persistExecutionResultArtifact(args.claudeWorkDir, v2Envelope);

  return { status: "ok", results: additionalResults };
}

function buildPrimaryRepoResult(
  fullName: string,
  baseBranch: string,
  executeFinalization: ExecuteFinalizationResult | null
): RepoExecutionResult {
  if (!executeFinalization) {
    return { status: "skipped", fullName, reason: "no_finalization" };
  }
  if (
    executeFinalization.status === "no-changes" ||
    executeFinalization.status === "skipped"
  ) {
    return {
      status: "skipped",
      fullName,
      reason: executeFinalization.reason ?? "no_changes",
    };
  }
  if (
    executeFinalization.status === "success" &&
    executeFinalization.prUrl &&
    executeFinalization.prNumber !== undefined &&
    executeFinalization.branchName &&
    executeFinalization.commitSha
  ) {
    return {
      status: "success",
      fullName: getSuccessExecutionResultFullName(
        fullName,
        executeFinalization.prUrl
      ),
      prUrl: executeFinalization.prUrl,
      prNumber: executeFinalization.prNumber,
      branchName: executeFinalization.branchName,
      baseBranch,
      hasChanges: true,
      commitSha: executeFinalization.commitSha,
    };
  }
  return {
    status: "failed",
    fullName,
    error:
      executeFinalization.reason ??
      `execute finalization status: ${executeFinalization.status}`,
  };
}

function executeGitOperations(
  worktreeDir: string,
  committer: LoopCommitter | undefined,
  baseBranch: string,
  loopId: string,
  command: string,
  artifactSlug?: string,
  webAppOrigin?: string,
  shellPath?: string
): GitOperationResult {
  const shortId = loopId.slice(0, 8);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(shellPath ? { PATH: shellPath } : {}),
  };
  if (committer) {
    env.GIT_AUTHOR_NAME = committer.name;
    env.GIT_AUTHOR_EMAIL = committer.email;
    env.GIT_COMMITTER_NAME = committer.name;
    env.GIT_COMMITTER_EMAIL = committer.email;
  }

  // Check for changes, excluding .claude/ and .closedloop-ai/ which are written
  // by the gateway itself (work dir, artifacts) and must never be committed.
  const gitBin = getResolvedGitPath();
  try {
    const status = execSync(
      `${shellEscape(gitBin)} status --porcelain -- . ':!.claude' ':!.closedloop-ai'`,
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    ).trim();

    if (!status) {
      return { status: "no-changes" }; // No changes
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", reason };
  }

  // Stage, commit, push
  try {
    execSync(`${shellEscape(gitBin)} add -- . ':!.claude' ':!.closedloop-ai'`, {
      cwd: worktreeDir,
      stdio: "pipe",
      env,
      timeout: 10_000,
    });

    const commitPrefix = artifactSlug ? `${artifactSlug}: ` : "";
    const fallbackTitle = `${commitPrefix}Automated changes from loop ${shortId}`;
    execSync(`${shellEscape(gitBin)} commit -m ${shellEscape(fallbackTitle)}`, {
      cwd: worktreeDir,
      stdio: "pipe",
      env,
      timeout: 30_000,
    });

    const branchName = execSync(
      `${shellEscape(gitBin)} rev-parse --abbrev-ref HEAD`,
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 10_000,
      }
    ).trim();

    execSync(
      `${shellEscape(gitBin)} push -u origin ${shellEscape(branchName)}`,
      {
        cwd: worktreeDir,
        stdio: "pipe",
        env,
        timeout: 60_000,
      }
    );

    const commitSha = execSync(`${shellEscape(gitBin)} rev-parse HEAD`, {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    }).trim();

    // Build PR body using the repo's PR template if one exists, otherwise
    // fall back to a simple metadata body. Written to a temp file to avoid
    // shell escaping issues with special characters (--body-file approach).
    const artifactLine =
      artifactSlug && webAppOrigin
        ? `\nArtifact: ${webAppOrigin}/implementation-plans/${artifactSlug}`
        : "";
    const metadataFooter = `---\nLoop ID: ${loopId}\nCommand: ${command}${artifactLine}`;

    let prBody: string;
    const templatePath = path.join(
      worktreeDir,
      ".github",
      "pull_request_template.md"
    );
    try {
      const template = readFileSync(templatePath, "utf-8");
      prBody = [
        "Automated PR created by Closedloop.AI loop runner.",
        "",
        `**Loop:** \`${loopId}\``,
        `**Command:** \`${command}\``,
        "",
        template,
        "",
        metadataFooter,
      ].join("\n");
    } catch {
      // No template found — use simple metadata body
      prBody = [
        "Automated PR created by Closedloop.AI loop runner.",
        "",
        `**Loop:** \`${loopId}\``,
        `**Command:** \`${command}\``,
        "",
        metadataFooter,
      ].join("\n");
    }
    const bodyFile = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      "pr-body.md"
    );
    mkdirSync(path.dirname(bodyFile), { recursive: true });
    writeFileSync(bodyFile, prBody);

    // Check for existing PR before creating (handles retries gracefully)
    const ghBin = shellEscape(getResolvedGhPath());
    let prUrl: string;
    let prNumber: number;
    try {
      const existingPr = execSync(
        `${ghBin} pr view --json url,number ${shellEscape(branchName)}`,
        {
          cwd: worktreeDir,
          encoding: "utf-8",
          stdio: "pipe",
          env,
          timeout: 15_000,
        }
      ).trim();
      const parsedUnknown: unknown = JSON.parse(existingPr);
      if (
        typeof parsedUnknown !== "object" ||
        parsedUnknown === null ||
        typeof (parsedUnknown as Record<string, unknown>).url !== "string" ||
        typeof (parsedUnknown as Record<string, unknown>).number !== "number"
      ) {
        throw new Error("Unexpected shape from gh pr view JSON");
      }
      const parsed = parsedUnknown as { url: string; number: number };
      prUrl = parsed.url;
      prNumber = parsed.number;
    } catch {
      // No existing PR — create one using --body-file to avoid shell escaping.
      // Create without --label first so the PR still succeeds on repos where the
      // 'symphony' label doesn't exist yet, then attach the label best-effort.
      const prOutput = execSync(
        `${ghBin} pr create --title ${shellEscape(fallbackTitle)} --body-file ${shellEscape(bodyFile)} --base ${shellEscape(baseBranch)}`,
        {
          cwd: worktreeDir,
          encoding: "utf-8",
          stdio: "pipe",
          env,
          timeout: 30_000,
        }
      ).trim();
      prUrl = prOutput;
      const prNumberMatch = /\/pull\/(\d+)/.exec(prUrl);
      prNumber = prNumberMatch ? Number.parseInt(prNumberMatch[1], 10) : 0;

      // Best-effort label attachment — non-fatal if the label doesn't exist
      if (prNumber) {
        try {
          execSync(`${ghBin} pr edit ${prNumber} --add-label symphony`, {
            cwd: worktreeDir,
            stdio: "pipe",
            env,
            timeout: 15_000,
          });
        } catch {
          // Label may not exist on this repo — not critical
        }
      }
    }

    // Ensure the metadata footer is present on the PR body.  For existing PRs,
    // fetch the current body and append the metadata instead of replacing it.
    try {
      const currentBody = execSync(
        `${ghBin} pr view ${prNumber} --json body --jq .body`,
        {
          cwd: worktreeDir,
          encoding: "utf-8",
          stdio: "pipe",
          env,
          timeout: 15_000,
        }
      ).trim();
      // Only update if the footer isn't already present — append only the
      // metadata footer, not the full template body, to avoid duplication.
      if (!currentBody.includes(`Loop ID: ${loopId}`)) {
        const updatedBody = currentBody
          ? `${currentBody}\n\n${metadataFooter}`
          : prBody;
        writeFileSync(bodyFile, updatedBody);
        execSync(
          `${ghBin} pr edit ${prNumber} --body-file ${shellEscape(bodyFile)}`,
          { cwd: worktreeDir, stdio: "pipe", env, timeout: 15_000 }
        );
      }
    } catch {
      // Non-critical — PR exists, metadata is best-effort
    }

    return { status: "success", prUrl, prNumber, branchName, commitSha };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", reason };
  }
}

// ---------------------------------------------------------------------------
// Process completion handler (async, runs after spawn)
// ---------------------------------------------------------------------------

function isCancelled(jobStore: JobStore | undefined, loopId: string): boolean {
  const status = jobStore?.getByLoopId(loopId)?.status;
  return status === "CANCEL_PENDING" || status === "CANCELLED";
}

function emitExecuteDecisionTableVerificationTelemetry(args: {
  loopId: string;
  commandId?: string;
  operationId?: string;
  claudeWorkDir: string;
  decisionTableVerificationStartOffset?: number;
}): void {
  const summary = emitDecisionTableVerificationTelemetry({
    telemetry: Observability.getTelemetryEmitter(),
    commandId: args.commandId,
    operationId: args.operationId,
    loopId: args.loopId,
    closedLoopWorkDir: args.claudeWorkDir,
    startOffset: args.decisionTableVerificationStartOffset,
  });

  if (summary.emittedRecords > 0) {
    gatewayLog.info(
      "decision-table-telemetry",
      `Emitted ${summary.emittedRecords} decision-table verification telemetry record(s) for loopId=${args.loopId} file=${summary.filePath}`
    );
    return;
  }

  gatewayLog.info(
    "decision-table-telemetry",
    `Emitted decision-table verification missing telemetry for loopId=${args.loopId} reason=${summary.missingReason ?? "unknown"} file=${summary.filePath}`
  );
}

export async function handleProcessCompletion(
  exitCode: number,
  body: LoopRequestBody,
  apiBaseUrl: string,
  worktreeDir: string | null,
  claudeWorkDir: string,
  usedTempDir: boolean,
  expandedRepoPath: string | null,
  getAllowedDirectories: () => string[],
  expectedMcpUrl?: string,
  jobStore?: JobStore,
  webAppOrigin?: string,
  commandId?: string,
  operationId?: string,
  wt: WorktreeProvider = defaultWorktreeProvider,
  loopTokenStore?: LoopTokenStore,
  additionalWorktreeDirs: AdditionalWorktreeEntry[] = [],
  exitSignal?: string,
  spawnStartedAt?: number,
  spawnMeta?: {
    command: string;
    args: string[];
    cwd: string;
    claudeVersion?: string;
    binaryPath: string;
    authFilesExist: boolean;
    envSnapshot: Record<string, string>;
  },
  decisionTableVerificationStartOffset = 0,
  userVisibleLoopFailureSecret?: string,
  loopPerfTelemetryStartOffset = 0,
  loopPerfWatcherHandle?: LoopPerfTelemetryWatcherHandle,
  schedulers?: LoopSchedulerContext,
  nativeObservability?: NativeLoopObservabilitySession,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv,
  onLoopCompleted?: LoopCompletedHook
): Promise<void> {
  const { loopId, command, closedLoopAuthToken, committer } = body;
  // Temp-dir commands (DECOMPOSE, EVALUATE_*) need the entire temp tree removed on cleanup.
  const tempCleanupDir = usedTempDir ? (worktreeDir ?? claudeWorkDir) : null;
  const elapsedMs = spawnStartedAt ? Date.now() - spawnStartedAt : undefined;
  const existingJob = jobStore?.getByLoopId(loopId);
  const wasCancelled =
    existingJob?.status === "CANCEL_PENDING" ||
    existingJob?.status === "CANCELLED";

  loopLog(loopId, `Process exited with code ${exitCode}, command=${command}`);

  // Stop the loop perf watcher and reconcile any remaining records.
  // Gated on `loopPerfWatcherHandle` because the watcher and the captured
  // startOffset travel together: only the run-loop.sh spawn path
  // (PLAN/EXECUTE) sets them. Commands that reuse a prior PLAN's
  // claudeWorkDir without starting the watcher (notably REQUEST_CHANGES)
  // would otherwise reconcile from byte 0 and re-emit every PLAN-era
  // perf.jsonl record under the new command's trace context, polluting
  // loop.perf.* telemetry. The no-op handle returned when fs.watch fails
  // is still defined (it carries the captured startOffset), so the
  // fail-open path keeps reconciling correctly.
  // Wrapped in try/catch so scanner failures never affect the Loop outcome (AC-004).
  try {
    if (loopPerfWatcherHandle) {
      await loopPerfWatcherHandle.stop();
      reconcileLoopPerfTelemetry(claudeWorkDir, {
        startOffset: loopPerfTelemetryStartOffset,
        traceContext: {
          commandId,
          operationId,
          loopId,
          jobId: loopId,
        },
        telemetryEmitter: Observability.getTelemetryEmitter(),
        watcherHandle: loopPerfWatcherHandle,
      });
    }
  } catch (loopPerfErr) {
    gatewayLog.warn(
      "loop-perf-telemetry",
      `Loop perf telemetry reconciliation failed for loopId=${loopId}: ${loopPerfErr instanceof Error ? loopPerfErr.message : loopPerfErr}`
    );
  }

  // Native in-process observability (NativePrompt / ClaudeSlashCommand):
  // synthesize the single `iteration` event at exit, flush any open items, and
  // clear the active-agents registry regardless of outcome. Best-effort — a
  // telemetry failure must never affect the Loop outcome (AC-008).
  try {
    nativeObservability?.finish({
      exitCode,
      status: wasCancelled
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed",
    });
  } catch (nativeObsErr) {
    gatewayLog.warn(
      "loop-perf-telemetry",
      `Native observability finalize failed for loopId=${loopId}: ${nativeObsErr instanceof Error ? nativeObsErr.message : nativeObsErr}`
    );
  }

  if (exitCode !== 0) {
    // Collect diagnostics (log tail + stderr + token usage) for the failure event
    const baseDiagnostics = collectFailureDiagnostics(claudeWorkDir);
    const sessionFileForTelemetry = path.join(claudeWorkDir, "session-id.txt");
    const rawSessionId = readTextFile(sessionFileForTelemetry);
    const failureSessionId = rawSessionId ? rawSessionId.trim() : undefined;
    runningLoops.delete(loopId);
    const failureBranchName = worktreeDir
      ? (wt.getCurrentBranch(worktreeDir) ?? undefined)
      : undefined;
    const failureWarnings: string[] = [];
    let failureCloudFinalized = false;
    let failureRetryableFailure = false;
    let failureRemoteError: string | undefined;
    const postFailureLoopEvent = async (
      eventBody: Record<string, unknown>
    ): Promise<void> => {
      const result = await postLoopEvent(
        apiBaseUrl,
        loopId,
        () => closedLoopAuthToken,
        eventBody
      );
      failureCloudFinalized = result.success;
      if (!result.success) {
        failureRemoteError = result.error;
        failureRetryableFailure = isRetryableFinalizationError(result.error);
        failureWarnings.push("EVENT_POST_FAILED");
      }
      if (existingJob && jobStore) {
        const now = new Date().toISOString();
        const latestJob = jobStore.getByLoopId(loopId) ?? existingJob;
        jobStore.upsert({
          ...latestJob,
          ...(result.success
            ? {
                completedEventPostedAt: latestJob.completedEventPostedAt ?? now,
                cloudFinalizedAt: latestJob.cloudFinalizedAt ?? now,
                lastRecoveryError: undefined,
              }
            : {
                lastRecoveryError: result.error,
              }),
          updatedAt: now,
        });
      }
    };

    if (!wasCancelled && command === LoopCommand.Execute) {
      if (existingJob && jobStore) {
        const uploadResult = await tryUploadArtifacts(
          existingJob,
          command,
          claudeWorkDir,
          worktreeDir ?? undefined,
          failureWarnings,
          {
            jobStore,
            getToken: () => closedLoopAuthToken,
            apiBaseUrl,
          }
        );
        if (uploadResult.failed) {
          gatewayLog.warn(
            "loop-harness",
            `EXECUTE failure artifact upload failed for loopId=${loopId}: ${uploadResult.error ?? "unknown error"}`
          );
        }
      } else {
        const uploadResult = await uploadArtifacts(
          apiBaseUrl,
          loopId,
          () => closedLoopAuthToken,
          {
            artifacts: readExecuteOutputs(claudeWorkDir),
            metadata: {
              finishedAt: new Date().toISOString(),
              command: command.toLowerCase(),
              ...(failureSessionId ? { sessionId: failureSessionId } : {}),
              ...(failureBranchName ? { branchName: failureBranchName } : {}),
            },
          }
        );
        if (!uploadResult.success) {
          failureWarnings.push("ARTIFACT_UPLOAD_FAILED");
          gatewayLog.warn(
            "loop-harness",
            `EXECUTE failure artifact upload failed for loopId=${loopId}: ${uploadResult.error ?? "unknown error"}`
          );
        }
      }
    }

    if (!wasCancelled) {
      const rawBody = body as unknown as { s3StateKey?: unknown };
      const bodyS3StateKey =
        typeof rawBody.s3StateKey === "string" && rawBody.s3StateKey
          ? rawBody.s3StateKey
          : undefined;
      const supportJob =
        existingJob ??
        ({
          id: loopId,
          kind: "SYMPHONY_LOOP",
          loopId,
          command: command as LocalJobCommand,
          claudeWorkDir,
          status: "FAILED",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(bodyS3StateKey ? { s3StateKey: bodyS3StateKey } : {}),
        } satisfies LocalJob);
      const supportResult = await tryUploadSupportBundle({
        job: supportJob,
        claudeWorkDir,
        apiBaseUrl,
        getToken: () => closedLoopAuthToken,
        jobStore,
      });
      if (supportResult.failed) {
        failureWarnings.push("SUPPORT_UPLOAD_FAILED");
        gatewayLog.warn(
          "loop-harness",
          `Support upload failed for loopId=${loopId}: ${supportResult.error}`
        );
      }
    }

    // Determine abort reason
    const abortReason: string | undefined = wasCancelled
      ? "cancelled"
      : "process-exit";

    // Build enriched diagnostics with new fields
    const diagnostics = {
      ...baseDiagnostics,
      exitSignal,
      elapsedMs,
      abortReason,
      spawnMeta,
    };

    if (!wasCancelled && command === LoopCommand.Execute) {
      emitExecuteDecisionTableVerificationTelemetry({
        loopId,
        commandId: commandId ?? existingJob?.commandId,
        operationId: operationId ?? existingJob?.operationId,
        claudeWorkDir,
        decisionTableVerificationStartOffset,
      });
    }

    // Shared fields for all failure event posts — keeps each branch focused
    // on its unique code/message rather than repeating diagnostics.
    const failureEventBase: Record<string, unknown> = {
      type: LoopEventType.Error,
      loopId,
      sessionId: failureSessionId,
      ...(failureBranchName ? { branchName: failureBranchName } : {}),
      tokenUsage: diagnostics.tokenUsage,
      tokensByModel: diagnostics.tokensByModel,
      logTail: diagnostics.logTail,
      stderrTail: diagnostics.stderrTail,
      exitSignal: diagnostics.exitSignal,
      elapsedMs: diagnostics.elapsedMs,
      abortReason: diagnostics.abortReason,
      diagnosticsVersion: String(diagnostics.diagnosticsVersion),
      ...(failureWarnings.length > 0 ? { warnings: failureWarnings } : {}),
    };

    if (wasCancelled) {
      Observability.jobCancelled(
        commandId ?? existingJob?.commandId,
        operationId ?? existingJob?.operationId,
        loopId,
        exitCode,
        diagnostics,
        failureSessionId,
        command
      );
      await postFailureLoopEvent({
        ...failureEventBase,
        code: LoopErrorCode.Cancelled,
        message: "Loop cancelled",
      });
    } else {
      Observability.jobFailed(
        commandId ?? existingJob?.commandId,
        operationId ?? existingJob?.operationId,
        loopId,
        exitCode,
        diagnostics,
        failureSessionId,
        command
      );
    }

    // Detect context/session limit errors (exit code 2, JSONL is_error, or
    // stderr patterns) and surface a specific error code.
    const jsonlError = detectSessionLimitFromJsonl(claudeWorkDir);
    const isContextLimit =
      exitCode === 2 ||
      jsonlError !== null ||
      (diagnostics.logTail != null && isSessionLimitError(diagnostics.logTail));

    // Detect auth/rate-limit/billing errors from JSONL or stderr.
    const jsonlAuthError = detectAuthChallengeFromJsonl(claudeWorkDir);
    const isAuthChallenge =
      !isContextLimit &&
      (jsonlAuthError !== null ||
        (diagnostics.logTail != null &&
          isAuthChallengeError(diagnostics.logTail)));
    const userVisibleFailure = readUserVisibleLoopFailure({
      claudeWorkDir,
      markerNotBeforeMs: spawnStartedAt,
      signingSecret: userVisibleLoopFailureSecret,
    });
    const userVisibleFailureMessage =
      userVisibleFailure === null
        ? undefined
        : redactCredentials(
            stripAnsi(sanitizeErrorMessage(userVisibleFailure.message))
          );
    const trustedUserVisibleFailure =
      userVisibleFailure === null
        ? undefined
        : {
            ...toUserVisibleLoopFailurePayload(userVisibleFailure),
            message: userVisibleFailureMessage ?? userVisibleFailure.message,
          };
    if (!wasCancelled && trustedUserVisibleFailure && existingJob && jobStore) {
      const latestJob = jobStore.getByLoopId(loopId) ?? existingJob;
      jobStore.upsert({
        ...latestJob,
        userVisibleLoopFailure: trustedUserVisibleFailure,
        updatedAt: new Date().toISOString(),
      });
    }

    if (!wasCancelled) {
      if (trustedUserVisibleFailure) {
        loopError(
          loopId,
          `User-visible runner failure detected: ${trustedUserVisibleFailure.code} ${trustedUserVisibleFailure.result.subcode}`
        );
        gatewayLog.error(
          "loop-harness",
          `${command} reported user-visible runner failure, loopId=${loopId}, code=${trustedUserVisibleFailure.code}, subcode=${trustedUserVisibleFailure.result.subcode}`
        );
        await postFailureLoopEvent({
          ...failureEventBase,
          code: trustedUserVisibleFailure.code,
          message: trustedUserVisibleFailure.message,
          result: trustedUserVisibleFailure.result,
        });
      } else if (isContextLimit) {
        const limitMsg = jsonlError ?? "Context limit exceeded";
        loopError(loopId, `Context limit detected: ${limitMsg}`);
        gatewayLog.error(
          "loop-harness",
          `${command} hit context limit, loopId=${loopId}: ${limitMsg}`
        );
        await postFailureLoopEvent({
          ...failureEventBase,
          code: LoopErrorCode.ContextLimitExceeded,
          message: limitMsg,
        });
      } else if (isAuthChallenge) {
        const authMsg = jsonlAuthError ?? "Claude auth challenge detected";
        loopError(loopId, `Auth challenge detected: ${authMsg}`);
        gatewayLog.error(
          "loop-harness",
          `${command} hit auth challenge, loopId=${loopId}: ${authMsg}`
        );
        Observability.jobAuthChallenge(
          commandId ?? existingJob?.commandId,
          operationId ?? existingJob?.operationId,
          loopId,
          exitCode,
          diagnostics,
          failureSessionId
        );
        await postFailureLoopEvent({
          ...failureEventBase,
          code: LoopErrorCode.AuthChallenge,
          message: authMsg,
        });
      } else {
        loopError(loopId, `Process failed with exit code ${exitCode}`);
        gatewayLog.error(
          "loop-harness",
          `${command} failed with exit code ${exitCode}, loopId=${loopId}`
        );
        await postFailureLoopEvent({
          ...failureEventBase,
          code: LoopErrorCode.ProcessFailed,
          message: `Process exited with code ${exitCode}`,
        });
      }
    }

    if (existingJob && jobStore) {
      const now = new Date().toISOString();
      const latestJob = jobStore.getByLoopId(loopId) ?? existingJob;

      let liveActivity: string | undefined;
      if (!wasCancelled) {
        if (trustedUserVisibleFailure) {
          liveActivity = trustedUserVisibleFailure.message;
        } else if (isContextLimit) {
          liveActivity = "Context limit exceeded";
        } else if (isAuthChallenge) {
          liveActivity = `Auth challenge: ${jsonlAuthError ?? "authentication error"}`;
        }
      }

      jobStore.upsert({
        ...latestJob,
        status: wasCancelled ? "CANCELLED" : "FAILED",
        liveActivity,
        exitCode,
        warning: mergeWarningEntries(latestJob.warning, failureWarnings),
        updatedAt: now,
        completedAt: now,
        ...(wasCancelled
          ? {}
          : {
              finalStatusPersistedAt: latestJob.finalStatusPersistedAt ?? now,
              ...(failureCloudFinalized
                ? {
                    cloudFinalizedAt: latestJob.cloudFinalizedAt ?? now,
                    lastRecoveryError: undefined,
                  }
                : failureRemoteError
                  ? { lastRecoveryError: failureRemoteError }
                  : {}),
            }),
      });
    }
    if (tempCleanupDir) {
      fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(() => {});
    } else if (
      (command === LoopCommand.GeneratePrd ||
        command === LoopCommand.RequestPrdChanges) &&
      worktreeDir &&
      expandedRepoPath
    ) {
      await wt.removeWorktree(worktreeDir, expandedRepoPath, loopId);
    }
    await cleanupAdditionalWorktrees(additionalWorktreeDirs, loopId, wt);
    // Schedulers (heartbeat, refresh, sleep) are always torn down when the
    // process exits — the loop is dead regardless of whether cloud finalization
    // succeeded. Token deletion is conditional: keep the token when the event
    // POST failed with a retryable network error so boot-recovery can retry.
    schedulers?.teardownLoop(loopId);
    if (wasCancelled || failureCloudFinalized || !failureRetryableFailure) {
      loopTokenStore?.deleteLoopToken(loopId);
    }
    return;
  }

  // exitCode === 0 success path -- keep in runningLoops until post-processing completes
  try {
    // Read outputs per command
    gatewayLog.info(
      "loop-harness",
      `${command} succeeded (exit 0), reading artifacts for loopId=${loopId}`
    );
    let artifacts: LoopOutputArtifacts = {};
    const metadata: Record<string, unknown> = {};
    const warnings: string[] = [];
    let executeFinalization: ExecuteFinalizationResult | null = null;

    if (
      command === LoopCommand.Plan ||
      command === LoopCommand.RequestChanges
    ) {
      artifacts = readPlanOutputs(claudeWorkDir);
    } else if (command === LoopCommand.Execute) {
      const baseBranch = body.repo?.branch ?? "main";

      // Cancellation gate: skip execute finalization if cancelled during main process
      if (isCancelled(jobStore, loopId)) {
        const cancelJob = jobStore?.getByLoopId(loopId);
        if (cancelJob && jobStore) {
          const now = new Date().toISOString();
          jobStore.upsert({
            ...cancelJob,
            status: "CANCELLED",
            updatedAt: now,
            completedAt: now,
          });
        }
        if (tempCleanupDir) {
          fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(
            () => {}
          );
        }
        schedulers?.teardownLoop(loopId);
        loopTokenStore?.deleteLoopToken(loopId);
        return;
      }

      executeFinalization = await runExecuteFinalization({
        worktreeDir,
        claudeWorkDir,
        loopId,
        artifactSlug: body.artifactSlug,
        baseBranch,
        webAppOrigin: webAppOrigin ?? "",
        committer,
        getAllowedDirectories,
        expectedMcpUrl,
        jobStore,
        source: "live-exit",
        getClaudeShellEnv,
        primaryFullName: resolveLoopPrimaryFullName(body, expandedRepoPath),
      });

      // Cancellation gate: skip finalization upload/event work if cancellation won
      // while execute post-processing was running.
      if (isCancelled(jobStore, loopId)) {
        const cancelJob = jobStore?.getByLoopId(loopId);
        if (cancelJob && jobStore) {
          const now = new Date().toISOString();
          jobStore.upsert({
            ...cancelJob,
            status: "CANCELLED",
            updatedAt: now,
            completedAt: now,
          });
        }
        if (tempCleanupDir) {
          fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(
            () => {}
          );
        }
        schedulers?.teardownLoop(loopId);
        loopTokenStore?.deleteLoopToken(loopId);
        return;
      }

      if (executeFinalization.status === "no-changes") {
        gatewayLog.info(
          "loop-harness",
          `no local changes detected, skipping PR creation, loopId=${loopId}`
        );
      } else if (executeFinalization.status === "error") {
        const finalizationReason =
          executeFinalization.reason ?? "unknown execute finalization error";
        if (executeFinalization.isAuthChallenge === true) {
          gatewayLog.error(
            "loop-harness",
            "execute finalization auth challenge detected: " +
              sanitizeErrorMessage(finalizationReason) +
              ", loopId=" +
              loopId
          );
          const finalizationSessionId = readTextFile(
            path.join(claudeWorkDir, "session-id.txt")
          )?.trim();
          Observability.jobAuthChallenge(
            commandId,
            operationId,
            loopId,
            0,
            elapsedMs === undefined ? undefined : { elapsedMs },
            finalizationSessionId
          );
          runningLoops.delete(loopId);
          const finalizationBranchName = worktreeDir
            ? (wt.getCurrentBranch(worktreeDir) ?? undefined)
            : undefined;
          await postLoopEvent(apiBaseUrl, loopId, () => closedLoopAuthToken, {
            type: LoopEventType.Error,
            code: LoopErrorCode.AuthChallenge,
            message: finalizationReason,
            loopId,
            sessionId: finalizationSessionId,
            ...(finalizationBranchName
              ? { branchName: finalizationBranchName }
              : {}),
            elapsedMs,
          });
          if (jobStore) {
            const latestJob = jobStore.getByLoopId(loopId);
            if (latestJob) {
              const now = new Date().toISOString();
              jobStore.upsert({
                ...latestJob,
                status: "FAILED",
                liveActivity: `Auth challenge: ${finalizationReason}`,
                updatedAt: now,
                completedAt: now,
                finalStatusPersistedAt: latestJob.finalStatusPersistedAt ?? now,
              });
            }
          }
          if (tempCleanupDir) {
            fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(
              () => {}
            );
          }
          await cleanupAdditionalWorktrees(additionalWorktreeDirs, loopId, wt);
          schedulers?.teardownLoop(loopId);
          loopTokenStore?.deleteLoopToken(loopId);
          return;
        }
        gatewayLog.warn(
          "loop-harness",
          "execute finalization failed: " +
            sanitizeErrorMessage(finalizationReason) +
            ", loopId=" +
            loopId
        );
        warnings.push("GIT_PUSH_FAILED");
      }

      // Additional repos are finalized after the primary so the primary PR info
      // is not overwritten by a second clean-worktree check. Recovery calls the
      // same helper from `finalizeLoopFromRuntime` so this work is replayed if
      // the desktop crashes after primary finalization but before this block
      // persists the combined V2 envelope.
      if (additionalWorktreeDirs.length > 0 && worktreeDir) {
        const primaryFullName = resolveLoopPrimaryFullName(
          body,
          expandedRepoPath
        );
        await finalizeAdditionalReposAndPersist({
          additionalEntries: additionalWorktreeDirs,
          primaryFullName,
          primaryBaseBranch: baseBranch,
          executeFinalization,
          claudeWorkDir,
          loopId,
          apiBaseUrl,
          getToken: () => body.closedLoopAuthToken,
          webAppOrigin: webAppOrigin ?? "",
          getAllowedDirectories,
          artifactSlug: body.artifactSlug,
          expectedMcpUrl,
          committer,
          getClaudeShellEnv,
        });
      }

      artifacts = readExecuteOutputs(claudeWorkDir);
      if (
        "branchName" in executeFinalization &&
        executeFinalization.branchName
      ) {
        metadata.branchName = executeFinalization.branchName;
      }
      if (!jobStore) {
        metadata.finalizationSource = "live-exit";
        metadata.executeFinalizationStatus = executeFinalization.status;
        metadata.executeFinalizationPath = executeFinalization.path;
        if (executeFinalization.reason) {
          metadata.executeFinalizationReason = executeFinalization.reason;
        }
      }
    } else if (command === LoopCommand.Decompose) {
      artifacts = readDecomposeOutputs(worktreeDir ?? claudeWorkDir);
    } else if (
      command === LoopCommand.EvaluatePrd ||
      command === LoopCommand.EvaluatePlan ||
      command === LoopCommand.EvaluateCode ||
      command === LoopCommand.EvaluateFeature
    ) {
      artifacts = readEvaluateOutputs(
        claudeWorkDir,
        EVALUATE_COMMAND_ARTIFACT[command]
      );
    } else if (
      command === LoopCommand.GeneratePrd ||
      command === LoopCommand.RequestPrdChanges
    ) {
      // REQUEST_PRD_CHANGES re-runs the same PRD agent and writes prd.md to
      // the same worktree path; the read-side artifact extraction is identical.
      artifacts = readGeneratePrdOutputs(worktreeDir ?? claudeWorkDir);
    } else if (command === LoopCommand.Bootstrap) {
      artifacts = readBootstrapOutputs(claudeWorkDir);
    }

    // Validate result bundle — warn if required artifacts are missing for this command
    const artifactDir = worktreeDir ?? claudeWorkDir;
    const presentFiles = Object.values(LoopArtifactFile).filter(
      (f) =>
        existsSync(path.join(artifactDir, f)) ||
        existsSync(path.join(claudeWorkDir, f))
    );
    const missingRequired = validateResultBundle(command, presentFiles);
    if (missingRequired.length > 0) {
      gatewayLog.warn(
        "loop-harness",
        `Missing required artifacts for ${command}: ${missingRequired.join(", ")}, loopId=${loopId}`
      );
    }

    // Read session ID if available
    const sessionFile = path.join(claudeWorkDir, "session-id.txt");
    const sessionId = readTextFile(sessionFile);
    if (sessionId) {
      metadata.sessionId = sessionId.trim();
    }

    // JobStore-backed loops: `finalizeLoopFromRuntime` owns artifact upload + completed event.
    if (!jobStore) {
      const artifactKeys = Object.keys(artifacts);
      loopLog(loopId, "Artifact keys:", artifactKeys);
      gatewayLog.info(
        "loop-harness",
        `Uploading artifacts for ${command} loopId=${loopId}: [${artifactKeys.join(", ")}]`
      );
      const uploadResult = await uploadArtifacts(
        apiBaseUrl,
        loopId,
        () => closedLoopAuthToken,
        {
          artifacts,
          metadata,
        }
      );
      if (!uploadResult.success) {
        gatewayLog.warn(
          "loop-harness",
          "Artifact upload failed: " +
            (uploadResult.error ?? "unknown error") +
            ", loopId=" +
            loopId
        );
        warnings.push("ARTIFACT_UPLOAD_FAILED");
      }
    }

    // Parse token usage from claude output
    const {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      turns,
      models,
      tokensByModel,
    } = parseTokenUsage(claudeWorkDir);
    const tokensUsed = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      turns,
      models,
    };
    loopLog(
      loopId,
      `Tokens used: input=${tokensUsed.inputTokens}, output=${tokensUsed.outputTokens}, cacheCreation=${tokensUsed.cacheCreationInputTokens}, cacheRead=${tokensUsed.cacheReadInputTokens}, turns=${tokensUsed.turns}`
    );

    // Detect 0-token EXECUTE completions as failures (ghost loop)
    if (
      !jobStore &&
      isExecuteNoWorkCompletion(command, tokensUsed) &&
      !isAcceptedExecuteFinalization(executeFinalization)
    ) {
      const noWorkMsg = EXECUTE_NO_WORK_MESSAGE;
      loopError(loopId, noWorkMsg);
      gatewayLog.error("loop-harness", `${noWorkMsg}, loopId=${loopId}`);
      runningLoops.delete(loopId);
      await postLoopEvent(apiBaseUrl, loopId, () => closedLoopAuthToken, {
        type: LoopEventType.Error,
        code: LoopErrorCode.NoWorkProduced,
        message: noWorkMsg,
        loopId,
        abortReason: "ghost-loop",
        elapsedMs,
      });
      if (tempCleanupDir) {
        fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(() => {});
      }
      schedulers?.teardownLoop(loopId);
      loopTokenStore?.deleteLoopToken(loopId);
      return;
    }

    // Cancellation gate: skip completed event if cancelled during post-processing
    if (isCancelled(jobStore, loopId)) {
      const cancelJob = jobStore?.getByLoopId(loopId);
      if (cancelJob && jobStore) {
        const now = new Date().toISOString();
        jobStore.upsert({
          ...cancelJob,
          status: "CANCELLED",
          updatedAt: now,
          completedAt: now,
        });
      }
      if (tempCleanupDir) {
        fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(() => {});
      } else if (
        (command === LoopCommand.GeneratePrd ||
          command === LoopCommand.RequestPrdChanges) &&
        worktreeDir &&
        expandedRepoPath
      ) {
        await wt.removeWorktree(worktreeDir, expandedRepoPath, loopId);
      }
      await cleanupAdditionalWorktrees(additionalWorktreeDirs, loopId, wt);
      schedulers?.teardownLoop(loopId);
      loopTokenStore?.deleteLoopToken(loopId);
      return;
    }

    if (warnings.length > 0 && jobStore) {
      const existingJob = jobStore.getByLoopId(loopId);
      if (existingJob) {
        jobStore.upsert({
          ...existingJob,
          warning: mergeWarningEntries(existingJob.warning, warnings),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (command === LoopCommand.Execute) {
      const currentJob = jobStore?.getByLoopId(loopId);
      emitExecuteDecisionTableVerificationTelemetry({
        loopId,
        commandId: commandId ?? currentJob?.commandId,
        operationId: operationId ?? currentJob?.operationId,
        claudeWorkDir,
        decisionTableVerificationStartOffset,
      });
    }

    runningLoops.delete(loopId);
    const existingJob = jobStore?.getByLoopId(loopId);
    if (existingJob && jobStore) {
      gatewayLog.info(
        "loop-harness",
        `Finalizing ${command} via JobStore, loopId=${loopId}`
      );
      const finalizerDeps: LoopFinalizerDeps = {
        jobStore,
        telemetry: { emit: () => {} },
        getToken: () => closedLoopAuthToken,
        apiBaseUrl,
        isProcessRunning,
        getAllowedDirectories,
        loopTokenStore,
        schedulers,
        onLoopCompleted,
      };
      const outcome = await finalizeLoopFromRuntime(
        existingJob,
        "live-exit",
        finalizerDeps
      );
      if (!outcome.cloudFinalized) {
        gatewayLog.error(
          "loop-harness",
          `Cloud finalization failed for ${command} loopId=${loopId}: ${outcome.error ?? "unknown"}, retryable=${outcome.retryableFailure}`
        );
      }
      const sessionId = readTextFile(
        path.join(claudeWorkDir, "session-id.txt")
      );
      const normalizedSessionId = sessionId?.trim();
      Observability.jobCompleted(
        commandId ?? existingJob.commandId,
        operationId ?? existingJob.operationId,
        loopId,
        undefined,
        normalizedSessionId && normalizedSessionId.length > 0
          ? normalizedSessionId
          : undefined,
        body.command
      );
    } else {
      // Legacy completion path: route-level behavior when no JobStore is present.
      // Upload already ran above (no jobStore branch).
      const result: Record<string, unknown> = {
        exitCode,
        subtype: command.toLowerCase(),
      };
      if (command === LoopCommand.Execute && artifacts.executionResult) {
        const parsed = parseExecutionResultFile(artifacts.executionResult, "");
        const lookupName = parsed.ok ? (parsed.results[0]?.fullName ?? "") : "";
        const primary = parsed.ok
          ? getPrimaryRepoResult(parsed.results, lookupName)
          : null;
        if (primary?.status === "success") {
          result.prUrl = primary.prUrl;
          result.prNumber = primary.prNumber;
          result.branchName = primary.branchName;
          result.has_changes = primary.hasChanges;
        } else if (primary?.status === "skipped") {
          // A skipped repo had no changes to push; surface the standard
          // no-changes shape so consumers handle it uniformly.
          result.prUrl = null;
          result.prNumber = null;
          result.has_changes = false;
        }
      }
      if (command === LoopCommand.Execute && executeFinalization) {
        result.finalizationSource = "live-exit";
        result.executeFinalizationStatus = executeFinalization.status;
        result.executeFinalizationPath = executeFinalization.path;
        if (executeFinalization.reason) {
          result.executeFinalizationReason = executeFinalization.reason;
        }
      }
      if (worktreeDir && !result.branchName) {
        const branch = wt.getCurrentBranch(worktreeDir);
        if (branch) {
          result.branchName = branch;
        }
      }
      const legacySessionId = sessionId?.trim();
      if (legacySessionId) {
        result.sessionId = legacySessionId;
      }

      const completedEvent: Record<string, unknown> = {
        type: LoopEventType.Completed,
        result,
        tokensUsed: {
          input: tokensUsed.inputTokens,
          output: tokensUsed.outputTokens,
          cacheCreationInputTokens: tokensUsed.cacheCreationInputTokens,
          cacheReadInputTokens: tokensUsed.cacheReadInputTokens,
          turns: tokensUsed.turns,
          models: tokensUsed.models,
        },
        tokensByModel,
        loopId,
        ...(warnings.length > 0 ? { warnings } : {}),
      };

      const eventResult = await postLoopEvent(
        apiBaseUrl,
        loopId,
        () => closedLoopAuthToken,
        completedEvent
      );
      if (!eventResult.success) {
        warnings.push("EVENT_POST_FAILED");
      }

      Observability.jobCompleted(
        commandId,
        operationId,
        loopId,
        undefined,
        legacySessionId,
        body.command
      );
      schedulers?.teardownLoop(loopId);
      loopTokenStore?.deleteLoopToken(loopId);
    }

    // Clean up temp claude workdir after all reads and uploads are complete
    if (tempCleanupDir) {
      fs.rm(tempCleanupDir, { recursive: true, force: true }).catch(() => {});
    } else if (
      (command === LoopCommand.GeneratePrd ||
        command === LoopCommand.RequestPrdChanges) &&
      worktreeDir &&
      expandedRepoPath
    ) {
      await wt.removeWorktree(worktreeDir, expandedRepoPath, loopId);
    }

    await cleanupAdditionalWorktrees(additionalWorktreeDirs, loopId, wt);
  } finally {
    runningLoops.delete(loopId);
  }
}

// ---------------------------------------------------------------------------
// Additional-repo worktree provisioning shared by PLAN and EXECUTE branches.
// On failure, unwinds the partially-created worktree set (already-pushed
// additionals + primary), posts a LoopEvent.Error, writes the HTTP error, and
// returns false so the caller can `return` early.
// ---------------------------------------------------------------------------

async function provisionAdditionalRepoWorktrees(args: {
  resolvedAdditionalRepos: readonly ResolvedAdditionalRepo[];
  worktreeKey: string;
  worktreeDir: string;
  primaryRepoPath: string;
  additionalWorktreeDirs: AdditionalWorktreeEntry[];
  allowedDirs: string[];
  body: SymphonyLoopRequestBody;
  apiBaseUrl: string;
  context: OperationRequestContext;
  wt: WorktreeProvider;
  freshLabel: string;
  // True only when the caller created the primary worktree fresh in this
  // request. EXECUTE/REQUEST_CHANGES that reuse a parent PLAN's worktree
  // must pass false so failures here do not delete the parent's checkout.
  ownsPrimaryWorktree: boolean;
  // PLAN passes false: stale additional-repo worktrees are force-removed so
  // PLAN starts fresh. EXECUTE/REQUEST_CHANGES pass true so a retained dirty
  // worktree from a prior failed/cancelled attempt (kept by
  // cleanupAdditionalWorktrees to avoid data loss) is reused instead of
  // force-removed by --force/fs.rm.
  reuseStaleWorktree: boolean;
}): Promise<boolean> {
  const {
    resolvedAdditionalRepos,
    worktreeKey,
    worktreeDir,
    primaryRepoPath,
    additionalWorktreeDirs,
    allowedDirs,
    body,
    apiBaseUrl,
    context,
    wt,
    freshLabel,
    ownsPrimaryWorktree,
    reuseStaleWorktree,
  } = args;

  for (let addIdx = 0; addIdx < resolvedAdditionalRepos.length; addIdx++) {
    const addRepo = resolvedAdditionalRepos[addIdx];
    const requestEntry = body.additionalRepos?.[addIdx];
    // Best identifier for the offending peer in user-visible event messages:
    // prefer the requested fullName, fall back to the resolved local repo's
    // git config, and finally the bare repoPath. Used by both the
    // RepoNotAllowed and BranchCreateFailed envelopes below.
    const peerOffenderLabel = (): string =>
      requestEntry?.fullName ??
      resolveRepoFullName(addRepo.repoPath) ??
      addRepo.repoPath;
    const baseBranch = addRepo.branch;
    let repositoryFullName =
      requestEntry?.fullName ?? resolveRepoFullName(addRepo.repoPath) ?? "";
    const addRepoSlug = slugifyLoopId(baseBranch);
    const addRepoKey = `${worktreeKey}-${addRepoSlug}-${additionalRepoDisambiguator(addRepo.repoPath)}`;
    const canonicalAddWorktreeDir = resolveLoopWorktreeDir(
      addRepo.repoPath,
      addRepoKey
    );
    const legacyAddBranchName = `symphony/${addRepoKey}`;
    const useBranchMaterialization = shouldUseBranchMaterialization(body);
    let expectedBranch: SymphonyBranchMaterializationEntry | null = null;
    if (useBranchMaterialization) {
      try {
        repositoryFullName = requireVerifiedLoopRepositoryFullName({
          declaredFullName: requestEntry?.fullName,
          repoPath: addRepo.repoPath,
          role: "additional",
        });
        expectedBranch = requireExpectedLoopBranch({
          body,
          role: "additional",
          repositoryFullName,
          baseBranch,
        });
      } catch (err) {
        const msg = sanitizeUnknownError(err);
        await cleanupAdditionalWorktrees(
          additionalWorktreeDirs,
          body.loopId,
          wt
        );
        if (ownsPrimaryWorktree) {
          await wt
            .removeWorktree(worktreeDir, primaryRepoPath, body.loopId)
            .catch(() => {});
        }
        const offender = peerOffenderLabel();
        await postLoopEventBounded(
          apiBaseUrl,
          body.loopId,
          () => body.closedLoopAuthToken,
          {
            type: LoopEventType.Error,
            code: LoopErrorCode.BranchCreateFailed,
            message: `Additional repo branch materialization is not available for ${offender}: ${msg}`,
          }
        );
        json(context, 500, {
          error: `Additional repo branch materialization is not available for ${offender}: ${msg}`,
        });
        return false;
      }
    }
    const addBranchName = expectedBranch?.branchName ?? legacyAddBranchName;

    const staleAddWorktree =
      expectedBranch === null
        ? wt.findWorktreeForBranch(addRepo.repoPath, legacyAddBranchName)
        : wt.findWorktreeForBranch(addRepo.repoPath, expectedBranch.branchName);
    const reuseExisting = reuseStaleWorktree && staleAddWorktree !== null;
    const addWorktreeDir =
      reuseExisting && staleAddWorktree
        ? staleAddWorktree
        : canonicalAddWorktreeDir;

    try {
      assertPathAllowed(addWorktreeDir, allowedDirs);
    } catch (e) {
      if (e instanceof DirectoryNotAllowedError) {
        await cleanupAdditionalWorktrees(
          additionalWorktreeDirs,
          body.loopId,
          wt
        );
        if (ownsPrimaryWorktree) {
          await wt
            .removeWorktree(worktreeDir, primaryRepoPath, body.loopId)
            .catch(() => {});
        }
        const offender = peerOffenderLabel();
        await postLoopEventBounded(
          apiBaseUrl,
          body.loopId,
          () => body.closedLoopAuthToken,
          {
            type: LoopEventType.Error,
            code: LoopErrorCode.RepoNotAllowed,
            message: `Additional repo worktree path not allowed for ${offender}: ${addWorktreeDir}`,
          }
        );
        json(context, 403, {
          error: `Additional repo worktree path not allowed for ${offender}: ${addWorktreeDir}`,
        });
        return false;
      }
      throw e;
    }

    try {
      if (reuseExisting) {
        loopLog(
          body.loopId,
          `Reusing retained additional-repo worktree for ${freshLabel}: ${addWorktreeDir} (branch: ${addBranchName})`
        );
      } else {
        if (staleAddWorktree) {
          loopLog(
            body.loopId,
            `Removing stale additional-repo worktree for fresh ${freshLabel}: ${staleAddWorktree}`
          );
          await wt.removeWorktree(
            staleAddWorktree,
            addRepo.repoPath,
            body.loopId
          );
        }
        await ensureLoopWorktreeForRequest({
          body,
          expandedRepoPath: addRepo.repoPath,
          worktreeDir: addWorktreeDir,
          branchName: addBranchName,
          baseBranch,
          loopId: body.loopId,
          repositoryFullName,
          apiBaseUrl,
          token: body.closedLoopAuthToken,
          wt,
        });
      }
    } catch (checkoutErr) {
      const msg = sanitizeUnknownError(checkoutErr);
      loopError(
        body.loopId,
        `ensureLoopWorktreeMaterialized failed for additional repo ${addRepo.repoPath}: ${msg}`
      );
      await wt
        .removeWorktree(addWorktreeDir, addRepo.repoPath, body.loopId)
        .catch(() => {});
      await cleanupAdditionalWorktrees(additionalWorktreeDirs, body.loopId, wt);
      if (ownsPrimaryWorktree) {
        await wt
          .removeWorktree(worktreeDir, primaryRepoPath, body.loopId)
          .catch(() => {});
      }
      const offender = peerOffenderLabel();
      await postLoopEventBounded(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        {
          type: LoopEventType.Error,
          code: LoopErrorCode.BranchCreateFailed,
          message: `Failed to checkout additional repo worktree for ${offender}: ${msg}`,
        }
      );
      json(context, 500, {
        error: `Failed to checkout additional repo worktree for ${offender}: ${msg}`,
      });
      return false;
    }

    additionalWorktreeDirs.push({
      dir: addWorktreeDir,
      repoPath: addRepo.repoPath,
      fullName:
        requestEntry?.fullName ??
        resolveRepoFullName(addRepo.repoPath) ??
        undefined,
      baseBranch: requestEntry?.branch ?? baseBranch,
    });
    loopLog(
      body.loopId,
      reuseExisting
        ? `Reused additional repo worktree: ${addWorktreeDir} (branch: ${addBranchName})`
        : `Created additional repo worktree: ${addWorktreeDir} (branch: ${addBranchName} based on ${addRepo.branch})`
    );
  }
  return true;
}

/**
 * Branch-prefix metadata for the two PRD-side commands. Both produce
 * always-fresh worktrees on a dedicated `symphony/<prefix>-...` branch
 * namespace (see MultiRepoCommandPolicy.worktreeFreshness === "always-fresh");
 * the only differences are the prefix string and the freshLabel used in logs
 * and provisionAdditionalRepoWorktrees event messages.
 */
const PRD_BRANCH_CONFIG = {
  [LoopCommand.GeneratePrd]: {
    prefix: "generate-prd",
    label: LoopCommand.GeneratePrd,
  },
  [LoopCommand.RequestPrdChanges]: {
    prefix: "request-prd-changes",
    label: LoopCommand.RequestPrdChanges,
  },
} as const;

/**
 * Provision the primary worktree, peer worktrees, and claude work dir for a
 * PRD-side command (GENERATE_PRD or REQUEST_PRD_CHANGES). Both commands share
 * an identical setup pipeline differing only in branch prefix; this helper
 * eliminates the previous near-byte-identical 80-line duplication between the
 * two branches in handleLoopRequest.
 *
 * On success: returns { worktreeDir, claudeWorkDir }.
 * On failure: returns null AFTER having sent the appropriate JSON response
 * (403 / etc.) and torn down any partial worktree state.
 */
async function setupPrdWorktree(args: {
  command:
    | typeof LoopCommand.GeneratePrd
    | typeof LoopCommand.RequestPrdChanges;
  body: SymphonyLoopRequestBody;
  expandedRepoPath: string;
  resolvedAdditionalRepos: readonly ResolvedAdditionalRepo[];
  additionalWorktreeDirs: AdditionalWorktreeEntry[];
  allowedDirs: string[];
  apiBaseUrl: string;
  context: OperationRequestContext;
  wt: WorktreeProvider;
}): Promise<{ worktreeDir: string; claudeWorkDir: string } | null> {
  const {
    command,
    body,
    expandedRepoPath,
    resolvedAdditionalRepos,
    additionalWorktreeDirs,
    allowedDirs,
    apiBaseUrl,
    context,
    wt,
  } = args;
  const { prefix, label } = PRD_BRANCH_CONFIG[command];

  const sanitizedSlug = body.artifactSlug
    ? slugifyLoopId(body.artifactSlug)
    : null;
  const worktreeKey = sanitizedSlug ?? pickStableId(body);
  const worktreeDir = resolveLoopWorktreeDir(
    expandedRepoPath,
    `${prefix}-${worktreeKey}`
  );
  const baseBranch = body.repo?.branch ?? "main";
  const useBranchMaterialization = shouldUseBranchMaterialization(body);
  let repositoryFullName = resolveLoopPrimaryFullName(body, expandedRepoPath);
  if (useBranchMaterialization) {
    try {
      repositoryFullName = requireVerifiedLoopRepositoryFullName({
        declaredFullName: body.repo?.fullName,
        repoPath: expandedRepoPath,
        role: "primary",
      });
      assertPathAllowed(worktreeDir, allowedDirs);
    } catch (err) {
      if (err instanceof DirectoryNotAllowedError) {
        json(context, 403, {
          error: `Worktree path not allowed: ${worktreeDir}`,
        });
        return null;
      }
      await failBranchCreate({
        body,
        apiBaseUrl,
        context,
        message: `${command} branch materialization is not available: ${sanitizeUnknownError(err)}`,
      });
      return null;
    }
  }
  let branchName = `symphony/${prefix}-${worktreeKey}`;
  if (useBranchMaterialization) {
    let expectedBranch: SymphonyBranchMaterializationEntry;
    try {
      expectedBranch = requireExpectedLoopBranch({
        body,
        role: "primary",
        repositoryFullName,
        baseBranch,
      });
    } catch (err) {
      await failBranchCreate({
        body,
        apiBaseUrl,
        context,
        message: `${command} branch materialization is not available: ${sanitizeUnknownError(err)}`,
      });
      return null;
    }
    branchName = expectedBranch.branchName;
  }

  const branchMaterializationPreflightOk =
    await preflightAdditionalRepoBranchMaterialization({
      resolvedAdditionalRepos,
      worktreeKey,
      allowedDirs,
      body,
      apiBaseUrl,
      context,
      wt,
      reuseStaleWorktree:
        getMultiRepoPolicy(command).worktreeFreshness === "reuse-stale",
    });
  if (!branchMaterializationPreflightOk) {
    return null;
  }

  // Always-fresh per policy — destroy any prior worktree at this branch.
  const staleWorktree = wt.findWorktreeForBranch(expandedRepoPath, branchName);
  if (staleWorktree) {
    loopLog(
      body.loopId,
      `Removing stale worktree for fresh ${command}: ${staleWorktree}`
    );
    await wt.removeWorktree(staleWorktree, expandedRepoPath, body.loopId);
  }

  try {
    await ensureLoopWorktreeForRequest({
      body,
      expandedRepoPath,
      worktreeDir,
      branchName,
      baseBranch,
      loopId: body.loopId,
      repositoryFullName,
      apiBaseUrl,
      token: body.closedLoopAuthToken,
      wt,
    });
  } catch (err) {
    const msg = sanitizeUnknownError(err);
    loopError(
      body.loopId,
      `ensureLoopWorktreeMaterialized failed for ${command}: ${msg}`
    );
    await wt
      .removeWorktree(worktreeDir, expandedRepoPath, body.loopId)
      .catch(() => {});
    await failBranchCreate({
      body,
      apiBaseUrl,
      context,
      message: `Failed to materialize ${command} branch: ${msg}`,
    });
    return null;
  }
  loopLog(
    body.loopId,
    `Created worktree for ${command}: ${worktreeDir} (branch: ${branchName})`
  );

  if (!useBranchMaterialization) {
    try {
      assertPathAllowed(worktreeDir, allowedDirs);
    } catch (e) {
      if (e instanceof DirectoryNotAllowedError) {
        await wt.removeWorktree(worktreeDir, expandedRepoPath, body.loopId);
        json(context, 403, {
          error: `Worktree path not allowed: ${worktreeDir}`,
        });
        return null;
      }
      throw e;
    }
  }

  const additionalsOk = await provisionAdditionalRepoWorktrees({
    resolvedAdditionalRepos,
    worktreeKey: `${prefix}-${worktreeKey}`,
    worktreeDir,
    primaryRepoPath: expandedRepoPath,
    additionalWorktreeDirs,
    allowedDirs,
    body,
    apiBaseUrl,
    context,
    wt,
    freshLabel: label,
    ownsPrimaryWorktree: true,
    reuseStaleWorktree:
      getMultiRepoPolicy(body.command).worktreeFreshness === "reuse-stale",
  });
  if (!additionalsOk) {
    return null;
  }

  // claudeWorkDir is a separate operational dir inside the worktree (same
  // pattern as PLAN/EXECUTE). Spawn uses cwd: worktreeDir so Claude writes
  // prd.md to the repo root; logs, PID, prompt file go to claudeWorkDir.
  const claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await writeArtifactsForGeneratePrd(
    worktreeDir,
    body.artifacts,
    body.prompt!,
    body.repo,
    additionalWorktreeDirs
  );

  return { worktreeDir, claudeWorkDir };
}

// ---------------------------------------------------------------------------
// Main route handler
// ---------------------------------------------------------------------------

async function handleLoopRequest(
  context: OperationRequestContext,
  getAllowedDirectories: () => string[],
  schedulers: LoopSchedulerContext,
  getApiOrigin?: () => string,
  jobStore?: JobStore,
  getWebAppOrigin?: () => string,
  worktreeProvider?: WorktreeProvider,
  loopTokenStore?: LoopTokenStore,
  getSymphonyDir?: () => string,
  popDeps?: LoopPopDeps,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv,
  onLoopCompleted?: LoopCompletedHook
): Promise<void> {
  const wt = worktreeProvider ?? defaultWorktreeProvider;
  // Derive the callback URL from the gateway's trusted configuration.
  // body.apiBaseUrl is ignored -- the caller does not control where
  // loop events and artifact uploads are sent.
  const apiBaseUrl = getApiOrigin?.();
  if (!apiBaseUrl) {
    json(context, 503, { error: "API origin not configured" });
    return;
  }
  const webAppOrigin = getWebAppOrigin?.() ?? "";

  const rawBody = parseJsonBody(context);
  if (!rawBody) {
    json(context, 400, { error: "Invalid JSON body" });
    return;
  }

  let body: SymphonyLoopRequestBody;
  try {
    body = parseSymphonyLoopRequestBody(rawBody);
  } catch (err) {
    if (err instanceof SymphonyLoopRequestValidationError) {
      json(context, 400, { error: err.message });
      return;
    }
    throw err;
  }
  const expectedMcpUrl =
    typeof rawBody.expectedMcpUrl === "string"
      ? rawBody.expectedMcpUrl
      : undefined;

  const bodyAgents = body.agents;
  const bodyRepoConfigs = body.repoConfigs;

  // Extract tracing headers forwarded by the cloud command executor.
  // Use typeof guards because IncomingMessage headers values are string | string[] | undefined.
  const commandId =
    typeof context.request?.headers?.["x-desktop-command-id"] === "string"
      ? context.request.headers["x-desktop-command-id"]
      : undefined;
  const operationId =
    typeof context.request?.headers?.["x-desktop-operation-id"] === "string"
      ? context.request.headers["x-desktop-operation-id"]
      : undefined;

  const repoRequirement =
    REPO_REQUIREMENT_BY_COMMAND[body.command] ?? "NOT_REQUIRED";

  if (!(body.loopId && body.command && body.closedLoopAuthToken)) {
    json(context, 400, {
      error: "Missing required fields: loopId, command, closedLoopAuthToken",
    });
    return;
  }

  if (!VALID_COMMANDS.has(body.command)) {
    json(context, 400, { error: `Invalid command: ${body.command}` });
    return;
  }

  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      body.loopId
    )
  ) {
    json(context, 400, { error: "loopId must be a valid UUID" });
    return;
  }

  if (!Array.isArray(body.artifacts)) {
    json(context, 400, { error: "artifacts must be an array" });
    return;
  }

  // Shared input validation (prompt/artifacts requirements per command)
  const hasPrompt =
    typeof body.prompt === "string" && body.prompt.trim().length > 0;
  const hasArtifacts = body.artifacts.length > 0;
  const inputError = validateCommandInputs(
    body.command,
    hasPrompt,
    hasArtifacts
  );
  if (inputError) {
    json(context, 400, { error: inputError });
    return;
  }

  if (body.command === LoopCommand.EvaluatePlan) {
    const hasPrdArtifact = body.artifacts.some(
      (a) =>
        a.type === LoopArtifactType.Prd || a.type === LoopArtifactType.Feature
    );
    const hasPlanArtifact = body.artifacts.some((a) =>
      PLAN_ARTIFACT_TYPES.includes(a.type)
    );
    if (!((hasPrdArtifact || body.prompt) && hasPlanArtifact)) {
      json(context, 400, {
        error:
          "EVALUATE_PLAN requires a PRD artifact (or prompt) and an implementation plan artifact",
      });
      return;
    }
    if (!(body.localRepoPath || body.repo?.fullName)) {
      json(context, 400, {
        error:
          "EVALUATE_PLAN requires a repository (repo.fullName or localRepoPath)",
      });
      return;
    }
  }

  if (body.command === LoopCommand.EvaluateCode) {
    const hasPlanArtifact = body.artifacts.some((a) =>
      PLAN_ARTIFACT_TYPES.includes(a.type)
    );
    if (!hasPlanArtifact) {
      json(context, 400, {
        error: "EVALUATE_CODE requires an implementation plan artifact",
      });
      return;
    }
    if (!(body.localRepoPath || body.repo?.fullName)) {
      json(context, 400, {
        error:
          "EVALUATE_CODE requires a repository (repo.fullName or localRepoPath)",
      });
      return;
    }
  }

  if (body.command === LoopCommand.EvaluateFeature) {
    const hasFeatureArtifact = body.artifacts.some(
      (a) => a.type === LoopArtifactType.Feature
    );
    if (!hasFeatureArtifact) {
      json(context, 400, {
        error: "EVALUATE_FEATURE requires a feature artifact",
      });
      return;
    }
  }

  if (body.command === LoopCommand.Bootstrap) {
    const bootstrapParams = parseBootstrapParams(body.prompt);
    if (!bootstrapParams || bootstrapParams.repos.length === 0) {
      json(context, 400, {
        error: "BOOTSTRAP requires a JSON prompt with a non-empty repos array",
      });
      return;
    }
  }

  if (runningLoops.has(body.loopId)) {
    json(context, 409, { error: "Loop is already running on this machine" });
    return;
  }

  // Claim the loopId immediately to prevent concurrent requests from racing
  // past the has() check. Replaced with real entry after spawn succeeds.
  runningLoops.set(body.loopId, {
    pid: -1,
    child: null as unknown as ReturnType<typeof spawn>,
    stage: "running",
  });
  const isRelaySource =
    context.request?.headers?.["x-desktop-source"] === "cloud-socket";
  const requestSource = isRelaySource ? "relay" : "local";
  const shouldFailFastOnCallbackUnavailable =
    !isRelaySource && LOCAL_CALLBACK_FAIL_FAST_COMMANDS.has(body.command);
  loopLog(
    body.loopId,
    `Received ${body.command} request, repo=${body.repo?.fullName ?? "none"}, stableId=${pickStableId(body)}, parentSessionId=${body.parentSessionId ?? "none"}`
  );
  gatewayLog.info(
    "loop-harness",
    `${body.command} request via ${requestSource}, loopId=${body.loopId}, repo=${body.repo?.fullName ?? "none"}`
  );

  let spawnedSuccessfully = false;
  let expandedRepoPath: string | null = null;
  const additionalWorktreeDirs: AdditionalWorktreeEntry[] = [];
  try {
    const allowedDirs = getAllowedDirectories();

    if (repoRequirement !== "NOT_REQUIRED" && body.localRepoPath) {
      // localRepoPath takes precedence over repo.fullName lookup when present
      try {
        const repoResult = tryAssertRepoAllowed(
          body.localRepoPath,
          allowedDirs
        );
        if ("error" in repoResult) {
          if (repoRequirement === "REQUIRED") {
            await postLoopEventBounded(
              apiBaseUrl,
              body.loopId,
              () => body.closedLoopAuthToken,
              {
                type: LoopEventType.Error,
                code: LoopErrorCode.RepoNotAllowed,
                message: "Repository path not allowed by sandbox policy",
              }
            );
            // runningLoops.delete handled by finally block
            json(context, repoResult.status, { error: repoResult.error });
            return;
          }
          loopLog(
            body.loopId,
            `Ignoring localRepoPath for ${body.command}: ${repoResult.error}`
          );
        } else {
          expandedRepoPath = repoResult.path;
          loopLog(body.loopId, `Using localRepoPath: ${expandedRepoPath}`);
        }
      } catch (repoPathError) {
        if (repoRequirement === "REQUIRED") {
          throw repoPathError;
        }
        loopLog(
          body.loopId,
          `Ignoring localRepoPath for ${body.command} after resolution error: ${repoPathError instanceof Error ? repoPathError.message : String(repoPathError)}`
        );
      }
      // localRepoPath takes precedence (handled above); only reach here when body.repo?.fullName is the repo source
    } else if (repoRequirement !== "NOT_REQUIRED" && body.repo?.fullName) {
      expandedRepoPath = findLocalRepo(body.repo.fullName, allowedDirs);
      if (expandedRepoPath) {
        try {
          assertPathAllowed(expandedRepoPath, allowedDirs);
        } catch (err) {
          if (err instanceof DirectoryNotAllowedError) {
            if (repoRequirement === "REQUIRED") {
              await postLoopEventBounded(
                apiBaseUrl,
                body.loopId,
                () => body.closedLoopAuthToken,
                {
                  type: LoopEventType.Error,
                  code: LoopErrorCode.RepoNotAllowed,
                  message: "Repository path not allowed by sandbox policy",
                }
              );
              // runningLoops.delete handled by finally block
              json(context, 403, { error: "Repository path not allowed" });
              return;
            }
            loopLog(
              body.loopId,
              `Ignoring repo.fullName for ${body.command}: repository path not allowed (${expandedRepoPath})`
            );
            expandedRepoPath = null;
          } else {
            throw err;
          }
        }
      } else {
        // Auto-clone: attempt for any command that uses a repo (REQUIRED or OPTIONAL)
        let configDir: string | null = null;
        if (getSymphonyDir) {
          try {
            configDir = path.join(getSymphonyDir(), "config");
          } catch (dirErr) {
            if (dirErr instanceof SymphonyDirNotConfiguredError) {
              loopLog(
                body.loopId,
                `Skipping auto-clone for ${body.repo.fullName}: symphony directory not configured`
              );
            } else {
              throw dirErr;
            }
          }
        } else {
          loopLog(
            body.loopId,
            `Skipping auto-clone for ${body.repo.fullName}: symphony directory not configured`
          );
        }
        const cloneResult =
          configDir === null
            ? {
                ok: false as const,
                reason: "symphony directory not configured",
              }
            : await cloneRepoViaGh(
                body.repo.fullName,
                allowedDirs,
                body.loopId,
                configDir
              );
        if (cloneResult.ok) {
          expandedRepoPath = cloneResult.path;
        } else {
          loopError(
            body.loopId,
            `clone failed for ${body.repo.fullName}: ${cloneResult.reason}`
          );
          if (repoRequirement === "REQUIRED") {
            await postLoopEventBounded(
              apiBaseUrl,
              body.loopId,
              () => body.closedLoopAuthToken,
              {
                type: LoopEventType.Error,
                code: LoopErrorCode.RepoNotFound,
                message: `Repository not found locally: ${body.repo.fullName}`,
              }
            );
            // runningLoops.delete handled by finally block (spawnedSuccessfully remains false)
            json(context, 404, {
              error: `Repository not found locally: ${body.repo.fullName}`,
            });
            return;
          }
          loopLog(
            body.loopId,
            `Ignoring repo.fullName for ${body.command}: not found locally (${body.repo.fullName})`
          );
        }
      }
    }

    let resolvedAdditionalRepos: ResolvedAdditionalRepo[] = [];
    // Policy-driven gate: every command whose MultiRepoCommandPolicy enables
    // peer repos receives the same resolution + worktree treatment. Adding a
    // new peer-aware command is a one-line table edit in @closedloop-ai/loops-api.
    if (
      getMultiRepoPolicy(body.command).supportsAdditionalRepos &&
      body.additionalRepos &&
      body.additionalRepos.length > 0
    ) {
      try {
        resolvedAdditionalRepos = await resolveAdditionalRepos(
          body.additionalRepos,
          allowedDirs,
          wt
        );
      } catch (err) {
        if (err instanceof AdditionalRepoError) {
          await postLoopEventBounded(
            apiBaseUrl,
            body.loopId,
            () => body.closedLoopAuthToken,
            {
              type: LoopEventType.Error,
              code: err.code,
              message: err.message,
            }
          );
          gatewayLog.error(
            "loop-harness",
            `additionalRepo validation failed for loopId=${body.loopId}: ${err.repoRef} — ${err.message}`
          );
          json(context, 400, { error: err.message });
          return;
        }
        throw err;
      }

      // Deduplication guard: reject if any fullName or repoPath appears more than once
      // across the primary repo and all additional repos.
      const seenFullNames = new Set<string>();
      const seenRepoPaths = new Set<string>();

      if (body.repo?.fullName) {
        seenFullNames.add(body.repo.fullName);
      }
      if (expandedRepoPath) {
        seenRepoPaths.add(path.resolve(expandedRepoPath));
      }

      for (let i = 0; i < resolvedAdditionalRepos.length; i++) {
        const resolved = resolvedAdditionalRepos[i];
        const entry = body.additionalRepos![i];
        const entryFullName = entry.fullName;

        if (entryFullName) {
          if (seenFullNames.has(entryFullName)) {
            const dupMsg = `Duplicate repository fullName across repos: ${entryFullName}`;
            await postLoopEventBounded(
              apiBaseUrl,
              body.loopId,
              () => body.closedLoopAuthToken,
              {
                type: LoopEventType.Error,
                code: LoopErrorCode.PreRunValidationFailed,
                message: dupMsg,
              }
            );
            gatewayLog.error(
              "loop-harness",
              `additionalRepo deduplication failed for loopId=${body.loopId}: ${dupMsg}`
            );
            json(context, 400, { error: dupMsg });
            return;
          }
          seenFullNames.add(entryFullName);
        }

        const resolvedCanonical = path.resolve(resolved.repoPath);
        if (seenRepoPaths.has(resolvedCanonical)) {
          const dupMsg = `Duplicate repository path across repos: ${resolved.repoPath}`;
          await postLoopEventBounded(
            apiBaseUrl,
            body.loopId,
            () => body.closedLoopAuthToken,
            {
              type: LoopEventType.Error,
              code: LoopErrorCode.PreRunValidationFailed,
              message: dupMsg,
            }
          );
          gatewayLog.error(
            "loop-harness",
            `additionalRepo deduplication failed for loopId=${body.loopId}: ${dupMsg}`
          );
          json(context, 400, { error: dupMsg });
          return;
        }
        seenRepoPaths.add(resolvedCanonical);
      }
    }

    let worktreeDir: string | null = null;
    let claudeWorkDir: string;
    let usedTempDir = false;
    let executeImportedPlanFile: string | null = null;
    let requestChangesImportedPlanFile: string | null = null;

    if (body.command === LoopCommand.Decompose) {
      // DECOMPOSE uses a single temp dir for everything: context pack, logs, and output.
      // No repo/worktree needed — artifacts go to .closedloop-ai/context/artifacts/
      // so Claude's prompt can reference them by relative path.
      usedTempDir = true;
      const tmpDir = path.join(
        os.tmpdir(),
        `symphony-decompose-${slugifyLoopId(body.loopId)}`
      );
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      claudeWorkDir = tmpDir;
      try {
        await writeArtifactsForGeneratePrd(
          tmpDir,
          body.artifacts,
          body.prompt ?? "Decompose the PRD into features.",
          body.repo
        );
      } catch (artifactErr) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        await postLoopEvent(
          apiBaseUrl,
          body.loopId,
          () => body.closedLoopAuthToken,
          {
            type: LoopEventType.Error,
            code: LoopErrorCode.ArtifactWriteFailed,
            message:
              artifactErr instanceof Error
                ? artifactErr.message
                : String(artifactErr),
          }
        );
        json(context, 500, { error: "Failed to write artifacts to workdir" });
        return;
      }
    } else if (
      body.command === LoopCommand.EvaluatePrd ||
      body.command === LoopCommand.EvaluatePlan ||
      body.command === LoopCommand.EvaluateCode ||
      body.command === LoopCommand.EvaluateFeature
    ) {
      // EVALUATE_PRD, EVALUATE_PLAN, EVALUATE_CODE, and EVALUATE_FEATURE: use temp dir, no worktree needed.
      // Temp dir is intentionally exempt from assertPathAllowed.
      usedTempDir = true;
      const label = body.command.toLowerCase().replace(/_/g, "-");
      const tmpDir = path.join(
        os.tmpdir(),
        `symphony-${label}-${body.loopId.slice(0, 8)}`
      );
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      claudeWorkDir = tmpDir;
      try {
        if (body.command === LoopCommand.EvaluatePrd) {
          await writePrdArtifact(
            claudeWorkDir,
            body.artifacts,
            body.prompt,
            body.primaryArtifactId
          );
        } else if (body.command === LoopCommand.EvaluatePlan) {
          await writePlanArtifact(
            claudeWorkDir,
            body.artifacts,
            body.prompt,
            body.primaryArtifactId
          );
        } else if (body.command === LoopCommand.EvaluateCode) {
          await writeCodeArtifact(
            claudeWorkDir,
            body.artifacts,
            body.primaryArtifactId
          );
        } else if (body.command === LoopCommand.EvaluateFeature) {
          await writeFeatureArtifact(
            claudeWorkDir,
            body.artifacts,
            body.primaryArtifactId
          );
        }
        await materializeEvaluateRuntimeContext(
          claudeWorkDir,
          body,
          expandedRepoPath
        );
      } catch (artifactErr) {
        await fs.rm(claudeWorkDir, { recursive: true, force: true });
        await postLoopEvent(
          apiBaseUrl,
          body.loopId,
          () => body.closedLoopAuthToken,
          {
            type: LoopEventType.Error,
            code: LoopErrorCode.ArtifactWriteFailed,
            message:
              artifactErr instanceof Error
                ? artifactErr.message
                : String(artifactErr),
          }
        );
        json(context, 500, { error: "Failed to write artifacts to workdir" });
        return;
      }
    } else if (repoRequirement === "REQUIRED" && !expandedRepoPath) {
      json(context, 400, {
        error:
          "Repository required for PLAN, EXECUTE, REQUEST_CHANGES, and GENERATE_PRD commands",
      });
      return;
    } else if (
      body.command === LoopCommand.Plan ||
      body.command === LoopCommand.Execute ||
      body.command === LoopCommand.RequestChanges
    ) {
      // expandedRepoPath is guaranteed non-null here: the repoRequirement === "REQUIRED"
      // guard above already returned 400 when it was missing.
      const repoPath = expandedRepoPath!;

      // Worktree keyed by artifact slug (e.g., symphony/PLAN-5).
      // PLAN always creates fresh; EXECUTE/REQUEST_CHANGES reuse.
      // Sanitize slug the same way we sanitize loopId to prevent path traversal.
      const sanitizedSlug = body.artifactSlug
        ? slugifyLoopId(body.artifactSlug)
        : null;
      const worktreeKey = sanitizedSlug ?? pickStableId(body);
      const legacyBranchName = sanitizedSlug
        ? `symphony/${sanitizedSlug}`
        : `symphony/loop-${pickStableId(body)}`;
      const baseBranch = body.repo?.branch ?? "main";
      const useBranchMaterialization = shouldUseBranchMaterialization(body);

      worktreeDir = resolveLoopWorktreeDir(repoPath, worktreeKey);
      let repositoryFullName = resolveLoopPrimaryFullName(body, repoPath);
      if (useBranchMaterialization) {
        try {
          repositoryFullName = requireVerifiedLoopRepositoryFullName({
            declaredFullName: body.repo?.fullName,
            repoPath,
            role: "primary",
          });
          assertPathAllowed(worktreeDir, allowedDirs);
        } catch (err) {
          if (err instanceof DirectoryNotAllowedError) {
            json(context, 403, {
              error: `Worktree path not allowed: ${worktreeDir}`,
            });
            return;
          }
          await failBranchCreate({
            body,
            apiBaseUrl,
            context,
            message: `${body.command} branch materialization is not available: ${sanitizeUnknownError(err)}`,
          });
          return;
        }
      }

      const branchMaterializationPreflightOk =
        await preflightAdditionalRepoBranchMaterialization({
          resolvedAdditionalRepos,
          worktreeKey,
          allowedDirs,
          body,
          apiBaseUrl,
          context,
          wt,
          reuseStaleWorktree:
            getMultiRepoPolicy(body.command).worktreeFreshness ===
            "reuse-stale",
        });
      if (!branchMaterializationPreflightOk) {
        return;
      }

      if (body.command === LoopCommand.Plan) {
        let branchName = legacyBranchName;
        if (useBranchMaterialization) {
          let expectedBranch: SymphonyBranchMaterializationEntry;
          try {
            expectedBranch = requireExpectedLoopBranch({
              body,
              role: "primary",
              repositoryFullName,
              baseBranch,
            });
          } catch (err) {
            await failBranchCreate({
              body,
              apiBaseUrl,
              context,
              message: `PLAN branch materialization is not available: ${sanitizeUnknownError(err)}`,
            });
            return;
          }
          branchName = expectedBranch.branchName;
        }
        // PLAN always starts fresh — remove stale worktree if it exists.
        // PLAN has requiresParent: false, so it must not inherit prior state.
        const staleWorktree = wt.findWorktreeForBranch(repoPath, branchName);
        if (staleWorktree) {
          loopLog(
            body.loopId,
            `Removing stale worktree for fresh PLAN: ${staleWorktree}`
          );
          await wt.removeWorktree(staleWorktree, repoPath, body.loopId);
        }
        try {
          await ensureLoopWorktreeForRequest({
            body,
            expandedRepoPath: repoPath,
            worktreeDir,
            branchName,
            baseBranch,
            loopId: body.loopId,
            repositoryFullName,
            apiBaseUrl,
            token: body.closedLoopAuthToken,
            wt,
          });
        } catch (err) {
          const msg = sanitizeUnknownError(err);
          loopError(
            body.loopId,
            `ensureLoopWorktreeMaterialized failed for PLAN: ${msg}`
          );
          await wt
            .removeWorktree(worktreeDir, repoPath, body.loopId)
            .catch(() => {});
          await failBranchCreate({
            body,
            apiBaseUrl,
            context,
            message: `Failed to materialize PLAN branch: ${msg}`,
          });
          return;
        }
        loopLog(
          body.loopId,
          `Created fresh worktree for PLAN: ${worktreeDir} (branch: ${branchName})`
        );

        // Create additional repo worktrees for PLAN command.
        // Mirror the primary-repo pattern: create a fresh scratch branch
        // based on the user-specified branch so loop work does not mutate it.
        const planAdditionalsOk = await provisionAdditionalRepoWorktrees({
          resolvedAdditionalRepos,
          worktreeKey,
          worktreeDir,
          primaryRepoPath: repoPath,
          additionalWorktreeDirs,
          allowedDirs,
          body,
          apiBaseUrl,
          context,
          wt,
          freshLabel: LoopCommand.Plan,
          ownsPrimaryWorktree: true,
          // Driven by MultiRepoCommandPolicy.worktreeFreshness — `always-fresh`
          // for PLAN means any prior worktree at this branch is destroyed.
          reuseStaleWorktree:
            getMultiRepoPolicy(body.command).worktreeFreshness ===
            "reuse-stale",
        });
        if (!planAdditionalsOk) {
          return;
        }

        for (const addEntry of additionalWorktreeDirs) {
          try {
            await materializeContextPack(
              addEntry.dir,
              addEntry.fullName,
              body.loopId,
              bodyAgents,
              bodyRepoConfigs
            );
          } catch (matErr) {
            loopError(
              body.loopId,
              `context-pack materialization failed for PLAN additional worktree: ${addEntry.dir}`,
              matErr
            );
          }
        }
      } else {
        // EXECUTE/REQUEST_CHANGES: reuse existing worktree.
        // Try artifact slug first, then parentLoopId fallback, then create new.
        let reusedPrimaryWorktree = false;
        let expectedBranch: SymphonyBranchMaterializationEntry | null = null;
        if (useBranchMaterialization) {
          try {
            expectedBranch = requireExpectedLoopBranch({
              body,
              role: "primary",
              repositoryFullName,
              baseBranch,
            });
          } catch (err) {
            await failBranchCreate({
              body,
              apiBaseUrl,
              context,
              message: `${body.command} branch materialization is not available: ${sanitizeUnknownError(err)}`,
            });
            return;
          }
        }
        let branchName = expectedBranch?.branchName ?? legacyBranchName;
        const existingWorktree =
          expectedBranch === null
            ? wt.findWorktreeForBranch(repoPath, legacyBranchName)
            : wt.findWorktreeForBranch(repoPath, expectedBranch.branchName);
        if (existingWorktree) {
          worktreeDir = existingWorktree;
          reusedPrimaryWorktree = true;
          loopLog(
            body.loopId,
            `Reusing worktree via artifact slug: ${worktreeDir} (branch: ${branchName})`
          );
        } else if (!useBranchMaterialization && body.parentLoopId) {
          // Fallback: try parent's loopId-based branch (pre-slug deployments or missing slug)
          const parentBranch = `symphony/loop-${slugifyLoopId(body.parentLoopId)}`;
          const parentWorktree = wt.findWorktreeForBranch(
            repoPath,
            parentBranch
          );
          if (parentWorktree) {
            worktreeDir = parentWorktree;
            reusedPrimaryWorktree = true;
            loopLog(
              body.loopId,
              `Reusing worktree via parentLoopId fallback: ${worktreeDir} (branch: ${parentBranch})`
            );
          }
        }
        if (!(worktreeDir && existsSync(worktreeDir))) {
          // No existing worktree found — create new
          if (expectedBranch) {
            branchName = expectedBranch.branchName;
          }
          worktreeDir = resolveLoopWorktreeDir(repoPath, worktreeKey);
          try {
            await ensureLoopWorktreeForRequest({
              body,
              expandedRepoPath: repoPath,
              worktreeDir,
              branchName,
              baseBranch,
              loopId: body.loopId,
              repositoryFullName,
              apiBaseUrl,
              token: body.closedLoopAuthToken,
              wt,
            });
          } catch (err) {
            const msg = sanitizeUnknownError(err);
            loopError(
              body.loopId,
              `ensureLoopWorktreeMaterialized failed for ${body.command}: ${msg}`
            );
            await wt
              .removeWorktree(worktreeDir, repoPath, body.loopId)
              .catch(() => {});
            await failBranchCreate({
              body,
              apiBaseUrl,
              context,
              message: `Failed to materialize ${body.command} branch: ${msg}`,
            });
            return;
          }
          reusedPrimaryWorktree = false;
          loopLog(
            body.loopId,
            `Created new worktree: ${worktreeDir} (branch: ${branchName})`
          );
        }

        // Create additional repo worktrees for EXECUTE/REQUEST_CHANGES command.
        // Mirror the primary-repo pattern: create a fresh scratch branch
        // based on the user-specified branch so loop work does not mutate it.
        const executeAdditionalsOk = await provisionAdditionalRepoWorktrees({
          resolvedAdditionalRepos,
          worktreeKey,
          worktreeDir,
          primaryRepoPath: repoPath,
          additionalWorktreeDirs,
          allowedDirs,
          body,
          apiBaseUrl,
          context,
          wt,
          freshLabel: LoopCommand.Execute,
          // Only allow primary worktree removal on failure when we created it
          // fresh in this request. Reused parent PLAN worktrees must not be
          // destroyed by an additional-repo provisioning failure.
          ownsPrimaryWorktree: !reusedPrimaryWorktree,
          // Driven by MultiRepoCommandPolicy.worktreeFreshness — `reuse-stale`
          // for EXECUTE retains uncommitted in-progress agent state across
          // retries (matches today's behavior).
          reuseStaleWorktree:
            getMultiRepoPolicy(body.command).worktreeFreshness ===
            "reuse-stale",
        });
        if (!executeAdditionalsOk) {
          return;
        }

        for (const addEntry of additionalWorktreeDirs) {
          try {
            await materializeContextPack(
              addEntry.dir,
              addEntry.fullName,
              body.loopId,
              bodyAgents,
              bodyRepoConfigs
            );
          } catch (materializeErr) {
            loopError(
              body.loopId,
              `context-pack materialization failed for additional repo worktree: ${addEntry.dir}`,
              materializeErr
            );
            gatewayLog.error(
              "context-pack-additional-repo-failed",
              `loopId=${body.loopId} dir=${addEntry.dir} error=${String(materializeErr)}`
            );
            // Remove the failed worktree
            try {
              await wt.removeWorktree(
                addEntry.dir,
                addEntry.repoPath,
                body.loopId
              );
            } catch {
              /* ignore */
            }
            // Clean up all prior additional worktrees
            await cleanupAdditionalWorktrees(
              additionalWorktreeDirs.filter((e) => e !== addEntry),
              body.loopId,
              wt
            );
            additionalWorktreeDirs.length = 0;
            await postLoopEventBounded(
              apiBaseUrl,
              body.loopId,
              () => body.closedLoopAuthToken,
              {
                type: LoopEventType.Error,
                code: LoopErrorCode.BranchCreateFailed,
                message: `Context-pack materialization failed for additional repo worktree: ${addEntry.dir}`,
              }
            );
            return json(context, 500, {
              error:
                "Context-pack materialization failed for additional repo worktree",
            });
          }
        }
      }

      try {
        assertPathAllowed(worktreeDir, allowedDirs);
      } catch (e) {
        if (e instanceof DirectoryNotAllowedError) {
          json(context, 403, {
            error: `Worktree path not allowed: ${worktreeDir}`,
          });
          return;
        }
        throw e;
      }
      try {
        await materializeContextPack(
          worktreeDir,
          body.repo?.fullName,
          body.loopId,
          bodyAgents,
          bodyRepoConfigs
        );
      } catch (matErr) {
        loopError(
          body.loopId,
          `context-pack materialization failed for primary worktree: ${worktreeDir}`,
          matErr
        );
      }
      claudeWorkDir = path.join(worktreeDir, ".closedloop-ai", "work");
      await fs.mkdir(claudeWorkDir, { recursive: true });

      if (body.command === LoopCommand.Plan) {
        await writeArtifactsForPlan(
          claudeWorkDir,
          body.artifacts,
          body.prompt,
          body.userContext,
          body.attachments
        );
      } else if (body.command === LoopCommand.Execute) {
        const executeArtifacts = await writeArtifactsForExecuteOrAmend(
          claudeWorkDir,
          body.artifacts,
          undefined,
          body.attachments,
          {
            command: LoopCommand.Execute,
            loopId: body.loopId,
            commandId,
            operationId,
          }
        );
        executeImportedPlanFile = executeArtifacts.importedPlanFile;
      } else {
        // REQUEST_CHANGES
        const requestChangesArtifacts = await writeArtifactsForExecuteOrAmend(
          claudeWorkDir,
          body.artifacts,
          body.prompt,
          body.attachments,
          {
            command: LoopCommand.RequestChanges,
            loopId: body.loopId,
            commandId,
            operationId,
          }
        );
        requestChangesImportedPlanFile =
          requestChangesArtifacts.importedPlanFile;
      }
    } else if (
      body.command === LoopCommand.GeneratePrd ||
      body.command === LoopCommand.RequestPrdChanges
    ) {
      // expandedRepoPath is guaranteed non-null here: REPO_REQUIREMENT_BY_COMMAND
      // marks both PRD commands REQUIRED, so the guard above already returned
      // 400 when it was missing.
      const dirs = await setupPrdWorktree({
        command: body.command,
        body,
        expandedRepoPath: expandedRepoPath!,
        resolvedAdditionalRepos,
        additionalWorktreeDirs,
        allowedDirs,
        apiBaseUrl,
        context,
        wt,
      });
      if (!dirs) {
        return; // helper already sent the response + cleaned up
      }
      worktreeDir = dirs.worktreeDir;
      claudeWorkDir = dirs.claudeWorkDir;
    } else if (body.command === LoopCommand.Bootstrap) {
      usedTempDir = true;
      const tmpDir = path.join(
        os.tmpdir(),
        `symphony-bootstrap-${body.loopId.slice(0, 8)}`
      );
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      claudeWorkDir = tmpDir;
    } else {
      json(context, 400, { error: `Unknown command: ${body.command}` });
      return;
    }

    /** Clean up temporary resources on early-return error paths. */
    const tempRootDir = usedTempDir ? (worktreeDir ?? claudeWorkDir) : null;
    const cleanupOnError = async (): Promise<void> => {
      if (tempRootDir) {
        await fs
          .rm(tempRootDir, { recursive: true, force: true })
          .catch(() => {});
      }
      if (
        (body.command === LoopCommand.GeneratePrd ||
          body.command === LoopCommand.RequestPrdChanges) &&
        worktreeDir &&
        expandedRepoPath
      ) {
        await wt.removeWorktree(worktreeDir, expandedRepoPath, body.loopId);
      }
      await cleanupAdditionalWorktrees(additionalWorktreeDirs, body.loopId, wt);
    };

    const commandRuntime =
      createClosedloopWebCommandPackFactory().selectRuntime(
        body.command,
        body.harness
      );
    if (!commandRuntime.ok) {
      await postLoopEvent(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        {
          type: LoopEventType.Error,
          code: LoopErrorCode.PreRunValidationFailed,
          message: commandRuntime.reason,
        }
      );
      await cleanupOnError();
      json(context, 400, { error: commandRuntime.reason });
      return;
    }

    // Pre-flight: verify required binaries exist BEFORE posting 'started' event.
    // All commands need their selected harness CLI. Claude PLAN/EXECUTE can
    // still run through the installed plugin script when it is present; without
    // that script, the command pack falls back to the native-prompt launcher.
    const legacyClaudeRunLoopScript =
      commandRuntime.harness.launchMode ===
        CommandPackLaunchMode.NativePrompt &&
      commandRuntime.harness.adapter.harness === LoopHarness.Claude &&
      LEGACY_CLAUDE_RUN_LOOP_COMMANDS.has(body.command)
        ? findPluginScript("code", "run-loop.sh")
        : null;
    const usesRunLoop =
      commandRuntime.harness.launchMode ===
        CommandPackLaunchMode.PluginRunLoop ||
      legacyClaudeRunLoopScript !== null;
    const usesNativePrompt =
      commandRuntime.harness.launchMode ===
        CommandPackLaunchMode.NativePrompt && !usesRunLoop;
    let scriptPath: string | null = legacyClaudeRunLoopScript;

    // Determine which binary is required based on the selected command-pack adapter.
    // The async and sync resolver variants share the same login-shell PATH
    // cache, so preflight, health checks, and sync spawn wrappers agree on
    // the selected binary.
    const harnessBinary = commandRuntime.harness.adapter.binaryName;
    const binaryPathOverrides = getOverrideBinaryPaths();
    const harnessOverride = binaryPathOverrides?.[harnessBinary];
    const resolved = await resolveBinaryFromLoginShell(
      harnessBinary,
      harnessOverride
    );
    if (resolved.source === "fallback") {
      await postLoopEvent(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        {
          type: LoopEventType.Error,
          code: LoopErrorCode.BinaryNotFound,
          message: `${harnessBinary} CLI not found in PATH`,
        }
      );
      Observability.preflightBinaryNotFound(
        commandId,
        operationId,
        body.loopId
      );
      await cleanupOnError();
      json(context, 500, { error: `${harnessBinary} CLI not found in PATH` });
      return;
    }
    // "override", "override_invalid", or "path": all proceed.
    // "override_invalid" is intentionally allowed -- the user set an explicit
    // override and should see the resulting ENOENT from the spawn, not a
    // confusing "not found in PATH" error.

    if (usesRunLoop && scriptPath === null) {
      scriptPath = findPluginScript("code", "run-loop.sh");
      if (!scriptPath) {
        await postLoopEvent(
          apiBaseUrl,
          body.loopId,
          () => body.closedLoopAuthToken,
          {
            type: LoopEventType.Error,
            code: LoopErrorCode.ScriptNotFound,
            message: "run-loop.sh not found in plugin cache",
          }
        );
        Observability.preflightScriptNotFound(
          commandId,
          operationId,
          body.loopId
        );
        json(context, 500, { error: "run-loop.sh not found in plugin cache" });
        return;
      }
    }

    try {
      if (loopTokenStore) {
        const initialExpSec = parseJwtExpiry(body.closedLoopAuthToken);
        const initialExpiresAt =
          initialExpSec === null ? undefined : initialExpSec * 1000;
        loopTokenStore.setLoopToken(body.loopId, {
          token: body.closedLoopAuthToken,
          expiresAt: initialExpiresAt,
        } satisfies LoopTokenMeta);
      }
    } catch (err) {
      loopLog(
        body.loopId,
        `Failed to persist loop auth token: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Post "started" event — only after confirming we can proceed
    loopLog(body.loopId, "Posting started event...");
    if (shouldFailFastOnCallbackUnavailable) {
      // Use an unbounded POST here so we only fail fast on definitive callback
      // failures. A short client-side abort can race with a server-side write
      // and produce an orphaned "started" event with no spawned process.
      const startedResult = await postLoopEvent(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        { type: LoopEventType.Started }
      );
      if (!startedResult.success) {
        const callbackError = startedResult.error ?? "unknown callback error";
        const errorMessage =
          "Cannot start local loop: cloud callback path is unavailable. Check connectivity and retry.";
        loopError(
          body.loopId,
          `Failing fast before spawn after started-event callback failure: ${callbackError}`
        );
        gatewayLog.error(
          "loop-harness",
          `Fail-fast local launch blocked for loopId=${body.loopId}, command=${body.command}, callbackError=${callbackError}`
        );
        await cleanupOnError();
        json(context, 503, {
          error: `${errorMessage} (${callbackError})`,
        });
        return;
      }
    } else {
      await postLoopEvent(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        {
          type: LoopEventType.Started,
        }
      );
    }

    if (
      worktreeDir !== null &&
      BOOTSTRAP_PREFLIGHT_COMMANDS.has(body.command) &&
      !(COMMAND_PACK_NATIVE_LOOP_COMMANDS.has(body.command) && usesNativePrompt)
    ) {
      for (const addEntry of additionalWorktreeDirs) {
        await runLoopBootstrapPreflight({
          worktreeDir: addEntry.dir,
          loopId: body.loopId,
          apiBaseUrl,
          token: body.closedLoopAuthToken,
          getClaudeShellEnv,
        });
      }

      await runLoopBootstrapPreflight({
        worktreeDir,
        loopId: body.loopId,
        apiBaseUrl,
        token: body.closedLoopAuthToken,
        getClaudeShellEnv,
      });
    }

    // Spawn process
    const logFile = path.join(claudeWorkDir, "symphony-loop.log");
    let logFd: number;
    try {
      logFd = openSync(logFile, "a");
    } catch (logErr) {
      const msg = logErr instanceof Error ? logErr.message : String(logErr);
      await postLoopEvent(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        {
          type: LoopEventType.Error,
          code: LoopErrorCode.SpawnFailed,
          message: `Cannot open log file: ${msg}`,
        }
      );
      Observability.preflightSpawnFailed(
        commandId,
        operationId,
        body.loopId,
        `Cannot open log file: ${msg}`
      );
      await cleanupOnError();
      json(context, 500, { error: `Cannot open log file: ${msg}` });
      return;
    }
    let child: ReturnType<typeof spawn>;
    let spawnStartedAt = 0;
    let decisionTableVerificationStartOffset = 0;
    let loopPerfTelemetryStartOffset = 0;
    let loopPerfWatcherHandle: LoopPerfTelemetryWatcherHandle | undefined;
    // Native in-process observability for bare-prompt loops (NativePrompt /
    // ClaudeSlashCommand). Constructed after a successful spawn; the legacy
    // perf.jsonl watcher above is only started for PluginRunLoop, so the two
    // paths never run for the same loop (no double counting — T-5.1/D-006).
    let nativeObservability: NativeLoopObservabilitySession | undefined;
    const usesNativeObservability =
      commandRuntime.harness.launchMode ===
        CommandPackLaunchMode.NativePrompt ||
      commandRuntime.harness.launchMode ===
        CommandPackLaunchMode.ClaudeSlashCommand;
    const tailerJsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
    const jsonlPreSpawnOffset = existsSync(tailerJsonlPath)
      ? statSync(tailerJsonlPath).size
      : 0;
    const collectedSpawnMeta: {
      command: string;
      args: string[];
      cwd: string;
      claudeVersion?: string;
      binaryPath: string;
      authFilesExist: boolean;
      envSnapshot: Record<string, string>;
    } = {
      command: "",
      args: [],
      cwd: claudeWorkDir,
      binaryPath: "",
      authFilesExist: false,
      envSnapshot: {},
    };
    let userVisibleLoopFailureSecret: string | undefined;

    try {
      // Reuse the path from pre-flight so validation and execution stay aligned.
      const harnessBinaryPath = resolved.path;
      const selectedHarness = commandRuntime.harness.adapter.harness;
      const harnessBin = harnessBinaryPath;

      const closedLoopPlanFile =
        executeImportedPlanFile ?? requestChangesImportedPlanFile ?? "";

      userVisibleLoopFailureSecret =
        body.command === LoopCommand.Plan ||
        body.command === LoopCommand.Execute
          ? crypto.randomBytes(32).toString("base64url")
          : undefined;
      // Multi-repo env vars must travel in Claude's spawn env, not only in
      // setup-closedloop.sh's config.env file or the SubagentStart hook's
      // additionalContext. Without them, every bash subshell the agents launch
      // sees CLOSEDLOOP_ADD_DIRS as empty and the plan-draft-writer skill
      // silently skips its multi-repo section, producing a single-repo plan.
      // Gated on getMultiRepoPolicy().supportsAdditionalRepos to mirror the
      // --add-dir injection at lines 6488 and 6642 — single-repo and
      // peer-disabled commands stay byte-identical to today. See FEA-1088.
      const peerEnvVars =
        additionalWorktreeDirs.length > 0 &&
        getMultiRepoPolicy(body.command).supportsAdditionalRepos
          ? buildPeerEnvVars(additionalWorktreeDirs)
          : {};
      const loopSpawnEnv = {
        CLOSEDLOOP_WORKDIR: claudeWorkDir,
        CLOSEDLOOP_PLAN_FILE: closedLoopPlanFile,
        // Propagate the canonical command name (PLAN, EXECUTE, REQUEST_CHANGES,
        // DECOMPOSE) to the harness so loop.perf.* events and runs.log rows
        // are attributed to the actual slash-command the user invoked, not the
        // "interactive" / "plan_execute" fallbacks. The plugin side
        // (run-loop.sh) gives env-var precedence over --prompt; see PRD-254
        // §FR-1 / §FR-5 and FEA-936.
        CLOSEDLOOP_COMMAND: body.command,
        CLOSEDLOOP_HARNESS: selectedHarness,
        CLOSEDLOOP_HARNESS_BIN: harnessBinaryPath,
        ...(userVisibleLoopFailureSecret
          ? {
              [USER_VISIBLE_LOOP_FAILURE_SECRET_ENV]:
                userVisibleLoopFailureSecret,
            }
          : {}),
        // Pass resolved claude path so run-loop.sh uses the same binary
        // the desktop app validated in pre-flight (avoids PATH mismatches
        // between Electron's env and the user's login shell).
        ...(selectedHarness === LoopHarness.Claude
          ? { CLAUDE_BIN: harnessBinaryPath }
          : {}),
        ...peerEnvVars,
      };
      const spawnEnv: Record<string, string> =
        selectedHarness === LoopHarness.Claude
          ? await getClaudeShellEnv(loopSpawnEnv)
          : await getShellEnv(loopSpawnEnv);
      clearUserVisibleLoopFailureMarker(claudeWorkDir);

      // Collect non-sensitive env snapshot: NODE_ENV + CLAUDE_CODE_USE_* keys only
      const envSnapshot: Record<string, string> = {};
      for (const [key, value] of Object.entries(spawnEnv)) {
        if (key === "NODE_ENV" || key.startsWith("CLAUDE_CODE_USE_")) {
          envSnapshot[key] = value;
        }
      }

      collectedSpawnMeta.command = harnessBinaryPath;
      collectedSpawnMeta.binaryPath = harnessBinaryPath;
      collectedSpawnMeta.authFilesExist = existsSync(
        path.join(os.homedir(), commandRuntime.harness.adapter.configDirName)
      );
      collectedSpawnMeta.envSnapshot = envSnapshot;

      // Shared claude CLI args for commands that run claude directly.
      // REQUEST_CHANGES omits "-" (stdin) because it passes the prompt as a CLI argument.
      const allowedTools = await withMcpTools(
        "Bash,Glob,Grep,Read,Write,Edit,Task,Skill,SlashCommand,TodoWrite",
        expectedMcpUrl
      );
      const baseClaudeArgs: string[] = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        allowedTools,
        "--max-turns",
        "200",
      ];
      const stdinClaudeArgs = ["-p", "-", ...baseClaudeArgs.slice(1)];

      if (
        COMMAND_PACK_NATIVE_LOOP_COMMANDS.has(body.command) &&
        usesNativePrompt
      ) {
        const peerRefs = toPeerWorktreeRefs(additionalWorktreeDirs);
        const promptFile = path.join(
          claudeWorkDir,
          `${body.command.toLowerCase()}-prompt.txt`
        );
        await fs.writeFile(
          promptFile,
          buildCommandPackLoopPrompt({
            command: body.command,
            workDir: claudeWorkDir,
            worktreeDir: worktreeDir!,
            repoPath: expandedRepoPath,
            planFile: closedLoopPlanFile || null,
            prompt: body.prompt,
            mountedPathsFooter: getMultiRepoPolicy(body.command)
              .supportsAdditionalRepos
              ? buildMountPathsFooter(peerRefs)
              : "",
          })
        );

        const claudeArgsWithPeers = [...stdinClaudeArgs];
        if (body.parentSessionId) {
          claudeArgsWithPeers.push("--resume", body.parentSessionId);
        }
        if (getMultiRepoPolicy(body.command).supportsAdditionalRepos) {
          for (const peer of peerRefs) {
            claudeArgsWithPeers.push("--add-dir", peer.localPath);
          }
        }

        const pipeline = buildNativePromptPipeline(
          commandRuntime,
          claudeArgsWithPeers,
          claudeWorkDir,
          harnessBin,
          promptFile
        );
        collectedSpawnMeta.command = pipeline.cmd;
        collectedSpawnMeta.args = redactSpawnArgs(pipeline.args);
        collectedSpawnMeta.cwd = worktreeDir!;
        spawnStartedAt = Date.now();
        child = spawn(pipeline.cmd, pipeline.args, {
          cwd: worktreeDir!,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (body.command === LoopCommand.Decompose) {
        // DECOMPOSE: prompt piped via stdin, cwd is the temp dir which contains
        // .closedloop-ai/context/artifacts/ so Claude can find them by relative path.
        const promptFile = path.join(claudeWorkDir, "decompose-prompt.txt");
        const basePrompt = body.prompt ?? "Decompose the PRD into features.";
        await fs.writeFile(
          promptFile,
          buildPromptWithOutputContract(
            commandRuntime,
            body.command,
            basePrompt,
            claudeWorkDir
          )
        );

        const pipeline = buildNativePromptPipeline(
          commandRuntime,
          stdinClaudeArgs,
          claudeWorkDir,
          harnessBin,
          promptFile
        );
        collectedSpawnMeta.command = pipeline.cmd;
        collectedSpawnMeta.args = redactSpawnArgs(pipeline.args);
        spawnStartedAt = Date.now();
        child = spawn(pipeline.cmd, pipeline.args, {
          cwd: claudeWorkDir,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (
        body.command === LoopCommand.EvaluatePrd ||
        body.command === LoopCommand.EvaluateFeature
      ) {
        // EVALUATE_PRD and EVALUATE_FEATURE share identical spawn logic:
        // REPO_PATH is optional — only added when a target repo is linked.
        const artifactType =
          body.command === LoopCommand.EvaluatePrd ? "prd" : "feature";
        const label = `evaluate-${artifactType}`;
        let prompt = buildJudgePromptText(
          commandRuntime,
          artifactType,
          claudeWorkDir
        );
        if (expandedRepoPath) {
          prompt += `REPO_PATH=${expandedRepoPath} (search here for relevant code).\n`;
        }
        const promptFile = path.join(claudeWorkDir, `${label}-prompt.txt`);
        await fs.writeFile(
          promptFile,
          buildPromptWithOutputContract(
            commandRuntime,
            body.command,
            prompt,
            claudeWorkDir
          )
        );

        const pipeline = buildNativePromptPipeline(
          commandRuntime,
          stdinClaudeArgs,
          claudeWorkDir,
          harnessBin,
          promptFile
        );
        collectedSpawnMeta.command = pipeline.cmd;
        collectedSpawnMeta.args = redactSpawnArgs(pipeline.args);
        spawnStartedAt = Date.now();
        child = spawn(pipeline.cmd, pipeline.args, {
          cwd: claudeWorkDir,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (
        body.command === LoopCommand.EvaluatePlan ||
        body.command === LoopCommand.EvaluateCode
      ) {
        // EVALUATE_PLAN and EVALUATE_CODE share identical spawn logic,
        // differing only in the artifact type passed to run-judges.
        // Unlike EVALUATE_PRD/EVALUATE_FEATURE (where REPO_PATH is optional),
        // plan and code judges need the implementation tree, so the request must resolve to
        // a local repo and expandedRepoPath is always set on this path.
        const artifactType =
          body.command === LoopCommand.EvaluatePlan ? "plan" : "code";
        const label = `evaluate-${artifactType}`;
        const prompt =
          buildJudgePromptText(commandRuntime, artifactType, claudeWorkDir) +
          `REPO_PATH=${expandedRepoPath}\n`;
        const promptFile = path.join(claudeWorkDir, `${label}-prompt.txt`);
        await fs.writeFile(
          promptFile,
          buildPromptWithOutputContract(
            commandRuntime,
            body.command,
            prompt,
            claudeWorkDir
          )
        );

        const pipeline = buildNativePromptPipeline(
          commandRuntime,
          stdinClaudeArgs,
          claudeWorkDir,
          harnessBin,
          promptFile
        );
        collectedSpawnMeta.command = pipeline.cmd;
        collectedSpawnMeta.args = redactSpawnArgs(pipeline.args);
        spawnStartedAt = Date.now();
        child = spawn(pipeline.cmd, pipeline.args, {
          cwd: claudeWorkDir,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (
        body.command === LoopCommand.RequestChanges &&
        commandRuntime.harness.launchMode ===
          CommandPackLaunchMode.ClaudeSlashCommand
      ) {
        // REQUEST_CHANGES: use claude directly with /code:amend-plan.
        // Must use -p (headless mode) so --allowedTools grants full permission
        // without prompting. Pipes through stream_formatter.py for readable logs.
        const claudeArgs = [...baseClaudeArgs];

        // Resume from parent session if available (matches harness --resume)
        if (body.parentSessionId) {
          claudeArgs.push("--resume", body.parentSessionId);
        }

        // Build /code:amend-plan invocation matching harness
        const promptFile = path.join(claudeWorkDir, "prompt.md");
        let amendPrompt =
          "Please amend the plan based on the requested changes.";
        if (existsSync(promptFile)) {
          amendPrompt = readFileSync(promptFile, "utf-8");
        }
        // Sanitize prompt matching harness's prepare-message step
        const sanitized = amendPrompt
          .replaceAll(/[\n\r]+/g, " ")
          .replaceAll(/\s{2,}/g, " ")
          .replaceAll(/"/g, '\\"');
        claudeArgs.push(
          `/code:amend-plan --workdir ${claudeWorkDir} --message "${sanitized}"`
        );

        const pipeline = buildClaudePipeline(
          claudeArgs,
          claudeWorkDir,
          harnessBin
        );
        collectedSpawnMeta.command = pipeline.cmd;
        collectedSpawnMeta.args = redactSpawnArgs(pipeline.args);
        collectedSpawnMeta.cwd = worktreeDir!;
        spawnStartedAt = Date.now();
        child = spawn(pipeline.cmd, pipeline.args, {
          cwd: worktreeDir!,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (
        body.command === LoopCommand.GeneratePrd ||
        body.command === LoopCommand.RequestPrdChanges
      ) {
        // Build resolved peer metadata once and use it as the single source of
        // truth for both --add-dir flags and the prompt's "## Mounted paths"
        // footer (mirrors the ECS harness contract: footer paths cannot drift
        // from --add-dir paths).
        const peerRefs = toPeerWorktreeRefs(additionalWorktreeDirs);

        const promptFileName =
          body.command === LoopCommand.GeneratePrd
            ? "generate-prd-prompt.txt"
            : "request-prd-changes-prompt.txt";
        const promptFile = path.join(claudeWorkDir, promptFileName);
        const prompt = body.prompt! + buildMountPathsFooter(peerRefs);
        await fs.writeFile(
          promptFile,
          buildPromptWithOutputContract(
            commandRuntime,
            body.command,
            prompt,
            claudeWorkDir
          )
        );

        // Inject --add-dir per peer when the policy enables peers. The orchestrator
        // and validators are the primary gate; this is defense-in-depth so a
        // peer-disabled command can never receive --add-dir flags.
        const claudeArgsWithPeers = [...stdinClaudeArgs];
        if (getMultiRepoPolicy(body.command).supportsAdditionalRepos) {
          for (const peer of peerRefs) {
            claudeArgsWithPeers.push("--add-dir", peer.localPath);
          }
        }

        const pipeline = buildNativePromptPipeline(
          commandRuntime,
          claudeArgsWithPeers,
          claudeWorkDir,
          harnessBin,
          promptFile
        );
        collectedSpawnMeta.command = pipeline.cmd;
        collectedSpawnMeta.args = redactSpawnArgs(pipeline.args);
        collectedSpawnMeta.cwd = worktreeDir!;
        spawnStartedAt = Date.now();
        child = spawn(pipeline.cmd, pipeline.args, {
          cwd: worktreeDir!,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (body.command === LoopCommand.Bootstrap) {
        const params = parseBootstrapParams(body.prompt);
        if (!params || params.repos.length === 0) {
          throw new Error("BOOTSTRAP requires repos in prompt JSON");
        }

        const allowedDirs = getAllowedDirectories();
        const manifest: BootstrapManifestEntry[] = [];
        for (const repo of params.repos) {
          const branch = repo.branch ?? "main";
          const localPath = repo.localPath
            ? expandHome(repo.localPath)
            : findLocalRepo(repo.fullName, allowedDirs);
          if (!localPath) {
            manifest.push({
              fullName: repo.fullName,
              localPath: "",
              branch,
              skip: true,
              skipReason: "not found locally",
            });
            continue;
          }
          try {
            const st = statSync(localPath);
            if (!st.isDirectory()) {
              manifest.push({
                fullName: repo.fullName,
                localPath,
                branch,
                skip: true,
                skipReason: "path is not a directory",
              });
              continue;
            }
          } catch {
            manifest.push({
              fullName: repo.fullName,
              localPath,
              branch,
              skip: true,
              skipReason: "path does not exist",
            });
            continue;
          }
          try {
            assertPathAllowed(localPath, allowedDirs);
          } catch {
            manifest.push({
              fullName: repo.fullName,
              localPath: "",
              branch,
              skip: true,
              skipReason: "outside sandbox",
            });
            continue;
          }
          manifest.push({
            fullName: repo.fullName,
            localPath,
            branch,
            skip: false,
          });
        }

        writeFileSync(
          path.join(claudeWorkDir, "bootstrap-manifest.json"),
          JSON.stringify(manifest, null, 2)
        );

        const runnableRepos = manifest.filter((e) => !e.skip);
        const scriptLines: string[] = [
          "#!/bin/bash",
          `CLAUDE_BIN=${shellEscape(harnessBin)}`,
          "",
        ];
        for (const [i, entry] of runnableRepos.entries()) {
          const marker = path.join(claudeWorkDir, `repo-${i}-done`);
          const stderrLog = path.join(claudeWorkDir, `repo-${i}-stderr.log`);
          const outputDir = path.join(claudeWorkDir, `repo-${i}-agents`);
          scriptLines.push(
            `echo "=== BOOTSTRAP ${i}: ${shellEscape(entry.fullName)} ==="`,
            `OUTPUT_DIR=${shellEscape(outputDir)}`,
            `mkdir -p "$OUTPUT_DIR"`,
            `if ! cd ${shellEscape(entry.localPath)}; then`,
            `  echo "fail:cd" > ${shellEscape(marker)}`,
            "else",
            `  if "$CLAUDE_BIN" -p "/bootstrap:agent-bootstrap --output-dir $OUTPUT_DIR" 2>${shellEscape(stderrLog)}; then`,
            `    echo "ok" > ${shellEscape(marker)}`,
            "  else",
            `    echo "fail:$?" > ${shellEscape(marker)}`,
            "  fi",
            "fi",
            ""
          );
        }

        const bootstrapScript = path.join(claudeWorkDir, "bootstrap.sh");
        writeFileSync(bootstrapScript, scriptLines.join("\n"), { mode: 0o755 });

        collectedSpawnMeta.command = "bash";
        collectedSpawnMeta.args = [bootstrapScript];
        spawnStartedAt = Date.now();
        child = spawn("bash", [bootstrapScript], {
          cwd: claudeWorkDir,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else if (usesRunLoop) {
        // PLAN, EXECUTE: spawn run-loop.sh
        // Build args matching ECS harness-agent's buildRunLoopArgs():
        // 1. workdir (positional)
        // 2. --max-iterations (EXECUTE=150, PLAN=50)
        // 3. --prd (when prd.md exists)
        const scriptArgs = [claudeWorkDir];

        const maxIterations =
          body.command === LoopCommand.Execute ? "150" : "50";
        scriptArgs.push("--max-iterations", maxIterations);

        const prdPath = path.join(claudeWorkDir, LoopArtifactFile.Prd);
        if (existsSync(prdPath)) {
          scriptArgs.push("--prd", prdPath);
        }

        // Defense-in-depth: only inject --add-dir when the policy enables peers.
        // For the run-loop path (PLAN/EXECUTE today) this is equivalent to the
        // prior literal check; if a future command joins the policy table with
        // run-loop semantics, it lights up automatically.
        if (getMultiRepoPolicy(body.command).supportsAdditionalRepos) {
          for (const addEntry of additionalWorktreeDirs) {
            scriptArgs.push("--add-dir", addEntry.dir);
          }
        }

        collectedSpawnMeta.command = scriptPath!;
        collectedSpawnMeta.args = redactSpawnArgs(scriptArgs);
        collectedSpawnMeta.cwd = worktreeDir!;
        if (body.command === LoopCommand.Execute) {
          decisionTableVerificationStartOffset =
            getDecisionTableVerificationTelemetryOffset(claudeWorkDir);
        }
        loopPerfTelemetryStartOffset =
          getLoopPerfTelemetryOffset(claudeWorkDir);
        // Start the perf watcher BEFORE spawning the child so its
        // `.tool-calls/` baseline snapshot is taken while the directory
        // contains only prior-run sentinels (or is empty/missing). Starting
        // it post-spawn would race the child: any sentinel the child writes
        // before the watcher initialises would be folded into the baseline
        // and reconcileLoopPerfTelemetry() would later skip it as stale,
        // dropping legitimate current-run orphan telemetry.
        loopPerfWatcherHandle = startLoopPerfTelemetryWatcher(claudeWorkDir, {
          startOffset: loopPerfTelemetryStartOffset,
          traceContext: {
            commandId,
            operationId,
            loopId: body.loopId,
            jobId: body.loopId,
          },
          telemetryEmitter: Observability.getTelemetryEmitter(),
        });
        spawnStartedAt = Date.now();
        child = spawn(scriptPath!, scriptArgs, {
          cwd: worktreeDir!,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: spawnEnv,
        });
        child.unref();
      } else {
        throw new Error(
          `Unsupported command-pack launch mode ${commandRuntime.harness.launchMode} for ${body.command}`
        );
      }
    } catch (spawnErr) {
      closeSync(logFd);
      // The perf watcher is started before spawn() so its baseline snapshot
      // does not race the child. If spawn throws, the watcher is already
      // running — stop it before cleanup to release its fs.watch handle.
      if (loopPerfWatcherHandle) {
        try {
          await loopPerfWatcherHandle.stop();
        } catch {
          // Ignore — watcher errors must not mask the spawn failure.
        }
        loopPerfWatcherHandle = undefined;
      }
      const msg =
        spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      await postLoopEvent(
        apiBaseUrl,
        body.loopId,
        () => body.closedLoopAuthToken,
        {
          type: LoopEventType.Error,
          code: LoopErrorCode.SpawnFailed,
          message: msg,
        }
      );
      Observability.preflightSpawnFailed(
        commandId,
        operationId,
        body.loopId,
        msg
      );
      await cleanupOnError();
      json(context, 500, { error: `Failed to spawn process: ${msg}` });
      return;
    }
    closeSync(logFd);

    // Native observability: synthesize the `run` event at spawn, select the
    // harness adapter, and feed the harness stream through the tailer's per-line
    // sink. Best-effort — construction/emit never throws into the spawn path.
    if (usesNativeObservability) {
      try {
        nativeObservability = createNativeLoopObservabilitySession({
          loopId: body.loopId,
          command: body.command,
          harness: commandRuntime.harness.adapter.harness,
          repo: resolveLoopPrimaryFullName(body, expandedRepoPath) || undefined,
          branch:
            (worktreeDir
              ? (wt.getCurrentBranch(worktreeDir) ?? undefined)
              : undefined) ?? body.repo?.branch,
          claudeWorkDir,
          traceContext: {
            commandId,
            operationId,
            loopId: body.loopId,
            jobId: body.loopId,
          },
          telemetryEmitter: Observability.getTelemetryEmitter(),
        });
        nativeObservability.start();
      } catch (nativeObsErr) {
        nativeObservability = undefined;
        gatewayLog.warn(
          "loop-perf-telemetry",
          `Native observability init failed for loopId=${body.loopId}: ${nativeObsErr instanceof Error ? nativeObsErr.message : nativeObsErr}`
        );
      }
    }

    // Guard against double-firing: both 'error' and 'exit' can emit.
    let completionHandled = false;
    let stopTailer: { stop: () => void; flush: () => Promise<void> } = {
      stop: () => {},
      flush: () => Promise.resolve(),
    };
    const requestBinaryPathsResolver = getActiveBinaryPathsResolver();
    const onceComplete = async (
      code: number,
      signal?: string
    ): Promise<void> => {
      if (completionHandled) {
        return;
      }
      completionHandled = true;
      loopLog(body.loopId, `onceComplete fired, code=${code}`);
      // Persist exitCode synchronously (before any await) so the IPC
      // desktop:list-running-jobs reconciliation sees the exit handler has
      // claimed this job and does not race-override the status to STOPPED.
      if (jobStore) {
        const j = jobStore.getByLoopId(body.loopId);
        if (j && j.exitCode == null) {
          jobStore.upsert({
            ...j,
            exitCode: code,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      clearPendingLoopExit(body.loopId);
      try {
        await stopTailer.flush();
      } catch (err) {
        loopError(body.loopId, "Tailer flush error:", err);
      }
      const runCompletion = () =>
        handleProcessCompletion(
          code,
          body,
          apiBaseUrl,
          worktreeDir,
          claudeWorkDir,
          usedTempDir,
          expandedRepoPath,
          getAllowedDirectories,
          expectedMcpUrl,
          jobStore,
          webAppOrigin,
          commandId,
          operationId,
          wt,
          loopTokenStore,
          additionalWorktreeDirs,
          signal,
          spawnStartedAt,
          collectedSpawnMeta,
          decisionTableVerificationStartOffset,
          userVisibleLoopFailureSecret,
          loopPerfTelemetryStartOffset,
          loopPerfWatcherHandle,
          schedulers,
          nativeObservability,
          getClaudeShellEnv,
          onLoopCompleted
        ).catch((err) => {
          loopError(body.loopId, "Completion handler error:", err);
          gatewayLog.error(
            "loop-harness",
            `Completion handler error for loopId=${body.loopId}: ${err instanceof Error ? err.message : err}`
          );
          // Safety net: ensure the job reaches a terminal status even when
          // handleProcessCompletion throws, so the IPC exitCode guard does
          // not leave the job stuck as RUNNING forever.
          if (jobStore) {
            const j = jobStore.getByLoopId(body.loopId);
            if (j && j.status === "RUNNING") {
              jobStore.upsert({
                ...j,
                status: "FAILED",
                updatedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              });
            }
          }
        });
      if (requestBinaryPathsResolver) {
        void binaryPathsResolverContext.run(
          requestBinaryPathsResolver,
          runCompletion
        );
      } else {
        void runCompletion();
      }
    };

    // Prevent unhandled 'error' events (e.g. ENOENT if binary vanishes
    // between pre-flight check and spawn) from crashing Electron.
    child.on("error", (err) => {
      loopError(body.loopId, "Spawn error:", err.message);
      void onceComplete(1);
    });

    // Use 'exit' instead of 'close' — with detached processes using
    // inherited file descriptors (not pipes), 'close' may never fire
    // because there are no Node.js streams to track closure of.
    child.on("exit", (code, signal) => {
      loopLog(
        body.loopId,
        `Process exit event, code=${code}, signal=${signal ?? "none"}`
      );
      void onceComplete(code ?? 1, signal ?? undefined);
    });

    const pid = child.pid ?? null;

    if (!pid) {
      // error handler above will fire asynchronously — respond immediately
      json(context, 500, { error: "Failed to spawn process" });
      return;
    }

    // Replace sentinel with real entry — storing `child` prevents GC of the
    // ChildProcess handle which would silently drop the exit listener.
    registerPendingLoopExit(body.loopId);
    runningLoops.set(body.loopId, { pid, child, stage: "running" });
    stopTailer = startOutputTailer(
      tailerJsonlPath,
      apiBaseUrl,
      body.loopId,
      () =>
        loopTokenStore?.getLoopToken(body.loopId)?.token ??
        body.closedLoopAuthToken,
      jsonlPreSpawnOffset,
      jobStore
        ? (offset) => {
            // Persist replay-safe JSONL offset (framed + POST ok when output is emitted).
            const job = jobStore.getByLoopId(body.loopId);
            if (job) {
              jobStore.upsert({ ...job, lastObservedJsonlOffset: offset });
            }
          }
        : undefined,
      claudeWorkDir,
      loopTokenStore,
      nativeObservability
        ? (record) => nativeObservability?.onRecord(record)
        : undefined
    );
    spawnedSuccessfully = true;
    loopLog(body.loopId, `Spawned pid=${pid}, worktree=${worktreeDir}`);
    gatewayLog.debug(
      "loop-harness",
      `Spawned ${body.command} pid=${pid}, loopId=${body.loopId}, worktree=${worktreeDir}` +
        (additionalWorktreeDirs.length > 0
          ? `, additionalDirs=${additionalWorktreeDirs.map((e) => e.dir).join(",")}`
          : "")
    );

    // Bind runtime details to an existing LocalJob or create a new one for this loop
    if (jobStore) {
      const existing = jobStore.getByLoopId(body.loopId);
      const now = new Date().toISOString();
      const logPath = path.join(claudeWorkDir, "symphony-loop.log");
      const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
      const statePath = path.join(claudeWorkDir, "state.json");
      const command = body.command as LocalJobCommand;
      const s3StateKey =
        typeof rawBody.s3StateKey === "string" && rawBody.s3StateKey.length > 0
          ? rawBody.s3StateKey
          : existing?.s3StateKey;
      jobStore.upsert({
        id: body.loopId,
        kind: "SYMPHONY_LOOP",
        loopId: body.loopId,
        command,
        ...existing,
        ...(commandId ? { commandId } : {}),
        ...(operationId ? { operationId } : {}),
        artifactSlug: body.artifactSlug ?? existing?.artifactSlug,
        baseBranch: body.repo?.branch ?? existing?.baseBranch ?? "main",
        primaryRepoFullName:
          resolveLoopPrimaryFullName(body, expandedRepoPath) ||
          existing?.primaryRepoFullName,
        webAppOrigin: webAppOrigin || existing?.webAppOrigin,
        expectedMcpUrl: expectedMcpUrl ?? existing?.expectedMcpUrl,
        committer: body.committer ?? existing?.committer,
        worktreeDir: worktreeDir ?? undefined,
        claudeWorkDir,
        ...(s3StateKey ? { s3StateKey } : {}),
        // Persist so finalizer/boot-recovery can remove these after a crash
        // or graceful shutdown; in-process spawn keeps its own local copy for
        // live cleanup on exit.
        ...(additionalWorktreeDirs.length > 0
          ? { additionalWorktreeDirs: [...additionalWorktreeDirs] }
          : {}),
        logPath,
        jsonlPath,
        statePath,
        pid,
        status: "RUNNING",
        updatedAt: now,
        startedAt: existing?.startedAt ?? now,
        apiBaseUrl,
        lastObservedJsonlOffset:
          existing?.lastObservedJsonlOffset ?? jsonlPreSpawnOffset,
      });
    }

    Observability.jobStarted(
      commandId,
      operationId,
      body.loopId,
      pid,
      body.command
    );

    // Write PID file (safe to await now — close handler is already registered)
    await fs.writeFile(path.join(claudeWorkDir, "process.pid"), String(pid));

    // Start refresh scheduler and heartbeat now that the loop is running
    if (loopTokenStore) {
      const expiresAtSec = parseJwtExpiry(body.closedLoopAuthToken);
      const expiresAtMs =
        expiresAtSec === null ? undefined : expiresAtSec * 1000;
      schedulers.startRefresh(body.loopId, expiresAtMs, {
        apiBaseUrl,
        getToken: () =>
          loopTokenStore.getLoopToken(body.loopId)?.token ??
          body.closedLoopAuthToken,
        loopTokenStore,
      });
      schedulers.registerSleep(body.loopId, {
        apiBaseUrl,
        getToken: () => loopTokenStore.getLoopToken(body.loopId)?.token ?? null,
        loopTokenStore,
        // Thread PoP deps into registerSleep so the sleep-recovery heartbeat
        // on system wake fires with PoP headers and managed-key Authorization
        // fallback. Without this, the sleep-recovery path (most likely revival
        // trigger) fires without PoP headers — SEC-002 finding.
        getApiKey: popDeps?.getApiKey,
        getApiKeyProvenance: popDeps?.getApiKeyProvenance,
        signDesktopRequest: popDeps?.signDesktopRequest,
        onDesktopPopUnavailable: popDeps?.onDesktopPopUnavailable,
      });
    }
    schedulers.startHeartbeat(body.loopId, {
      apiBaseUrl,
      getToken: () =>
        loopTokenStore?.getLoopToken(body.loopId)?.token ??
        body.closedLoopAuthToken,
      loopTokenStore,
      // Thread PoP fields so every heartbeat attaches X-Desktop-* PoP headers
      // when provenance is DESKTOP_MANAGED (AC-002, AC-004).
      getApiKey: popDeps?.getApiKey,
      getApiKeyProvenance: popDeps?.getApiKeyProvenance,
      signDesktopRequest: popDeps?.signDesktopRequest,
      onDesktopPopUnavailable: popDeps?.onDesktopPopUnavailable,
      // Supply getTokenMeta for proactive JWT-expiry detection (T-1.4 / AC-011).
      // getTokenMeta wins over getToken in postLoopHeartbeat, so it must carry
      // the same body.closedLoopAuthToken fallback getToken has — otherwise a
      // USER_CREATED loop short-circuits to missing_token when safeStorage is
      // unavailable (setLoopToken threw at start, so the store is empty). The
      // synthesized meta omits expiresAt so isJwtUsable treats it as a usable
      // legacy token, matching the pseudo-meta postLoopHeartbeat builds for the
      // legacy getToken path.
      getTokenMeta: loopTokenStore
        ? () =>
            loopTokenStore.getLoopToken(body.loopId) ?? {
              token: body.closedLoopAuthToken,
            }
        : undefined,
      // When jobStore is absent (legacy no-store path), the heartbeat cannot look up or
      // finalize a local job. Provide a no-op stub so the TypeScript type is satisfied
      // (runHeartbeatTick logs a warning and skips finalizeFn when getByLoopId returns
      // undefined) and a no-op finalizeFn that the owning scheduler never needs.
      jobStore: jobStore ?? createStubJobStore(),
      finalizeFn: jobStore
        ? makeHeartbeatFinalizeFn(
            {
              jobStore,
              // Real telemetry so heartbeat-terminated loops launched via this
              // path are visible to monitoring (not swallowed by a no-op).
              telemetry: Observability.getTelemetryEmitter(),
              getToken: () =>
                loopTokenStore?.getLoopToken(body.loopId)?.token ??
                body.closedLoopAuthToken,
              apiBaseUrl,
              isProcessRunning,
              getAllowedDirectories,
              loopTokenStore,
              schedulers,
            },
            "heartbeat-terminal"
          )
        : async () => {},
      // Pass the process liveness checker for T-1.5 process-alive guard.
      isProcessRunning,
      // Canonical telemetry so the process-alive suppression event is observable.
      telemetry: Observability.getTelemetryEmitter(),
    });

    json(context, 200, {
      success: true,
      loopId: body.loopId,
      pid,
      worktreePath: worktreeDir,
    });
  } finally {
    // Clean up sentinel and persisted token if we never reached a successful spawn
    if (!spawnedSuccessfully) {
      clearPendingLoopExit(body.loopId);
      runningLoops.delete(body.loopId);
      loopTokenStore?.deleteLoopToken(body.loopId);
      // Best-effort cleanup of any additional repo worktrees created before spawn failed
      void cleanupAdditionalWorktrees(additionalWorktreeDirs, body.loopId, wt);
    }
  }
}

// ---------------------------------------------------------------------------
// Kill handler
// ---------------------------------------------------------------------------

async function handleLoopKill(
  context: OperationRequestContext,
  jobStore?: JobStore
): Promise<void> {
  const rawBody = parseJsonBody(context);
  if (!rawBody) {
    json(context, 400, { error: "Invalid JSON body" });
    return;
  }

  const loopId = typeof rawBody.loopId === "string" ? rawBody.loopId : null;
  if (!loopId) {
    json(context, 400, { error: "loopId is required" });
    return;
  }

  const entry = runningLoops.get(loopId);
  if (entry === undefined) {
    // Post-restart fallback: check JobStore for a live PID
    if (jobStore) {
      const job = jobStore.getByLoopId(loopId);
      if (job?.pid != null) {
        let processWasAlive = false;
        try {
          process.kill(job.pid, 0); // alive?
          processWasAlive = true;
          process.kill(-job.pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 3000));
          try {
            process.kill(job.pid, 0);
            process.kill(-job.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        } catch {
          /* already dead */
        }
        jobStore.upsert({
          ...job,
          status: processWasAlive ? "CANCEL_PENDING" : "CANCELLED",
          updatedAt: new Date().toISOString(),
          ...(processWasAlive ? {} : { completedAt: new Date().toISOString() }),
        });
        json(context, 200, {
          success: true,
          message: "Loop process terminated (restart fallback)",
        });
        return;
      }
    }
    json(context, 404, { error: "No running process found for this loop" });
    return;
  }
  if (entry.pid <= 0) {
    json(context, 409, { error: "Loop is still initializing, retry shortly" });
    return;
  }

  // Set CANCEL_PENDING before sending signals so handleProcessCompletion
  // sees the cancellation intent when the exit event fires.
  if (jobStore) {
    const existingJob = jobStore.getByLoopId(loopId);
    if (existingJob) {
      jobStore.upsert({
        ...existingJob,
        status: "CANCEL_PENDING",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  try {
    process.kill(entry.pid, 0); // Check alive
    process.kill(-entry.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      process.kill(entry.pid, 0);
      process.kill(-entry.pid, "SIGKILL");
    } catch {
      // Already gone
    }
  } catch {
    // Process already terminated
  }

  runningLoops.delete(loopId);
  clearPendingLoopExit(loopId);
  json(context, 200, { success: true, message: "Loop process terminated" });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSymphonyLoopRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  schedulers: LoopSchedulerContext,
  getApiOrigin?: () => string,
  jobStore?: JobStore,
  getWebAppOrigin?: () => string,
  worktreeProvider?: WorktreeProvider,
  loopTokenStore?: LoopTokenStore,
  getSymphonyDir?: () => string,
  getBinaryPaths?: BinaryPathsResolver,
  popDeps?: LoopPopDeps,
  getClaudeShellEnv: ClaudeCodeShellEnvProvider = getClaudeCodeShellEnv,
  onLoopCompleted?: LoopCompletedHook
): void {
  dispatcher.register("POST", "/api/gateway/symphony/loop", async (context) => {
    const run = () =>
      handleLoopRequest(
        context,
        getAllowedDirectories,
        schedulers,
        getApiOrigin,
        jobStore,
        getWebAppOrigin,
        worktreeProvider,
        loopTokenStore,
        getSymphonyDir,
        popDeps,
        getClaudeShellEnv,
        onLoopCompleted
      );

    if (getBinaryPaths) {
      await binaryPathsResolverContext.run(getBinaryPaths, run);
      return;
    }

    await run();
  });

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/loop/kill",
    async (context) => {
      await handleLoopKill(context, jobStore);
    }
  );
}
