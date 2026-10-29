/**
 * FEA-2647 Layer 2 — raw store capture, and the legality guard over what it
 * captures.
 *
 * Lives beside `golden-layer2.ts` rather than in it, following the sibling
 * pattern of `golden-layer2-cell-normalization.ts` and
 * `golden-layer2-agent-ids.ts`: the runner is at the file-size ceiling and is
 * SHRINK-ONLY in `biome.jsonc`.
 *
 * ISS-7839: `assertLegalBillingModes` exists because nothing used to compare
 * the captured `sessions.billing_mode` against the `BillingMode` union. The
 * seeder injected `"metered_api"` — a value no production path can emit — and
 * `captureRawStores` froze it verbatim into all 27 snapshots, where it read as
 * "metered" while every consumer normalized it to `"unknown"`. The suite stayed
 * green for months: the snapshots agreed with each other, and the per-dossier
 * oracle deliberately does not carry billing facts. Checking the column here,
 * at the seam that writes the snapshot, is what makes that class of fixture bug
 * loud instead of silent.
 */
import { normalizeBillingMode } from "../../src/shared/billing-mode.js";

/**
 * Every table the importer writes (write-core.ts import phases 1-8). The six
 * stores named by FEA-2647 additionally get fact-level assertions; the rest are
 * snapshot-covered drift detectors (no signed dossier keys exist for them).
 */
export const SNAPSHOT_TABLES = [
  "sessions",
  "agents",
  "events",
  "token_usage",
  "token_events",
  "session_analytics",
  "session_turn_bucket",
  "session_activity_segments",
  "session_artifact_links",
  "artifacts",
  "pull_requests",
  "agent_component_invocations",
  "agent_component_invocation_sync_outbox",
  "agent_component_invocation_sync_cursors",
  "agent_component_session_usage",
  "agent_components",
  "agent_component_versions",
] as const;

export type RawCapture = Record<string, Record<string, unknown>[]>;

/** The minimum shape `captureRawStores` needs — a raw-SQL escape hatch. */
type RawQueryable = {
  prisma: { client: { $queryRawUnsafe: <T>(sql: string) => Promise<T> } };
};

/**
 * Assert every captured session row carries a real `BillingMode`.
 *
 * Membership is decided by `normalizeBillingMode`, the canonical exported
 * predicate, rather than by re-deriving `BILLING_MODES.includes(...)` here: a
 * value is legal exactly when normalizing it is a no-op. That reuse also gets
 * `null` rejection for free (`normalizeBillingMode(null)` is `"unknown"`, which
 * is not `null`), with no cast.
 *
 * An EMPTY row set is not an error — several Layer 2 fixtures legitimately
 * capture a store with no `sessions` row, and the runner already branches on
 * that. Only a present-but-illegal value throws.
 */
export function assertLegalBillingModes(
  rows: readonly Record<string, unknown>[]
): void {
  for (const row of rows) {
    const mode = row.billing_mode;
    if (normalizeBillingMode(mode) !== mode) {
      throw new Error(
        `sessions.billing_mode ${JSON.stringify(mode)} is not a BillingMode (session ${String(row.id)}). A golden fixture must never seed a value production cannot emit — see ISS-7839.`
      );
    }
  }
}

/** Capture every snapshot table verbatim, guarding the session rows' legality. */
export async function captureRawStores(db: RawQueryable): Promise<RawCapture> {
  const out: RawCapture = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = await db.prisma.client.$queryRawUnsafe<
      Record<string, unknown>[]
    >(`SELECT * FROM ${table}`);
  }
  assertLegalBillingModes(out.sessions ?? []);
  return out;
}
