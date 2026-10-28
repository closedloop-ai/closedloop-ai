/**
 * @file session-trace-evidence-disclosure-flag.ts
 * @description Shared key for the closed-by-default Session Trace evidence
 * disclosure (ISS-7427 part 3, under ISS-4779).
 *
 * The reported defect: a session detail page showed "216 trace events" as the
 * heading over a panel that said "Transcript not archived" and rendered zero
 * rows. Both statements were true and they described DIFFERENT POPULATIONS —
 * the count is the turn-item projection over synced Postgres event rows, the
 * panel is the parsed transcript blob — and nothing on screen said so.
 *
 * ISS-5075 already decided, correctly, that the count keeps describing the event
 * stream rather than swapping to the panel's quantity; swapping would relocate
 * the split, not close it. What that ticket did not consider is the case where
 * the panel's population is PERMANENTLY unavailable rather than merely
 * different. This gate covers the disclosure for exactly that case.
 *
 * The Session Trace header it gates mounts on BOTH surfaces through the shared
 * `AgentSessionDetailView`, so the gate must exist on both or the disclosure
 * leaks on the ungated one. Both surfaces read it as a PostHog flag — the
 * desktop renderer resolves the signed-in account's PostHog assignment from the
 * same key space `apps/app` reads — and both alias THIS constant so the two
 * strings cannot drift. It lives in `@repo/api` because that is the only
 * dependency-free module both surfaces can import.
 */
export const SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY =
  "session-trace-evidence-disclosure" as const;
