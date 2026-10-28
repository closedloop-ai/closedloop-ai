/**
 * ISS-7427 — what evidence actually backs a session-detail response, kept
 * distinct from what the response DISPLAYS. The Zod-FREE constants half.
 *
 * The detail read has two independent producers. The metadata lane
 * (`agent-sessions` sync) writes the rows every headline number is projected
 * from — `SessionDetail.estimatedCost`, the four token columns,
 * `sessionStartedAt`/`sessionEndedAt`, the event rows behind the trace count and
 * the activity tiling. The blob lane (`transcript-sync`) uploads the transcript
 * bytes. Neither gates the other, so a session whose MAIN transcript is
 * terminally absent still serves a complete set of headline numbers — they were
 * never derived from the archive.
 *
 * That is correct, and it is also indistinguishable, from the response alone,
 * from a session whose numbers are backed by a readable transcript.
 *
 * WHY THIS LIVES IN `@repo/api` AND THE FOLD DOES NOT. The audit half of this
 * ticket (#5584) put both the vocabulary and
 * `resolveSessionEvidenceCoverage` in `apps/api`, because the only consumer was
 * a server-side monitored event. Disclosing the mixed state to the reader makes
 * the verdict a WIRE value, and `apps/app` cannot import from `apps/api` — so
 * the enum moves to the one dependency-free module both surfaces can import,
 * exactly as `transcript-disposition-constants` did for `TranscriptDisposition`.
 * The FOLD stays server-side: which disposition means what is a read-path
 * decision, and shipping the switch to the client would invite a second copy.
 *
 * Zod-free and import-free on purpose (ISS-4848 precedent): the Session Trace
 * header is a bundle-sensitive `"use client"` surface that needs the enum only
 * for a comparison, and must not pull `zod` in transitively to get it.
 *
 * There is deliberately NO re-export shim on the `apps/api` fold module (Biome
 * `noBarrelFile` rejects one); every consumer imports this module directly.
 */
export const SessionEvidenceCoverage = {
  /**
   * The main transcript's archived bytes are readable (`synced` or `stale`).
   * NOT a claim of completeness — `stale` means readable but behind — only that
   * main evidence exists to reconcile the derived rows against.
   */
  MainReadable: "mainReadable",
  /**
   * The main archive is neither readable nor terminally refused. Distinct from
   * {@link SessionEvidenceCoverage.NoEvidence} because nothing here has been
   * ruled out yet.
   *
   * NOT purely a timing state, and deliberately not named as one. It inherits
   * `deriveTranscriptDisposition`'s `missing → syncing`, and a device on the
   * `metadata` sync tier never queues a transcript at all
   * (`syncTierAllowsTranscripts`), so its sessions land here permanently rather
   * than in {@link SessionEvidenceCoverage.NotApplicable}. Teaching the
   * disposition layer about consent tier is the real fix; it is a shared
   * cross-surface contract and is raised on ISS-7516 rather than forked here.
   */
  Pending: "pending",
  /**
   * The mixed cohort this ticket is about: the main archive is terminally
   * absent, AND the response still carries independently-sourced evidence
   * (synced event rows, a cost/token rollup, readable subagent transcripts, or
   * the session span the Duration row renders). The numbers are real; what no
   * consumer could previously tell is that they were never backed by the main
   * transcript.
   */
  MetadataOnly: "metadataOnly",
  /**
   * The main archive is terminally absent and EVERY independent signal is empty:
   * no trace rows, no readable subagent archive, no cost/token rollup, and no
   * session span. Read it as "nothing to reconcile against", never as a measured
   * total — every rollup column defaults to 0, so a lane that wrote nothing and
   * a lane that wrote a truthful zero are the same bytes here.
   *
   * UNREACHABLE from `findSessionDetail` today, for the same reason
   * {@link SessionEvidenceCoverage.NotApplicable} is: `SessionDetail`'s
   * `sessionStartedAt` column is non-null, so every served detail read carries
   * the session span that `SessionEvidenceInput.hasSessionSpan` reports and
   * lands in {@link SessionEvidenceCoverage.MetadataOnly} instead. Kept because
   * the fold is caller-agnostic and a caller with no span at all must still have
   * an honest verdict; the exhaustive switch would otherwise have to name a
   * state that lies.
   */
  NoEvidence: "noEvidence",
  /**
   * No transcript was ever expected, so absence carries no information.
   *
   * UNREACHABLE from `findSessionDetail` today: that path always synthesizes a
   * `missing` main summary, so `deriveTranscriptDisposition` never returns
   * `neverExpected` for it. Kept because the exhaustive switch must map that
   * disposition to something, and every other state would be a lie — the same
   * reason `transcript-availability.ts` retains the disposition itself.
   */
  NotApplicable: "notApplicable",
} as const;
export type SessionEvidenceCoverage =
  (typeof SessionEvidenceCoverage)[keyof typeof SessionEvidenceCoverage];
