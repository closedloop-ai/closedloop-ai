/**
 * ISS-12552: what the base Layer 2 snapshots are compared
 * against to show they are main's own.
 *
 * This branch regenerated `layer2-snapshots/` under the attribution policy, so
 * main's Layer 2 snapshots are no longer in the tree. `layer2-main-parity.json`
 * records them instead: for each dossier main had, one digest per table, taken
 * from main's `layer2-snapshots/` at the merge base it names, by
 * `derive-layer2-main-parity.ts`. The digest masks only the columns main's
 * store does not have (`token_events.agent_id`), so any other difference in a
 * table changes it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

export const MAIN_PARITY_MANIFEST_PATH = join(
  GOLDEN_DIR,
  "layer2-main-parity.json"
);

export const LAYER2_BASE_SNAPSHOT_DIR = join(
  GOLDEN_DIR,
  "layer2-snapshots-base"
);

/** Columns this branch's store adds and main's lacks, dropped before digesting. */
export const MAIN_PARITY_MASKED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  token_events: ["agent_id"],
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

const snapshotSchema = z.record(
  z.string(),
  z.array(z.record(z.string(), z.unknown()))
);

export type Layer2SnapshotTables = z.infer<typeof snapshotSchema>;

const manifestSchema = z.strictObject({
  mainCommit: z.string().regex(COMMIT_SHA),
  maskedColumns: z.record(z.string(), z.array(z.string())),
  dossiers: z.record(
    z.string(),
    z.record(z.string(), z.string().regex(SHA256_HEX))
  ),
});

export type MainParityManifest = z.infer<typeof manifestSchema>;

export function parseLayer2SnapshotTables(text: string): Layer2SnapshotTables {
  return snapshotSchema.parse(JSON.parse(text));
}

export function readMainParityManifest(): MainParityManifest {
  return manifestSchema.parse(
    JSON.parse(readFileSync(MAIN_PARITY_MANIFEST_PATH, "utf8"))
  );
}

/** One sha256 per table, over its rows in order with the masked columns dropped. */
export function maskedTableDigests(
  snapshot: Layer2SnapshotTables
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const [table, rows] of Object.entries(snapshot)) {
    const masked = MAIN_PARITY_MASKED_COLUMNS[table] ?? [];
    const kept = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([column]) => !masked.includes(column))
      )
    );
    digests[table] = createHash("sha256")
      .update(JSON.stringify(canonical(kept)))
      .digest("hex");
  }
  return digests;
}

/** Object keys sorted at every depth, so key order is not a difference. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, nested]) => [key, canonical(nested)])
    );
  }
  return value;
}

function compareKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
