/**
 * ISS-4754 (Golden Layer 5.1) — the DECISION half of
 * `regen-golden-sync-payloads.ts`, extracted so it can be executed by a test.
 *
 * The shell keeps the parts a test cannot reach: temp SQLite, the real importer,
 * filesystem publication, and `process.exit`. That split is the bargain the
 * tooling-reach ledger asks for — a script stays exempt from the node lane
 * BECAUSE its decisions moved into a sibling that IS covered (the
 * `rehearsal-verify.ts` / `rehearsal-verify-checks.ts` and
 * `autonomy-calibration-lib.ts` entries are the precedent).
 *
 * Everything here is a pure function of its arguments: no I/O, no clock.
 */

/** The one dossier whose `normalized.json` is `null` — the empty-session DROP
 * case. Named, so a SECOND dossier failing to normalize cannot hide inside a
 * generic "skipped" bucket. */
export const KNOWN_NULL_NORMALIZED_DOSSIER_ID =
  "ses_0ffde2471ffe6DynttjfK0Yp3H";

export type ManifestEntryKind = "session" | "chunked" | "skipped";

export type ManifestEntry = {
  sessionId: string;
  kind: ManifestEntryKind;
  /** Present for `skipped` only, and only for the known null-normalized case. */
  skipReason?: string;
  /** Chunk count: 1 for `session`, `chunkCount` for `chunked`, 0 for `skipped`. */
  chunks: number;
  harness?: string;
  dataRevision?: number;
  schemaVersion?: number;
  payloadBytes?: number;
};

/**
 * The producer configuration the fixtures are frozen at. Recorded so the frozen
 * bytes are readable as "this mode", not "some mode": `prepareAgentSessionPayload`
 * takes a sizer and an activity-chunking flag that production selects from
 * NEGOTIATED server capabilities, and a different pair yields different chunk
 * boundaries. The gzip-sizer and activity-chunked variants are out of scope.
 */
export type ManifestProvenance = {
  compress: false;
  activityChunkingSupported: false;
  maxBytes: number;
  regenCommand: string;
  generatedBy: string;
};

export type SyncFixtureManifest = {
  manifestVersion: number;
  provenance: ManifestProvenance;
  entries: ManifestEntry[];
};

export const SYNC_FIXTURE_MANIFEST_VERSION = 1;

/**
 * Decide what a dossier contributes to the manifest BEFORE any expensive work.
 *
 * `null` normalized is the only tolerated skip, and only for the one id that
 * carries the DROP contract. Any other dossier that cannot be read is an ERROR:
 * a per-dossier `try/catch` that swallowed it would let the corpus silently
 * shrink, and a manifest that only has to agree with the fixture directory
 * would still reconcile against the smaller population.
 */
export function classifyDossier(dossier: {
  sessionId: string;
  normalized: unknown;
}): { kind: "syncable" } | { kind: "skipped"; reason: string } {
  const isNullNormalized =
    dossier.normalized === null || dossier.normalized === undefined;
  if (!isNullNormalized) {
    return { kind: "syncable" };
  }
  if (dossier.sessionId === KNOWN_NULL_NORMALIZED_DOSSIER_ID) {
    return {
      kind: "skipped",
      reason:
        "normalized.json is null (empty-session DROP case) — the collector emits no session, so there is nothing to sync",
    };
  }
  throw new Error(
    `${dossier.sessionId}: normalized.json is null, but the only dossier allowed to be null-normalized is ${KNOWN_NULL_NORMALIZED_DOSSIER_ID}. A newly-null dossier is a collector regression or an intake that needs its own ticket — it must not silently shrink the golden corpus.`
  );
}

/**
 * Reasons the manifest must NOT be published. Each one describes a way a green
 * run could still be worthless, mirroring `rehearsal-verify-checks.ts`'s
 * anti-vacuity screen.
 *
 * `expectedSyncable` / `expectedDossiers` come from the SIGNED
 * `corpus-expectations.yaml`, so the floor moves only when the oracle does.
 */
export function manifestSanityViolations(
  manifest: SyncFixtureManifest,
  expected: { dossiers: number; syncable: number }
): string[] {
  const violations: string[] = [];
  const syncable = manifest.entries.filter((e) => e.kind !== "skipped");
  const chunked = manifest.entries.filter((e) => e.kind === "chunked");

  if (manifest.entries.length !== expected.dossiers) {
    violations.push(
      `manifest covers ${manifest.entries.length} dossiers but the SIGNED corpus-expectations.yaml records corpus.dossiers_total=${expected.dossiers} — the corpus changed, or a dossier vanished from the run`
    );
  }
  if (syncable.length !== expected.syncable) {
    violations.push(
      `manifest holds ${syncable.length} syncable fixtures but the SIGNED corpus-expectations.yaml records corpus.sessions_imported=${expected.syncable} — Layer 5 would assert against a shrunken population`
    );
  }
  if (chunked.length === 0) {
    violations.push(
      'no fixture is kind:"chunked", so the chunk-faithful ingest path has ZERO corpus coverage. Either the production cap moved above every dossier or the chunker regressed; if the former is genuinely intended, freeze a forced-chunk variant for the largest dossiers with a lowered maxBytes rather than leaving the path uncovered'
    );
  }
  for (const entry of manifest.entries) {
    if (entry.kind === "skipped" && entry.skipReason === undefined) {
      violations.push(
        `${entry.sessionId}: skipped without a recorded reason — an unexplained skip is indistinguishable from a silent drop`
      );
    }
    if (entry.kind === "chunked" && entry.chunks < 2) {
      violations.push(
        `${entry.sessionId}: kind:"chunked" with ${entry.chunks} chunk(s) — a chunked fixture must carry at least two parts`
      );
    }
  }
  return violations;
}

/** Fixture basenames the manifest implies, for pruning orphans left by a dossier
 * that has since been removed or become null-normalized. */
export function expectedFixtureFileNames(
  manifest: SyncFixtureManifest
): string[] {
  return manifest.entries
    .filter((entry) => entry.kind !== "skipped")
    .map((entry) => `${entry.sessionId}.synced-session.json`);
}

/**
 * The basename suffix this producer OWNS. Everything it writes ends in it;
 * nothing it does not write does.
 */
export const OWNED_FIXTURE_SUFFIX = ".synced-session.json";

/**
 * Which files in the fixtures directory a publish may delete.
 *
 * Scoped to this producer's OWN output, never "every `.json` the manifest does
 * not name". The directory is shared: Layer 5.3's
 * `golden-corpus-insights.integration.test.ts` writes `corpus-insights.utc.json`
 * and `corpus-insights.chicago.json` beside these fixtures under its own writer
 * flag, and `manifest.json` is written by the staging step rather than named by
 * itself. A prune that owned the whole directory deleted both Layer 5.3
 * artifacts on every routine Layer 5.1 regen and could not recreate either.
 */
export function fixtureFilesToPrune(
  present: readonly string[],
  manifest: SyncFixtureManifest
): string[] {
  const keep = new Set(expectedFixtureFileNames(manifest));
  return present.filter(
    (name) => name.endsWith(OWNED_FIXTURE_SUFFIX) && !keep.has(name)
  );
}
