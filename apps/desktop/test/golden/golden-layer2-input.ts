/**
 * Layer 2+ input preparation — the per-dossier deterministic clock and the
 * frozen-normalized.json → import-input loader shared by the Layer 2 write-path
 * runner (golden-layer2.ts) and the Layer 3/4 derive runners. Extracted from
 * golden-layer2.ts (grandfather shrink); behavior unchanged.
 */
import { z } from "zod";
import {
  type Harness,
  HarnessValues,
  type NormalizedSession,
} from "../../src/main/collectors/types.js";
import type { GoldenDossier } from "./golden-corpus.js";

const harnessSchema = z.enum(HarnessValues);

export type Layer2Input = {
  input: NormalizedSession;
  nowD: string;
  harness: Harness;
};

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Max ISO timestamp string anywhere in the input JSON (lexicographic works for
 * same-format ISO-8601 UTC strings, which is what every parser emits). */
function maxIsoTimestamp(value: unknown, acc: { max: string | null }): void {
  if (typeof value === "string") {
    if (ISO_TS.test(value) && (acc.max === null || value > acc.max)) {
      acc.max = value;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      maxIsoTimestamp(v, acc);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) {
      maxIsoTimestamp(v, acc);
    }
  }
}

/**
 * Per-dossier deterministic clock: 1h after the newest timestamp in the input.
 * A pure function of the input, so adding a NEW dossier to the corpus never
 * changes any EXISTING dossier's snapshot. Also guarantees the import can never
 * consider the session "recently active" (fileModifiedAt is nulled anyway).
 */
export function dossierNow(input: NormalizedSession): string {
  const acc: { max: string | null } = { max: null };
  maxIsoTimestamp(input as unknown, acc);
  const base = acc.max ?? input.startedAt ?? "2026-01-01T00:00:00.000Z";
  return new Date(Date.parse(base) + 3_600_000).toISOString();
}

/**
 * Clone the frozen normalized.json into the import input. fileModifiedAt is a
 * capture-time mtime, not a semantic fact — nulled so the import can never take
 * the RECENT_ACTIVITY_MS reactivation branch (status is deterministically
 * "completed"). The cast is sound: Layer 1 deep-equals this exact JSON against
 * the typed parser output.
 */
export function loadLayer2Input(d: GoldenDossier): Layer2Input {
  if (!d.normalized) {
    throw new Error(`${d.sessionId}: null/missing normalized.json`);
  }
  const input = JSON.parse(
    JSON.stringify(d.normalized)
  ) as unknown as NormalizedSession;
  input.fileModifiedAt = null;
  // FEA-3128: frozen normalized.json predates prLinks — supply the default so
  // the import Zod schema (.strict()) accepts it.
  if (!("prLinks" in input)) {
    (input as Record<string, unknown>).prLinks = [];
  }
  const harness = harnessSchema.safeParse(d.expectations.harness);
  if (!harness.success) {
    throw new Error(
      `${d.sessionId}: expectations.yaml harness "${String(d.expectations.harness)}" is not a valid Harness`
    );
  }
  return { input, nowD: dossierNow(input), harness: harness.data };
}
