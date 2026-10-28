/**
 * @file sync-conformance-fixtures.ts
 * @description The injected failure every PRD-699 Appendix A conformance lane is
 * driven with, and the request identities it is driven under.
 *
 * ONE copy of the request identities, and one copy of the failure envelope for
 * every lane. Each lane's observer builds its own client, but they must
 * all inject the SAME failure shape — a lane that quietly received a
 * differently-nested envelope would exercise a different code path while the
 * table above it still read as conformance. Split out of the suite under the
 * 1,000-line ceiling (ISS-8614).
 *
 * NOT the oracle. The `standard` column of every cell stays a hand-written
 * literal in the suite, transcribed from Appendix A; nothing here is derived
 * from anything under test.
 */

import type { Cell } from "../helpers/sync-classification-standard.js";

export const TOKEN = "session-token";
export const ORIGIN = "https://api.example.test";
export const TARGET = "target-1";
export const SESSION_ID = "session-1";
/** A code no build in this repo declares — the version-skew signal. */
export const FUTURE_ERROR_CODE = "quota_exhausted_v3";

/**
 * The failure envelope the API actually emits: `code` sits at the TOP level of
 * the body, which is where `extractApiErrorCode` reads it. Nesting it (under
 * `error`, say) makes every coded cell silently exercise the UNCODED path — the
 * first draft of the suite did exactly that, and its 403 rows passed anyway
 * because both codes are ENVIRONMENTAL. The coded-403 test is what caught it.
 */
export function failureResponse(cell: Cell): Response {
  const body = cell.code
    ? JSON.stringify({ success: false, error: "rejected", code: cell.code })
    : null;
  return new Response(body, {
    status: cell.status,
    headers: { "Content-Type": "application/json" },
  });
}
