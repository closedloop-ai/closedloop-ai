/**
 * `@repo/crewd` — the portable, fs/CLI-free scheduler core (FEA-3812).
 *
 * Everything re-exported here is safe to import from any surface, including the
 * apps/desktop renderer: the model is transport-neutral Zod shapes, the daemon
 * depends on the injectable `StorePort` / `LockPort` seams (not a concrete
 * store), the broker is pure routing, and the cascade/dispatch appear here only
 * as erased *types*. The Node-only runnables — the concrete harness drivers,
 * `defaultRegistry`, `runCascade`, and `createDispatch` (all of which reach
 * `harness/exec.ts` → `node:child_process`/`node:fs`) — are deliberately NOT
 * value-exported here; import the registry from `@repo/crewd/harness`,
 * `createDispatch` from `@repo/crewd/dispatch`, and the concrete drivers /
 * `runCascade` from their own module paths in Node/main-process code. The
 * filesystem-backed `TaskStore`, the `FileLock`, and the CLI likewise live at
 * the `@repo/crewd/store`, `@repo/crewd/file-lock`, and `@repo/crewd/cli`
 * subpaths. Pulling in the root barrel never drags in `node:fs`, `node:child_process`,
 * or `process.argv`.
 */

export type { BrokerPolicy, RoutableTask, RouteDecision } from "./broker.js";
export {
  decideRoute,
  defaultTaskRoute,
  primaryHarness,
  ScheduleRoute,
} from "./broker.js";
// ── dispatch wiring (types only — the runnable `createDispatch` lives at
//    `@repo/crewd/dispatch`; it reaches the cascade → exec and is Node-only) ──
export type {
  DispatchDeps,
  OrchestrationRunner,
  OrchestrationRunners,
} from "./dispatch.js";
// ── cascade (types only — `runCascade` and the concrete harness drivers live
//    at `@repo/crewd/harness`; they import `node:child_process`/`node:fs` and
//    are NOT renderer-safe, so the root barrel exposes only their types) ──
export type {
  CascadeEntry,
  CascadeOpts,
  CascadeResult,
} from "./harness/cascade.js";
// ── harness abstraction (registry + capability types only) ──
export type { HarnessRegistry } from "./harness/index.js";
export type {
  Harness,
  HarnessCapabilities,
  RunOpts,
  RunResult,
} from "./harness/types.js";
export type {
  CascadeAttempt,
  CascadeStep,
  RunRecord,
  ScheduledTask,
  StoreFile,
} from "./model.js";
// ── model (serializable data shapes) ──
export {
  AVAILABLE_MODELS,
  CLOUD_ROUTINE_ID_META_KEY,
  cascadeAttemptSchema,
  cascadeStepSchema,
  DEFAULT_MODEL,
  dedupeCascade,
  emptyStore,
  HarnessName,
  harnessNameSchema,
  hasConfirmedCloudRoutine,
  hasConfirmedNativeOwner,
  hasSpentOneTimeFire,
  isNativeRoute,
  NATIVE_OWNER_META_KEY,
  NativeSchedule,
  normalizeTaskRoute,
  PassKind,
  passKindSchema,
  RunStatus,
  resolveModel,
  runRecordSchema,
  runStatusSchema,
  scheduledTaskSchema,
  shouldStampFireCursor,
  storeFileSchema,
  TaskRoute,
  taskRouteHydrationSchema,
  taskRouteSchema,
} from "./model.js";
export type {
  FiledFindingResult,
  FileFindingsOptions,
  FileFindingsResult,
  Finding,
} from "./passes/findings.js";
// ── pure pass helpers ──
export {
  buildIssueContent,
  DEFAULT_FINDING_TITLE_PREFIX,
  extractSignatureMarker,
  FiledFindingStatus,
  fileFindings,
  findingKey,
  normKey,
  openKeysFromDocuments,
  parseFindingsJsonl,
  SIGNATURE_MARKER,
} from "./passes/findings.js";
export type {
  PromptBundleInput,
  RuntimeContextInput,
} from "./passes/prompt-bundle.js";
export {
  assemblePromptBundle,
  buildRuntimeContext,
} from "./passes/prompt-bundle.js";
export type {
  CronOpts,
  CronValidation,
  DueInput,
  DueResult,
} from "./scheduler/cron.js";
// ── scheduler core ──
export {
  computeDue,
  jitterMs,
  nextRun,
  prevRun,
  validateCron,
} from "./scheduler/cron.js";
export type {
  DaemonConfig,
  DaemonDeps,
  Dispatch,
  DispatchContext,
  DispatchOutcome,
  TickReport,
} from "./scheduler/daemon.js";
export { Daemon } from "./scheduler/daemon.js";
export type { LockPort } from "./scheduler/lock-port.js";
export { noopLock } from "./scheduler/lock-port.js";
// ── night-crew scheduled-review config (FEA-4143 Slice 2) ──
export type {
  NightCrewConfig,
  NightCrewSlackDestination,
} from "./scheduler/night-crew-config.js";
export {
  NIGHT_CREW_CONFIG_META_KEY,
  nightCrewConfigSchema,
  nightCrewSlackDestinationSchema,
  readNightCrewConfig,
} from "./scheduler/night-crew-config.js";
// ── cloud-routine registration seam (FEA-3816 / PRD-553 M4) ──
export type {
  RoutineRegistrar,
  RoutineRegistrationResult,
  ScheduledTasksRegistrar,
  ScheduledTasksRegistrationResult,
} from "./scheduler/routine-registrar.js";
export { createStubRoutineRegistrar } from "./scheduler/routine-registrar.js";
// ── storage / lock seams (the FEA-3812 extraction) ──
export type { StorePort, TaskUpsert } from "./scheduler/store-port.js";
