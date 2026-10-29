/**
 * @file transcript-route-helpers.test.ts
 * @description ISS-8599 (PRD-699 §6 item 8): the SERVER half of the transcript
 * 403 contract — an ownership miss keeps status 403 and carries a distinct
 * machine-readable code, so the desktop can classify it without the route
 * breaking every installed client by moving the status.
 *
 * ISS-11449 retired the SECOND 403 reason this file was originally a "split"
 * for, the org session-sync policy denial. The server no longer produces
 * `transcript_policy_disabled`; the desktop still ACCEPTS it, because an
 * installed client may be talking to a server that predates the removal, and
 * that half stays pinned in the desktop file named below.
 *
 * The expected code STRINGS are hand-written literals here, deliberately and
 * against the repo's usual import-the-constant rule. They are a cross-process
 * wire contract with a Desktop that ships separately: reading the expectation
 * off `TranscriptForbiddenCode` — the symbol under test — would keep this suite
 * green through a rename that silently stops matching what installed clients
 * look for. The desktop half is pinned to the same literals in
 * `apps/desktop/test/desktop-transcripts-client-forbidden-code.test.ts`, and
 * the two files are the contract.
 */
import { describe, expect, it } from "vitest";
import { transcriptErrorResponse } from "./transcript-route-helpers";
import { TranscriptSyncErrorReason } from "./transcript-sync-error-reason";

/** The wire spelling of an ownership-miss 403. Pinned, not imported — see the header. */
const WIRE_NOT_OWNED = "transcript_target_not_owned";
async function bodyOf(reason: TranscriptSyncErrorReason) {
  const response = transcriptErrorResponse(reason);
  return { status: response.status, body: await response.json() };
}

describe("transcriptErrorResponse — the ISS-8599 403 contract", () => {
  it("answers an ownership miss 403 with the NotOwned code", async () => {
    const { status, body } = await bodyOf(TranscriptSyncErrorReason.Forbidden);

    expect(status).toBe(403);
    expect(body.code).toBe(WIRE_NOT_OWNED);
  });

  // The skew rule, from the server's side. An installed Desktop that has never
  // heard of the code reads the STATUS, and moving it is what would break that
  // client — so the status staying 403 is as load-bearing as the code.
  it("keeps the ownership miss on status 403 so an uncoded client is unaffected", async () => {
    const ownership = await bodyOf(TranscriptSyncErrorReason.Forbidden);

    expect(ownership.status).toBe(403);
    expect(ownership.body.success).toBe(false);
  });

  // The `code` field is scoped to the 403 family. A reason whose classification
  // is carried by the status alone must not start emitting one — the desktop
  // reads the body for 403 only, and a code elsewhere is contract noise a future
  // widening could mistake for a signal.
  it.each([
    [TranscriptSyncErrorReason.InvalidRequest, 400],
    [TranscriptSyncErrorReason.StaleUpload, 409],
    [TranscriptSyncErrorReason.RateLimited, 429],
    [TranscriptSyncErrorReason.UpstreamUnavailable, 503],
    [TranscriptSyncErrorReason.UpstreamNotConfigured, 503],
  ])("omits `code` for %s (status %i)", async (reason, status) => {
    const result = await bodyOf(reason);

    expect(result.status).toBe(status);
    expect(result.body.code).toBeUndefined();
  });
});
