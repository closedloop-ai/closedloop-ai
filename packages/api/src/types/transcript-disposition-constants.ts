/**
 * FEA-3479 (PRD-536 G1) — session-level transcript disposition, the Zod-FREE
 * constants half.
 *
 * ISS-4848: the const-object enum and its union type live
 * here so bundle-sensitive client surfaces that only need the enum for a
 * comparison or a render — the Sessions sync-state fold
 * (`session-status-fold.ts`), `SessionStatusBadge`, `CloudSyncStateBadge`, and
 * the dashboard/insights/telemetry embeds that mount `SyncedSessionsTable` — do
 * NOT pull `zod` in transitively. The sibling `desktop-transcripts` module owns
 * the Zod boundary schemas and no longer holds this enum at all.
 *
 * There is deliberately NO re-export shim on `desktop-transcripts` (Biome
 * `noBarrelFile` rejects one, which is why the sibling
 * `agent-session-cloud-sync-state-constants` split has none either), so every
 * consumer imports this module directly — including the web e2e specs under
 * `e2e/`, which are compiled by Playwright's own loader and therefore surface a
 * missed repoint as a runtime ESM error rather than a type error. Mirrors that
 * split (codex #3449 review).
 *
 * The per-file {@link TranscriptAvailability} states describe one transcript
 * file; this collapses them into a single, UI-facing verdict for a whole
 * session so a lag-aware client (FEA-2733 / PLN-1138 read path) can render one
 * of:
 *   - `synced`         — the main transcript is uploaded and current.
 *   - `stale`          — uploaded, but the desktop has since reported a newer
 *                        fingerprint; the archived bytes are readable but behind.
 *   - `syncing`        — a transcript is expected and an upload is in flight or
 *                        not yet started (the normal "transcript uploading" case,
 *                        NOT an error — clients should show a benign progress
 *                        affordance, not a failure).
 *   - `failedTransient`— the last upload attempt failed but is expected to be
 *                        retried; distinct from `failedPermanent` so the UI does
 *                        not present a retryable hiccup as a dead end.
 *   - `failedPermanent`— the upload failed and will not be retried; the
 *                        transcript is never coming. Fully realized by FEA-3476
 *                        (deferred, product-gated). The contract/enum ships now;
 *                        until the desktop emits a permanent-failure signal, the
 *                        server maps a `uploadFailed` file conservatively to
 *                        `failedTransient`, never `failedPermanent`.
 *   - `neverExpected`  — this session is not expected to have a transcript at
 *                        all (e.g. a synthetic/loop-only session); absence is
 *                        normal and clients should show nothing rather than a
 *                        "syncing"/"missing" affordance.
 *
 * This is a strict superset of the information in the per-file availability
 * vocabulary (it does not duplicate it): the derivation folds the per-file
 * availability states plus session context into these session-scoped verdicts.
 * Additive + optional on the detail response — older clients that ignore it fall
 * back to reading the `transcripts[]` availability array they already consume.
 */
export const TranscriptDisposition = {
  Synced: "synced",
  Stale: "stale",
  Syncing: "syncing",
  FailedTransient: "failedTransient",
  FailedPermanent: "failedPermanent",
  NeverExpected: "neverExpected",
} as const;
export type TranscriptDisposition =
  (typeof TranscriptDisposition)[keyof typeof TranscriptDisposition];
