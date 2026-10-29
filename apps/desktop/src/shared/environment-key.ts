/**
 * @file environment-key.ts
 * @description The stable environment key derivation: an apiOrigin normalized
 * to its bare, lowercased URL origin (ISS-7096).
 *
 * Lives in `src/shared/` for the same reason `db-host-exit-error.ts` and
 * `db-host-shutdown-error.ts` do: it is pure (zero imports), and the boot graph
 * reaches it. `app.ts → desktop-sync-lane-composition.ts` needs the key
 * derivation, while `boot-no-design-system-runtime`
 * (`scripts/dependency-cruiser.config.cjs`) forbids a boot entry from
 * statically reaching ANY module under `src/main/database/`. It was extracted
 * out of `compute-target-environment-store.ts` (ISS-7240) precisely because
 * importing this one pure function from there dragged `write-queue.ts` and the
 * prisma handle onto the eager boot path — a violation the boundary gate could
 * not report while it was blind.
 */

/**
 * Normalize an apiOrigin into the stable environment key: the lowercased URL
 * origin (scheme + host + port, no path, no trailing slash). Returns `null`
 * for an unparseable value — a bad origin is recorded as nothing, never as a
 * garbage partition key (valid-or-absent, per the bad-data rule).
 */
export function normalizeEnvironmentKey(
  apiOrigin: string | null | undefined
): string | null {
  if (!apiOrigin) {
    return null;
  }
  try {
    return new URL(apiOrigin).origin.toLowerCase();
  } catch {
    return null;
  }
}
