/**
 * ISS-12552 (PRD-800 "Proving usage"): the key that names one model
 * request, shared by the usage units a request's token events carry and the
 * tool calls it issued. Scheme-qualified, so a Claude transcript entry uuid and
 * a Codex response id can never collide.
 */
export function requestKeyFor(scheme: string, recordId: string): string {
  return `${scheme}:${recordId}`;
}
