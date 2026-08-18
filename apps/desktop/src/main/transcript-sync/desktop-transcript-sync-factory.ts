import type { TranscriptEgressGate } from "../../shared/transcript-sync-status-contract.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { createDesktopTranscriptsClient } from "../transcript/desktop-transcripts-client.js";
import {
  createTranscriptSyncExecutor,
  statTranscriptFile,
} from "./transcript-sync-executor.js";
import { TranscriptSyncService } from "./transcript-sync-service.js";
import {
  TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX,
  TranscriptSourceHarness,
} from "./transcript-sync-types.js";
import {
  isPendingTrustedTranscriptPath,
  resolveTrustedClaudeTranscriptPath,
} from "./trusted-transcript-path.js";
import { createUtilityProcessOpencodeMaterializeRunner } from "./utility-process-opencode-materialize-runner.js";

/**
 * The application state the transcript archive lane reads. Every entry is a
 * live accessor: the lane self-no-ops until the DB runtime, the consent tier,
 * and connectivity all line up, and re-evaluates on every tick.
 */
export type DesktopTranscriptSyncDeps = {
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string;
  /**
   * The collector/materializer state directory — the same
   * `<userData>/agent-dashboard-ingest` the dashboard runtime's CollectorManager
   * uses, so the OpenCode materializer's fingerprint + projection files live
   * alongside the ingest caches (FEA-3932).
   */
  stateDir: string;
  getAgentDashboardRuntime: () => AgentDashboardDesignSystemRuntime | null;
  /** The live relay compute target id, or null when the cloud link is offline. */
  getComputeTargetId: () => string | null;
  isTranscriptSyncEnabled: () => boolean;
  isTranscriptSyncTierAllowed: () => boolean;
  /**
   * ISS-5348: the same gate, tri-state, so the status snapshot can distinguish
   * an unresolved org policy from a settled denial. Egress still uses the
   * boolean above.
   */
  getTranscriptSyncTierGate: () => TranscriptEgressGate;
  hasDesktopSessionAuth: () => boolean;
};

/**
 * Assemble the transcript archive-lane service (FEA-2715).
 *
 * The control-plane client authenticates with the first-party desktop session
 * JWT (withAnyAuth Bearer); the executor reads the relay compute-target id for
 * the request body. The fingerprint store is reached lazily through the
 * agent-dashboard runtime (null until the db host is ready), so the service
 * self-no-ops until both the DB and connectivity exist.
 *
 * NOTE: the materialized OpenCode root is registered as a trusted transcript
 * path root UNCONDITIONALLY at application construction, not here — the
 * always-on read bridge needs it even when sync is disabled.
 */
export function createDesktopTranscriptSyncService(
  deps: DesktopTranscriptSyncDeps
): TranscriptSyncService {
  const transcriptsClient = createDesktopTranscriptsClient({
    getAccessToken: () => deps.getAccessToken(),
    getApiOrigin: () => deps.getApiOrigin(),
  });
  const stateDir = deps.stateDir;
  // ISS-5337: the OpenCode materialize pass runs in its own utilityProcess, so
  // re-deriving the corpus never holds the main event loop (see the runner).
  const opencodeMaterializeRunner =
    createUtilityProcessOpencodeMaterializeRunner({
      stateDir,
      log: (message) => gatewayLog.info("transcript-sync", message),
    });
  return new TranscriptSyncService({
    getStore: () => deps.getAgentDashboardRuntime()?.transcriptSync ?? null,
    buildExecutor: (store) =>
      createTranscriptSyncExecutor({
        store,
        client: transcriptsClient,
        getComputeTargetId: () => deps.getComputeTargetId(),
        // FEA-3907: re-checked mid-upload so lowering the Data & Sync level to
        // Off (or the tier gate closing) aborts an in-flight transcript upload
        // at the executor boundary — the same live enabled + consent-tier
        // conditions the drain's `shouldRun` gate uses — instead of only
        // suppressing the NEXT drain tick.
        isSyncStillPermitted: () =>
          deps.isTranscriptSyncEnabled() && deps.isTranscriptSyncTierAllowed(),
        now: () => new Date().toISOString(),
        log: (message) => gatewayLog.info("transcript-sync", message),
      }),
    // Lazy import: keeps the collector-backed discovery module (and its
    // collector imports) off the desktop boot static-import graph, satisfying
    // the agent-dashboard boundary guard. The OpenCode materialized-file
    // enumerator is bound to the state dir here (FEA-3932); Claude/Codex use
    // the module defaults.
    discover: async () => {
      const [discoveryModule, materializedModule] = await Promise.all([
        import("./transcript-discovery.js"),
        import("./opencode-materialized-discovery.js"),
      ]);
      return discoveryModule.discoverTranscriptFiles({
        listOpencodeMaterializedFiles: () =>
          materializedModule.listOpencodeMaterializedFiles(stateDir),
      });
    },
    // ISS-4390: resolve a changed CHILD transcript's `subagent:{id}` key so it
    // arms the same ~5 min flush as `main`. Lazy-imported for the same reason
    // `discover` is — the resolver reaches into the Claude/Codex collector
    // modules, which the boot static-import graph may not touch.
    resolveLiveRef: async (harness, mappedSourcePath, changedPath) => {
      const module = await import("./live-transcript-ref-resolver.js");
      return module.resolveLiveTranscriptFileKey(
        harness,
        mappedSourcePath,
        changedPath
      );
    },
    // ISS-4390 slice 2: enumerate a Claude session's sidecars for the HOOK
    // channel, which has no changed path of its own. Lazy-imported for the
    // same boundary reason as `resolveLiveRef`.
    listSubagentRefs: async (mainTranscriptPath) => {
      const module = await import("./live-transcript-ref-resolver.js");
      return module.listClaudeSubagentRefsForTranscript(mainTranscriptPath);
    },
    // FEA-3932: regenerate OpenCode projections from `opencode.db` before each
    // discovery pass. Revision-gated internally (an unchanged DB rewrites
    // nothing). ISS-5337: the pass runs in a utilityProcess rather than inline.
    // The collector graph stays off the boot static-import graph either way —
    // that is what the previous lazy `import()` bought, and here the collector
    // imports live in the worker entry, which nothing statically imports.
    materialize: () => opencodeMaterializeRunner.materialize(),
    stopMaterialize: () => opencodeMaterializeRunner.stop(),
    // FEA-3932: one-shot OpenCode dead-letter redrive on service start so
    // sessions dead-lettered under a prior build (before materialization
    // existed) get one automatic retry once re-materialized. OpenCode-scoped —
    // Claude/Codex terminal dead-letters are untouched.
    redriveOnStart: () => {
      const store = deps.getAgentDashboardRuntime()?.transcriptSync ?? null;
      if (!store) {
        return Promise.resolve(0);
      }
      return store.redriveDeadLettered({
        sourceHarness: TranscriptSourceHarness.OpenCode,
        // Scope to the missing-source terminal FAMILY (sessions that failed
        // only because materialization did not yet exist). Terminal too_large /
        // oversized-line OpenCode dead-letters carry a different reason and stay
        // dead — re-running materialization cannot shrink a pathological file —
        // so they don't churn back onto the queue on every start (FEA-3932).
        lastErrorPrefix: TRANSCRIPT_SOURCE_GONE_DEAD_LETTER_PREFIX,
        now: new Date().toISOString(),
      });
    },
    isEnabled: () => deps.isTranscriptSyncEnabled(),
    // PRD-532 §7: honor the sync-observability consent tier — only the `full`
    // tier permits session contents to leave the machine (no-op until the
    // user has chosen a tier through the unified onboarding flow).
    getCloudSyncTierGate: () => deps.getTranscriptSyncTierGate(),
    // Requires a relay compute target AND first-party auth (the Bearer JWT).
    isOnline: () =>
      deps.getComputeTargetId() !== null && deps.hasDesktopSessionAuth(),
    getComputeTargetId: () => deps.getComputeTargetId(),
    resolveTrustedTranscriptPath: (candidate) =>
      resolveTrustedClaudeTranscriptPath(candidate),
    isPendingTrustedTranscriptPath: (candidate) =>
      isPendingTrustedTranscriptPath(candidate),
    statFile: statTranscriptFile,
    log: (message) => gatewayLog.info("transcript-sync", message),
  });
}
