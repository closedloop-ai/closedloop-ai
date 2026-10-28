/**
 * Max control-plane request body for `POST /desktop/transcripts/sync-plan` —
 * fingerprints + checksums only, no transcript bytes.
 *
 * Its own leaf module rather than a const in `route.ts` (ISS-8256): the cap is
 * half of a boundary contract a test has to pin — an identity over the
 * projection budget must still fit it — and a Next.js route module's export
 * surface is not a place to hang one for a test to import.
 */
export const TRANSCRIPT_SYNC_PLAN_MAX_BYTES = 8192;
