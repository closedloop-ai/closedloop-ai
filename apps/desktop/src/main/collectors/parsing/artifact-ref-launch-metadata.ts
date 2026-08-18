/**
 * @file artifact-ref-launch-metadata.ts
 * @description FEA-1684 — the artifact ref derived from
 * `.closedloop-ai/work/launch-metadata.json`.
 *
 * Split out of `artifact-ref-extractor.ts` (ISS-5236) because it is a different
 * responsibility from every pass in that file: those scan a parsed transcript,
 * this one reads a file the launcher wrote on disk, and it is called separately
 * by the importer with the resolved cwd rather than registered as a pass.
 *
 * ISS-5236: the launcher writes that file ONCE, at launch, so the ref's honest
 * `observed_at` is the session's own start — supplied by the caller via
 * `resolveSessionObservedAt`, never the wall clock of this import pass. The
 * `new Date()` floor below survives only for callers that pass nothing (tests
 * and any future non-session caller).
 *
 * WHICH callers reach this, precisely — the distinction matters because
 * `launch_metadata` is the one ref class an `EXTRACTOR_VERSION` bump cannot heal.
 * The ONLY production caller is `importSessionWithTx`
 * (`database/write-core.ts`), which passes a session-derived instant.
 * `artifact-link-backfill.ts` never calls this function AND lists
 * `LAUNCH_METADATA_REF_METHOD` in `NON_REDERIVED_LINK_METHODS`, so its
 * delete-and-rederive deliberately preserves existing launch-metadata rows —
 * which means an extractor-version sweep would leave them on their old
 * import-clock instant while re-stamping their transcript-derived siblings,
 * i.e. one session carrying mixed instants. What re-derives them for an
 * ALREADY-imported session is the `DATA_REVISION` 68 → 69 bump landed with this
 * change: that rebuild re-imports through `importSessionWithTx`, whose
 * artifact-links phase deletes every link except `commit_sha_correlation` and
 * recreates this one through the caller above.
 */

import {
  CLOSEDLOOP_SLUG_FULL_MATCH_RE,
  EXTRACTOR_VERSION,
  LAUNCH_METADATA_REF_METHOD,
} from "./artifact-ref-extractor.js";
import type { ArtifactRefRecord } from "./artifact-ref-record.js";

export function extractLaunchMetadataRefs(
  launchMetadata: { sourceArtifactId?: string } | null,
  observedAt?: string
): ArtifactRefRecord[] {
  if (!launchMetadata?.sourceArtifactId) {
    return [];
  }
  const slug = launchMetadata.sourceArtifactId;
  if (!CLOSEDLOOP_SLUG_FULL_MATCH_RE.test(slug)) {
    return [];
  }

  return [
    {
      targetKind: "closedloop_artifact",
      targetIdentity: slug,
      slug,
      relation: "input",
      method: LAUNCH_METADATA_REF_METHOD,
      confidence: "mcp_call",
      evidence: JSON.stringify({ source: "launch-metadata.json" }),
      observedAt: observedAt ?? new Date().toISOString(),
      extractorVersion: EXTRACTOR_VERSION,
      isPrimary: false,
    },
  ];
}
