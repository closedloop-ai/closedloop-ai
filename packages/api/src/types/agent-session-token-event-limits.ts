/**
 * ISS-9857 (PRD-666, cap family TC-6): the ONE owner of the per-session
 * token-event read ceiling. Before this module the value was written out twice
 * for the same lane — `records.ts` (the detail select's nested `tokenEvents`
 * take) and `session-usage-reads.ts` (the raw per-event stream read) — and a
 * change to one would have left the other serving a different bound.
 *
 * Deliberately NOT merged with `SESSION_DETAIL_EVENT_MAX_ROWS`
 * (`agent-session-detail-limits.ts`): that lane carries per-message AND per-tool
 * rows and runs a small multiple of this one, so the two ceilings share a value
 * by coincidence, not by contract. Its own lightweight module for the same
 * reason its sibling has one — a consumer can import the number without
 * pulling in the `agent-session` type surface.
 */
export const SESSION_TOKEN_EVENT_MAX_ROWS = 10_000;
