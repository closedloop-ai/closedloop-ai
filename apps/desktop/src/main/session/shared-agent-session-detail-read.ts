/**
 * @file shared-agent-session-detail-read.ts
 * @description The desktop-local session-detail READ: one session id into the
 * canonical `AgentSessionDetail` the shared panel renders.
 *
 * Split out of `shared-agent-sessions-api.ts` (a grandfathered over-ceiling
 * module) by ISS-5567, which added the branch-route resolution this read now
 * owns. It is the read-side sibling of
 * `shared-agent-session-detail-projection.ts` — that module folds ALREADY-LOADED
 * rows into the DTO, this one decides what to load and in what order, so the
 * loading policy (the ISS-5407 event ceiling, the best-effort transcript and
 * branch lookups, the whole-run count recovery) lives in one place.
 */

import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import type { TranscriptAvailabilitySummary } from "@repo/api/src/types/desktop-transcripts";
import type { SharedAgentSessionDetail } from "../../shared/shared-agent-sessions-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import type { BranchDefaultEligibilitySource } from "../branch/shared-branches-default-eligibility.js";
import { resolveSessionBranchRouteId } from "./session-branch-route.js";
import {
  boundDetailEvents,
  mapDetail,
} from "./shared-agent-session-detail-projection.js";
import {
  createSessionAttributionResolverCache,
  indexSessionsById,
  mapListItem,
} from "./shared-agent-sessions-api.js";
import { coerceNonEmptyString } from "./shared-agent-sessions-query.js";

/**
 * Project one local session into the canonical detail response. A missing or
 * stale loaded row returns `null`; callers translate that into a typed 404 at
 * the IPC/fetch boundary instead of synthesizing a partial DTO from cursor data.
 */
export async function getSharedAgentSessionDetail(
  source: AgentSessionSyncSource | null | undefined,
  id: unknown,
  options?: DetailProjectionOptions
): Promise<SharedAgentSessionDetail | null> {
  if (!source) {
    return null;
  }
  const sessionId = coerceNonEmptyString(id);
  if (!sessionId) {
    return null;
  }

  const cache = createSessionAttributionResolverCache();
  // ISS-5407: bound the raw event read at the SAME ceiling the cloud detail uses,
  // reading one row past it so the projection can tell a complete stream from a
  // prefix. Without it this read — on the heap-capped db-host worker, keeping the
  // multi-KB per-event `data` blob — pulled every event row the session has.
  const loaded = await source.loadSyncedSessions([sessionId], cache, {
    eventRowCap: SESSION_DETAIL_EVENT_MAX_ROWS,
  });
  const session = indexSessionsById(loaded).get(sessionId);
  if (!session) {
    return null;
  }
  const tokenEvents = await source.loadSessionTokenEvents?.(sessionId);
  // FEA-3324 / #2977: surface a LOCAL transcript availability summary so the
  // shared session-detail panel enables `useSessionTranscript` and reads the
  // on-disk `.jsonl` (via the SSRF-safe read bridge). Resolved by external id —
  // never a renderer-supplied path. Best-effort: a lookup failure just omits the
  // summary and the panel falls back to its projected trace.
  const transcripts = await resolveLocalTranscriptSummaries(
    session.externalSessionId,
    options?.resolveLocalTranscripts
  );
  // ISS-5407: trim the loader's one-past-the-ceiling probe row back to the served
  // prefix and flag a read that hit the bound. The list-item fold gets the SAME
  // bounded set, so nothing it derives can describe a row `events` excludes.
  const { events, truncation } = boundDetailEvents(session.events);
  const bounded = { ...session, events };
  // ISS-5407 (stage review): `toolUseCount`/`toolCallsTotal`/`errorCount` render
  // as bare whole-run stats on the detail, and the SAME session's Sessions-list
  // row folds them over the FULL stream — so a prefix fold would put two
  // different claims about one session on two screens of one app. Recover them
  // from the store's own aggregate, but ONLY once the read actually hit the
  // ceiling: below the cap the loaded rows ARE the whole stream, so the extra
  // query would buy nothing on every normal detail open.
  const eventCounts = truncation.eventsTruncated
    ? await source.loadSessionEventCounts?.([sessionId])
    : undefined;
  // ISS-5567: the Branch row's destination. Resolved from the branch ARTIFACT the
  // session wrote (not the session's attribution repo), so the id addresses the
  // same branch the desktop Branches list serves; unresolvable → omitted, and the
  // shared pane keeps the row as plain text.
  // ISS-5617: the session's document links read UNBOUNDED by the sync producer's
  // ref budget, so the "Linked artifacts" row serves the complete set and can
  // state a total it can back. `bounded.artifactRefs` cannot: `loadSyncedSessions`
  // already cut it to the WIRE budget (100 non-commit refs, documents floored at
  // 50), and folding that produced a row claiming "+44" for a 60-document session.
  // Optional on the source — absent, `mapDetail` keeps the old capped fold and
  // omits the total rather than inventing one.
  const documentArtifactRefs =
    await source.loadSessionDocumentArtifactRefs?.(sessionId);
  const branchArtifactId = await resolveSessionBranchRouteId({
    source,
    eligibilitySource: options?.branchEligibilitySource,
    sessionId,
    branch: bounded.branch,
    // The repo the pane's own Repository row will show, so the link cannot open a
    // branch under a repository the row just named differently.
    displayedRepositoryFullName: bounded.attribution?.repositoryFullName,
  });
  return mapDetail({
    session: bounded,
    listItem: mapListItem(bounded),
    events,
    truncation,
    wholeRunEventCounts: eventCounts?.get(sessionId),
    tokenEvents,
    transcripts,
    ...(documentArtifactRefs ? { documentArtifactRefs } : {}),
    ...(branchArtifactId ? { branchArtifactId } : {}),
  });
}

/**
 * Options for the desktop-local detail projection. `resolveLocalTranscripts`
 * looks up the on-disk transcript availability summaries for a session's
 * HARNESS `externalSessionId` (the on-disk identity), so the detail can tell the
 * shared panel a local transcript exists and it should read it. Injected by the
 * IPC runtime (which owns the transcript-sync store + discovery); omitted in
 * tests/callers that don't need the local read path, in which case no summary is
 * surfaced.
 */
export type DetailProjectionOptions = {
  branchEligibilitySource?: BranchDefaultEligibilitySource;
  resolveLocalTranscripts?: (
    externalSessionId: string
  ) => Promise<TranscriptAvailabilitySummary[] | null>;
};

/**
 * Best-effort local transcript summary lookup. Returns `undefined` (no summary
 * surfaced) when no resolver is supplied, the lookup throws, or no local file is
 * found — so a missing/failed local read never blanks the detail; the panel then
 * renders its projected trace instead of gating on a phantom transcript.
 */
async function resolveLocalTranscriptSummaries(
  externalSessionId: string,
  resolve:
    | ((
        externalSessionId: string
      ) => Promise<TranscriptAvailabilitySummary[] | null>)
    | undefined
): Promise<TranscriptAvailabilitySummary[] | undefined> {
  if (!resolve) {
    return undefined;
  }
  try {
    const summaries = await resolve(externalSessionId);
    return summaries && summaries.length > 0 ? summaries : undefined;
  } catch {
    return undefined;
  }
}
