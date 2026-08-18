import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
} from "@repo/api/src/types/desktop-transcripts";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import {
  createLocalTranscriptResolverDeps,
  createMemoizedDiscover,
  type LocalTranscriptPathResolverDeps,
  listLocalTranscriptFileKeys,
} from "../transcript-sync/local-transcript-path-resolver.js";

/**
 * The detail-gating resolver deps, built ONCE per `stateDir` so the discovery
 * memo actually survives between calls.
 *
 * The session-detail IPC is polled every few seconds while a detail is open, and
 * an unmemoized `discover()` is a full recursive walk of every collector root —
 * so building fresh deps per call would turn a per-session lookup into an
 * entire-corpus sweep per poll in the MAIN process. `getStore` stays a thunk
 * over the latest store reference (it is null until the db host is up), and the
 * cache holds a SINGLE entry keyed by `stateDir`, so it cannot grow.
 */
let detailGatingResolver: {
  stateDir: string;
  deps: LocalTranscriptPathResolverDeps;
} | null = null;
let detailGatingTranscriptStore: TranscriptSyncStore | null = null;

function detailGatingTranscriptResolverDeps(
  store: TranscriptSyncStore | null,
  stateDir: string
): LocalTranscriptPathResolverDeps {
  detailGatingTranscriptStore = store;
  if (detailGatingResolver?.stateDir !== stateDir) {
    // Shared factory wires the lazy discovery import once — matches the read
    // bridge wiring (both keep the collector modules off the desktop-boot
    // static-import graph, the agent-dashboard boundary). `stateDir` binds the
    // materialized-OpenCode enumerator so an OpenCode projection opens the local
    // read gate too, not just Claude/Codex (FEA-3932).
    const base = createLocalTranscriptResolverDeps(
      () => detailGatingTranscriptStore,
      stateDir
    );
    detailGatingResolver = {
      stateDir,
      deps: {
        getStore: () => detailGatingTranscriptStore,
        discover: createMemoizedDiscover(base.discover),
      },
    };
  }
  return detailGatingResolver.deps;
}

/**
 * FEA-3324 / #2977: resolve the desktop-local transcript availability summaries
 * for a session's HARNESS `externalSessionId`, so the shared session-detail
 * panel knows an on-disk `.jsonl` exists and enables its transcript read (which
 * then serves the local bytes over the SSRF-safe read bridge). Returns one
 * `available` summary per local file, else `null` (the detail omits
 * `transcripts` and the panel renders its projected trace).
 *
 * ISS-4677 widened this from a `main`-ONLY probe to the full per-session
 * enumeration. The old shape capped a desktop-local detail at exactly one
 * transcript, so the shared `TranscriptFileSwitcher` — which needs more than one
 * file — could never render on desktop: a local session's subagent sidechains
 * were unreachable there even with the files on disk.
 *
 * Paths are resolved store-first / discovery — the SAME sources the read bridge
 * uses — so this works even when the sync flag is off or the files haven't been
 * observed yet. We do NOT return any path (the detail never exposes a filesystem
 * path to the renderer); only EXISTENCE opens the read gate, and the read bridge
 * re-resolves + re-anchors each path itself before a byte is read.
 */
export async function resolveLocalTranscriptSummaries(
  store: TranscriptSyncStore | null,
  externalSessionId: string,
  stateDir: string
): Promise<TranscriptAvailabilitySummary[] | null> {
  const fileKeys = await listLocalTranscriptFileKeys(
    detailGatingTranscriptResolverDeps(store, stateDir),
    externalSessionId
  );
  if (fileKeys.length === 0) {
    return null;
  }
  return fileKeys.map((fileKey) => ({
    fileKey,
    // The on-disk copy is present and readable now; the summary drives the
    // panel's LOCAL read descriptor. `uploadedAt` is null — there is no
    // archive identity here (the bytes are served locally, not from S3).
    availability: TranscriptAvailability.Available,
    uploadedAt: null,
    // FEA-3476: only a `permanentlyUnavailable` file carries a skip reason; a
    // locally-available transcript never has one.
    permanentFailureReason: null,
  }));
}
