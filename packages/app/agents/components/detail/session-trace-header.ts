import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { TRACE_EVENTS_TRUNCATED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";

/**
 * ISS-5075: count caption for the Session trace header, honest about truncation.
 *
 * The count keeps counting exactly what it always has: the session's own
 * DB-derived trace projection (`turnItems`, falling back to the raw `events`).
 * That is NOT always the set the panel below paints. On the web a parsed cloud
 * transcript is the sole trace source when it has content
 * (`session-transcript-panel.tsx`), and it is read whole, so the header number
 * and the rows can already describe two different projections. Swapping in a
 * different quantity here would relocate that split rather than close it, so
 * this stays a caption about the session's event stream.
 *
 * The qualifier therefore has to describe THE COUNT's population, and logical-QA
 * review caught it describing the panel's instead: gating it on what the panel
 * painted meant that on the primary web path — an archived transcript, so the
 * rendered source is never the capped projection — a session past the cap
 * printed `10,000 events` with no disclosure at all, which is the one thing an
 * uncapped read never did. `eventsTruncated` describes the DB event stream, and
 * that stream is exactly what this number counts, so the flag alone is the
 * gate. It says so in the same words the Activity phases panel on this screen
 * uses for the same condition ("later phases truncated") rather than a
 * "(partial)" a reader cannot tell apart from "still loading".
 *
 * The end-of-trace note in `session-transcript-panel.tsx` is the other case and
 * keeps its render-source gate: that one claims something about the ROWS, so
 * stamping it over a whole parsed transcript would be the same lie pointed the
 * other way.
 *
 * ISS-7427 adds a SECOND, independent qualifier on the same principle, for the
 * case ISS-5075 did not consider: the panel's population being PERMANENTLY
 * unavailable rather than merely different. When the server classifies the
 * response `metadataOnly` — main transcript terminally absent, independent
 * evidence still served — saying where the count came from is what stops "216
 * events" reading as a description of the empty panel below it. The two notes
 * are orthogonal and compose: truncation is about whether the count is
 * COMPLETE, evidence is about WHICH set it counted.
 *
 * The note claims only the COUNT's provenance, deliberately, and that is what
 * keeps it true on desktop. `metadataOnly` describes the CLOUD archive, but a
 * desktop Cloud-mode session whose local `.jsonl` outlived that archive paints a
 * full transcript from the local fallback — so "the panel is empty" would be a
 * web-only truth and this note must not assert it. The panel says its own piece
 * ("Showing your local copy…") and the two compose.
 *
 * Gated on `options.discloseEvidence` rather than read from a hook here, because
 * this module is a pure formatter shared by both surfaces; the caller owns the
 * flag. An absent/false option and an absent `evidenceCoverage` both mean say
 * nothing — never assume main is readable (see the wire field's contract).
 */
export function getTraceCountLabel(
  session: AgentSessionDetail,
  options?: { discloseEvidence?: boolean }
): string {
  const rowCount = session.turnItems?.length ?? session.events.length;
  const count = `${rowCount.toLocaleString()} ${rowCount === 1 ? "event" : "events"}`;
  const notes: string[] = [];
  if (session.eventsTruncated === true) {
    notes.push(TRACE_EVENTS_TRUNCATED_NOTE);
  }
  if (
    options?.discloseEvidence === true &&
    session.evidenceCoverage === SessionEvidenceCoverage.MetadataOnly
  ) {
    notes.push(TRACE_COUNT_METADATA_ONLY_NOTE);
  }
  return notes.length === 0 ? count : `${count} · ${notes.join(" · ")}`;
}

/**
 * ISS-7427: what the count says about ITSELF when the main transcript is
 * terminally absent.
 *
 * PROPOSED WORDING — the operator owns the final string. The constraint the
 * wording has to satisfy is fixed even if the words change: it must name the
 * count's own population, because the contradiction the reporter saw is two
 * populations under one heading, not a wrong number. Both statements on that
 * screen were true — "216 trace events" counts synced activity rows, "Transcript
 * not archived" describes the parsed transcript — and nothing said they were
 * different things.
 *
 * It does NOT repeat "transcript not archived": the panel directly beneath
 * already says that, and restating it here would make the heading a second
 * announcement of the panel's state rather than a statement about the count.
 *
 * Vocabulary follows `trace-truncation-copy`: a terse fragment, middot-joined,
 * no em dash, and no internal name for a read limit or a sync lane.
 */
export const TRACE_COUNT_METADATA_ONLY_NOTE =
  "counted from synced activity, not the transcript";

export const SESSION_TRACE_HEADING_ID = "session-trace-heading";
