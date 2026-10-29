import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { effectiveParsePolicy } from "../../src/main/parse-policy/effective-parse-policy.js";
import { OutboxStatus } from "../../src/shared/sync-lane-contract.js";
import type { RawCapture } from "./golden-layer2-store-capture.js";

const snapshotSchema = z.record(
  z.string(),
  z.array(z.record(z.string(), z.unknown()))
);
const initialTemplateSchema = z
  .object({
    source_key: z.literal(AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY),
    status: z.literal(OutboxStatus.Pending),
    attempt_count: z.literal(0),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .refine((row) => row.created_at === row.updated_at);

export function readLayer2Snapshot(path: string): RawCapture {
  const frozen = snapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  for (const row of frozen.agent_component_invocation_sync_outbox ?? []) {
    if (Object.hasOwn(row, "pending_since")) {
      continue;
    }
    // ISS-10379: these pre-column snapshots contain first-enqueue templates.
    // The producer binds both columns to the same injected clock on that path.
    // Project EXPECTED data only; actual missing/null/wrong stamps still differ.
    row.pending_since = initialTemplateSchema.parse(row).created_at;
  }
  return frozen;
}

const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * ISS-12552 (PRD-800 "Rollout"): Layer 2 keeps a snapshot set per parse
 * policy. `layer2-snapshots/` is the store under the attribution policy;
 * `layer2-snapshots-base/` is the store under the base policy, which is the
 * store a Desktop with the flag off writes, revision 112's.
 */
export function layer2SnapshotDir(): string {
  return resolve(
    GOLDEN_DIR,
    effectiveParsePolicy().attributionEvidence
      ? "layer2-snapshots"
      : "layer2-snapshots-base"
  );
}

export function serializeLayer2Snapshot(snapshot: unknown): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Whether a capture matches its frozen snapshot. Under the base policy the
 * match is byte for byte: those snapshots are the parity record against
 * revision 112, so a capture that differs in a single byte fails.
 */
export function layer2SnapshotMatches(
  snapshot: unknown,
  path: string,
  frozen: RawCapture
): boolean {
  return effectiveParsePolicy().attributionEvidence
    ? isDeepStrictEqual(snapshot, frozen)
    : readFileSync(path, "utf8") === serializeLayer2Snapshot(snapshot);
}

export function layer2SnapshotPath(sessionId: string): string {
  return join(layer2SnapshotDir(), `${sessionId}.json`);
}

export function writeLayer2Snapshot(path: string, snapshot: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeLayer2Snapshot(snapshot));
}
