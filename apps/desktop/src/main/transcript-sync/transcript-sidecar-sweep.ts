/**
 * @file transcript-sidecar-sweep.ts
 * @description ISS-4390 slice 2 — the HOOK channel's subagent-sidecar flush.
 *
 * A `SubagentStop` payload names the PARENT `transcript_path`, never the sidecar
 * that just finished, so this lane cannot resolve one known file the way the
 * watcher channel does (`live-transcript-ref-resolver.ts`). It enumerates the
 * session's sidecars instead and enqueues the ones carrying new bytes.
 *
 * DORMANT IN CURRENT PRODUCTION: `CLAUDE_LIVE_HOOK_ENABLED` is hardcoded false
 * (FEA-3729) and the listener drops every Claude hook payload before it reaches
 * the service, so nothing calls this today — Claude runs on the WATCHER. This is
 * written and tested against the day that kill switch flips.
 */
import path from "node:path";
import { TranscriptSyncClass } from "../../shared/transcript-sync-status-contract.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import {
  observeTranscriptRef,
  type TranscriptObserveDeps,
} from "./transcript-observe.js";
import type { TranscriptSyncServiceOptions } from "./transcript-sync-options.js";
import { TranscriptSourceHarness } from "./transcript-sync-types.js";

export type TranscriptSidecarSweepDeps = {
  opts: TranscriptSyncServiceOptions;
  observe: TranscriptObserveDeps;
  /** PRD-532 §7 consent gate — see `TranscriptSyncService.tierAllowsSync`. */
  tierAllowsSync: () => boolean;
  log: (message: string) => void;
  drainOnce: () => Promise<void>;
};

/**
 * Enqueue this Claude session's subagent sidecars that have bytes the lane has
 * not uploaded yet.
 *
 * Best-effort throughout — this rides a hook, and a failure here must never
 * break the main transcript's flush. Anything skipped is still covered by the
 * 30-min discovery sweep.
 */
export async function enqueueChangedClaudeSidecars(
  deps: TranscriptSidecarSweepDeps,
  externalSessionId: string,
  mainTranscriptPath: string
): Promise<void> {
  const listSubagentRefs = deps.opts.listSubagentRefs;
  if (!(listSubagentRefs && deps.tierAllowsSync())) {
    return;
  }
  const store = deps.opts.getStore();
  if (!store) {
    return;
  }
  // The hook listener is unauthenticated localhost, so `externalSessionId` and
  // `mainTranscriptPath` arrive as an ATTACKER-CHOOSABLE PAIR: the trust guard
  // proves the path sits under a trusted root, not that it belongs to the
  // claimed session. Unbound, a mismatched pair would file one session's whole
  // sidecar set under another session's archive namespace. A Claude transcript
  // is `<projectDir>/<sessionId>.jsonl`, and discovery already derives identity
  // that way (`sessionIdFromTranscriptPath`), so requiring agreement both
  // closes the pairing and keeps this lane consistent with the sweep.
  if (path.basename(mainTranscriptPath, ".jsonl") !== externalSessionId) {
    deps.log("transcript sidecar sweep rejected session/path mismatch");
    return;
  }
  let refs: Array<{ fileKey: string; sourcePath: string }>;
  try {
    refs = await listSubagentRefs(mainTranscriptPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`transcript subagent enumeration failed: ${message}`);
    return;
  }
  // Observe every changed sidecar FIRST, then drain once. Draining per-ref
  // would run a full `listReady()` + upload cycle for each sidecar in the
  // session; the drain already picks up everything queued, so one pass at the
  // end does the same work in a single cycle.
  let observedAny = false;
  for (const ref of refs) {
    // Per-ref isolation: one unreadable sidecar (a vanished file, a store
    // hiccup) must not abort the sweep and drop every LATER sidecar onto the
    // 30-min pass. That is the best-effort degradation this path claims.
    try {
      const observed = await observeChangedSidecar(
        deps,
        store,
        externalSessionId,
        ref
      );
      observedAny = observedAny || observed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`transcript sidecar ${ref.fileKey} skipped: ${message}`);
    }
  }
  if (observedAny) {
    await deps.drainOnce();
  }
}

/**
 * Observe ONE sidecar if its RAW bytes changed since the lane last saw it.
 * Returns whether anything was queued.
 *
 * Compares the local size/mtime against the row's `lastSize`/`lastMtimeMs` —
 * the raw fingerprint — and deliberately NOT against `syncedByteOffset`.
 * That offset is a cursor into the REDACTED archive object (the executor sets
 * it from the server ack and checks it against the redacted stream's
 * `planEndOffset`), and redaction is not length-preserving in either
 * direction: `[REDACTED:<label>]` can be longer than the token it replaces,
 * while a dropped unterminated trailing line makes the object shorter. Mixing
 * the two units both ways — skipping a sidecar whose redacted object merely
 * ran longer than its raw bytes, and never skipping a still-appending one —
 * is exactly the lag and the queue churn this sweep exists to avoid.
 */
async function observeChangedSidecar(
  deps: TranscriptSidecarSweepDeps,
  store: TranscriptSyncStore,
  externalSessionId: string,
  ref: { fileKey: string; sourcePath: string }
): Promise<boolean> {
  const trustedPath = deps.opts.resolveTrustedTranscriptPath(ref.sourcePath);
  if (trustedPath === null) {
    return false;
  }
  const [stat, row] = await Promise.all([
    deps.opts.statFile(trustedPath),
    store.get(externalSessionId, ref.fileKey),
  ]);
  const unchanged =
    stat !== null &&
    row !== null &&
    row.lastSize === stat.size &&
    row.lastMtimeMs === stat.mtimeMs;
  if (unchanged) {
    return false; // no new raw bytes — don't grow the queue with a no-op
  }
  await observeTranscriptRef(
    deps.observe,
    store,
    {
      externalSessionId,
      fileKey: ref.fileKey,
      sourceHarness: TranscriptSourceHarness.Claude,
      sourcePath: trustedPath,
    },
    TranscriptSyncClass.Live
  );
  return true;
}
