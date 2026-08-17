/**
 * PRD-538 R3 — `reconcileSessionCost` applied to the frozen golden corpus as a
 * TEST-LAYER oracle.
 *
 * PRD-538's first stated problem is that the derived cost pipeline has no
 * independent oracle: a dedup or pricing regression ships silently because our
 * reconstruction has nothing to check itself against. R1 captured Claude Code's
 * authoritative `result.total_cost_usd`; this suite is what makes it useful, by
 * running the comparison over real frozen sessions instead of hand-written
 * numbers.
 *
 * SCOPE — this is a testing-layer oracle, NOT a runtime subsystem. PRD-538
 * lists "a runtime data-truthiness reconciliation apparatus" as an explicit
 * non-goal. Nothing here is persisted, surfaced, or evaluated at runtime; it
 * only asserts against the production functions the collector already uses.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE CORPUS CAN AND CANNOT ANCHOR (measured, not assumed)
 * ─────────────────────────────────────────────────────────────────────────
 * The result envelope exists only for non-interactive `-p` stdout captures.
 * NO dossier in `packages/golden-sessions/` is such a capture — every one is a
 * persistent transcript. `findAuthoritativeTotals` proves that from the corpus
 * CONTENT (see its own note on why it does not reuse `parseHarnessResult`), so
 * the day a harness-stdout dossier is collected the claim fails loudly and
 * whoever adds it is told to wire the real `matched` arm.
 *
 * That leaves two distinct comparisons, and conflating them would be the exact
 * failure this ticket exists to prevent:
 *
 *  1. PRODUCTION reconciliation of a golden dossier is `unavailable`, always.
 *     There is no authoritative number to compare against. `unavailable` must
 *     never render as `matched` — an imported transcript that has no oracle is
 *     not a transcript that agrees with one.
 *
 *  2. The CORPUS-ANCHORED oracle is a test-only pairing that substitutes for
 *     the missing harness total: price the parser's `tokensByModel` against the
 *     SIGNED, human-verified `tokens_by_model` from each dossier's
 *     `expectations.yaml`. The signed counts are a genuine independent anchor —
 *     a human read the raw transcript to produce them, and they do not move
 *     when the parser regresses.
 *
 * HOW THIS RELATES TO THE LAYER-1 TOKEN FACTS — stated precisely, because an
 * earlier draft of this header overclaimed and review caught it. Layer 1
 * already pins BOTH sides of comparison 2 element-wise: `tokenFacts` asserts
 * each signed model's four counts, and the required `session.models_used` fact
 * compares the parser's full `tokensByModel` KEY SET against the signed list —
 * so a phantom model the parser invented is NOT a gap Layer 1 misses, and this
 * suite does not catch a token regression Layer 1 would let through. What it
 * adds is the cost-weighted view: it runs the real `reconcileSessionCost`
 * against real corpus data (PRD-538 R3's actual ask), reports drift in DOLLARS
 * rather than raw counts, and gives the three-state contract a home where the
 * `unavailable` arm is asserted over every dossier. Treat it as defense in
 * depth over a different projection of the same facts, not as unique coverage.
 *
 * What comparison 2 does NOT cover, stated plainly so nobody over-reads it:
 * a PRICING-engine regression moves both sides identically and cannot drift
 * here. Pricing is anchored elsewhere — the signed Layer-3 `cost_usd_store`
 * and `cost_conservation_by_session` literals in `corpus-expectations.yaml` are
 * frozen dollar figures compared against a live store re-priced by the same
 * engine, so a pricing change turns those red. This suite is the
 * extraction/dedup half of the oracle, not the whole of it.
 *
 * Honors `packages/golden-sessions/AGENTS.md`: strictly READ-ONLY over the
 * corpus. It never writes, regenerates, or "fixes" a fixture. A red test here
 * means the collector is wrong.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelTokenUsage } from "../../src/main/cost/token-usage.js";
import {
  ReconciliationStatus,
  reconcileSessionCost,
} from "../../src/main/cost/usage-reconciliation.js";
import { computeDerivedCostUsd } from "../../src/main/cost/usage-reconciliation-event.js";
import {
  discoverDossiers,
  type GoldenDossier,
  jsonNormalize,
  parseDossierRaw,
} from "./golden-corpus.js";
import { CORPUS_ORACLE_TOLERANCE } from "./golden-cost-oracle-tolerance.js";
import type { ParsedSessionView } from "./golden-layer1-facts.js";

/** The stream-json envelope type that carries `total_cost_usd`. */
const RESULT_RECORD_TYPE = "result";

/** Parse one JSONL line, returning null for blank or malformed lines. */
function parseJsonRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Floor on how many dossiers actually exercise the `matched` arm.
 *
 * Without this the suite has a silent-pass hole: every dossier whose signed
 * oracle prices to null takes the `unavailable` branch, which asserts nothing
 * about agreement — so a change that quietly stopped pricing most of the corpus
 * would MUTE this suite rather than fail it, and a green run would mean
 * nothing. Measured at 22 today (matching the 22 entries in the signed
 * `cost_conservation_by_session` block); a floor rather than an equality so
 * corpus intake does not gratuitously fail, but a drop below it fails loudly.
 *
 * Note on reachability: `computeDerivedCostUsd` returns null only when NO model
 * in the map prices, and the unknown-model fallback makes a total pricing
 * collapse unlikely — so the realistic trigger here is corpus composition (an
 * intake of unpriceable dossiers, or a shrinking corpus), not a pricing bug.
 * Re-measure the floor deliberately when the corpus changes; do not lower it to
 * make a red run green.
 */
export const MIN_PRICED_DOSSIERS = 22;

/**
 * The parser's per-model counts, in the shape the production pricing helper
 * takes. `cacheWrite` is the parsed view's name for `cacheCreation`.
 */
function parsedTokensByModel(
  view: ParsedSessionView
): Record<string, ModelTokenUsage> {
  const out: Record<string, ModelTokenUsage> = {};
  for (const [model, counts] of Object.entries(view.tokensByModel ?? {})) {
    out[model] = {
      input: counts.input ?? 0,
      output: counts.output ?? 0,
      cacheRead: counts.cacheRead ?? 0,
      cacheCreation: counts.cacheWrite ?? 0,
    };
  }
  return out;
}

/**
 * The SIGNED per-model counts from `expectations.yaml`, in the same shape.
 * These are the independent anchor: a human confirmed them against the raw
 * transcript, and no parser change can move them.
 */
function signedTokensByModel(
  dossier: GoldenDossier
): Record<string, ModelTokenUsage> {
  const out: Record<string, ModelTokenUsage> = {};
  for (const [model, counts] of Object.entries(
    dossier.expectations.tokens_by_model ?? {}
  )) {
    out[model] = {
      input: counts.input ?? 0,
      output: counts.output ?? 0,
      cacheRead: counts.cache_read ?? 0,
      cacheCreation: counts.cache_write ?? 0,
    };
  }
  return out;
}

/**
 * Prove from the corpus CONTENT that no dossier carries an authoritative total.
 *
 * This deliberately does NOT call the production `parseHarnessResult`. That
 * helper resolves a harness WORK DIR by filename (`claude-output.jsonl` and its
 * renamed/sidecar variants), and a golden `raw/` dir never uses those names —
 * it holds `<sessionId>.jsonl`, `rollout-*.jsonl`, or `opencode.db`. Calling it
 * here would return `null` because of the filename convention rather than
 * because the transcripts contain no result envelope, making this a tautology:
 * a harness-stdout dossier added tomorrow under the corpus naming scheme would
 * NOT trip it, and the tripwire this test exists to be would be disconnected.
 *
 * So scan the records themselves for the stream-json `result` envelope, using
 * the same shape `parseHarnessResult` keys on (`type: "result"` carrying
 * `total_cost_usd`). Corpus `raw/` files are DATA, not implementation source,
 * so reading them here is not a source scan.
 *
 * Returns the offenders AND how many records were actually examined, so the
 * caller can assert the scan did real work — an empty `found` is only evidence
 * of absence if something was read. The assertions stay inside `test()`.
 */
function findAuthoritativeTotals(dossiers: GoldenDossier[]): {
  found: string[];
  recordsScanned: number;
} {
  const found: string[] = [];
  let recordsScanned = 0;
  for (const dossier of dossiers) {
    for (const file of readdirSync(dossier.rawDir)) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const contents = readFileSync(join(dossier.rawDir, file), "utf8");
      for (const line of contents.split("\n")) {
        const record = parseJsonRecord(line);
        if (record === null) {
          continue;
        }
        recordsScanned += 1;
        if (record.type === RESULT_RECORD_TYPE) {
          found.push(
            `${dossier.sessionId}/${file}: result envelope, total_cost_usd=${String(record.total_cost_usd)}`
          );
        }
      }
    }
  }
  return { found, recordsScanned };
}

/** What the oracle needs from one dossier: both sides of the comparison. */
type DossierCostPair = {
  /** null when the collector emits no session at all (drop contract). */
  derivedCostUsd: number | null;
  /** null when no signed model could be priced, OR on a drop-contract dossier. */
  signedCostUsd: number | null;
  droppedByContract: boolean;
};

async function buildCostPair(dossier: GoldenDossier): Promise<DossierCostPair> {
  const parsed = jsonNormalize(
    await parseDossierRaw(dossier)
  ) as ParsedSessionView | null;
  if (parsed === null) {
    return {
      derivedCostUsd: null,
      signedCostUsd: null,
      droppedByContract: true,
    };
  }
  return {
    derivedCostUsd: computeDerivedCostUsd(parsedTokensByModel(parsed)),
    signedCostUsd: computeDerivedCostUsd(signedTokensByModel(dossier)),
    droppedByContract: false,
  };
}

export function registerGoldenCostOracleSuite(): void {
  const dossiers = discoverDossiers();

  // Parse the corpus ONCE and share it. The per-dossier tests and the coverage
  // floor both read this, so the floor cannot depend on node:test execution
  // order — a counter incremented by sibling tests would silently read 0 if the
  // runner ever ran the floor first.
  const costPairs = new Map<string, Promise<DossierCostPair>>(
    dossiers.map((d) => [d.sessionId, buildCostPair(d)])
  );

  function costPairFor(sessionId: string): Promise<DossierCostPair> {
    const pair = costPairs.get(sessionId);
    if (!pair) {
      // Unreachable: the map is built from the same list being iterated.
      throw new Error(`${sessionId}: missing cost pair`);
    }
    return pair;
  }

  test("golden cost oracle: corpus carries no authoritative harness total", () => {
    assert.ok(
      dossiers.length > 0,
      "no golden dossiers discovered — the oracle would vacuously pass"
    );
    const { found, recordsScanned } = findAuthoritativeTotals(dossiers);
    // Absence of evidence is only evidence of absence if the scan read
    // something. Without this the premise test degrades to a tautology the
    // moment the corpus layout changes.
    assert.ok(
      recordsScanned > 0,
      "the corpus scan examined 0 records — the premise test would pass vacuously"
    );
    assert.deepEqual(
      found,
      [],
      "a result envelope appeared in the corpus. This is good news — wire the real " +
        "`matched` arm (derived vs result.total_cost_usd) for these dossiers and update " +
        `the corpus-premise note in golden-cost-oracle.ts:\n  - ${found.join("\n  - ")}`
    );
  });

  test("golden cost oracle: unavailable never renders as matched", () => {
    // The production reconciliation of every golden dossier. There is no
    // authoritative number, so the ONLY correct answer is `unavailable` — and
    // it must be distinguishable from agreement. A `matched` here would be the
    // loading/unavailable/not-applicable/real-zero conflation: reporting that
    // an imported transcript agrees with an oracle it never had.
    for (const dossier of dossiers) {
      const result = reconcileSessionCost({
        // A plausible non-null derived cost, to prove the status is driven by
        // the MISSING authoritative side and not by an absent derived one.
        derivedCostUsd: 12.34,
        authoritativeCostUsd: null,
      });
      assert.equal(
        result.status,
        ReconciliationStatus.Unavailable,
        `${dossier.sessionId}: expected unavailable`
      );
      assert.notEqual(
        result.status,
        ReconciliationStatus.Matched,
        `${dossier.sessionId}: unavailable must never render as matched`
      );
      // No fabricated delta: an absent comparison reports nothing, not zero.
      assert.equal(result.deltaUsd, null, `${dossier.sessionId}: deltaUsd`);
      assert.equal(
        result.relativeDelta,
        null,
        `${dossier.sessionId}: relativeDelta`
      );
    }
  });

  for (const dossier of dossiers) {
    test(`golden cost oracle ${dossier.sessionId}: derived cost reconciles with the signed token oracle`, async () => {
      const { derivedCostUsd, signedCostUsd, droppedByContract } =
        await costPairFor(dossier.sessionId);
      if (droppedByContract) {
        // The collector emits no session at all, so there is nothing to price.
        // Layer 1 owns that assertion.
        return;
      }

      const result = reconcileSessionCost(
        { derivedCostUsd, authoritativeCostUsd: signedCostUsd },
        CORPUS_ORACLE_TOLERANCE
      );

      if (signedCostUsd === null) {
        // No model in the signed oracle could be priced, so the corpus offers
        // no anchor for this dossier either. Report that honestly instead of
        // claiming agreement.
        assert.equal(
          result.status,
          ReconciliationStatus.Unavailable,
          `${dossier.sessionId}: unpriced signed oracle must report unavailable, not matched`
        );
        return;
      }

      assert.equal(
        result.status,
        ReconciliationStatus.Matched,
        `${dossier.sessionId}: derived $${derivedCostUsd} vs signed-token oracle $${signedCostUsd} ` +
          `(delta $${result.deltaUsd}). A red here means the collector's token extraction, dedup, or ` +
          "per-model attribution drifted from the human-verified expectations.yaml — fix the collector, " +
          "never the golden file."
      );
    });
  }

  test("golden cost oracle: priced coverage cannot silently shrink", async () => {
    const pairs = await Promise.all(costPairs.values());
    const pricedCount = pairs.filter(
      (p) => !p.droppedByContract && p.signedCostUsd !== null
    ).length;
    assert.ok(
      pricedCount >= MIN_PRICED_DOSSIERS,
      `only ${pricedCount} dossiers exercised the matched arm (floor ${MIN_PRICED_DOSSIERS}). ` +
        "A collapse here usually means pricing started returning null, which would turn every " +
        "dossier `unavailable` and mute the oracle rather than fail it."
    );
  });

  test("golden cost oracle: a dedup regression flips matched to drifted", async () => {
    // Proves the oracle can actually FIRE. A tripwire nobody has seen trip is
    // indistinguishable from a tripwire that is not connected.
    const dossier = dossiers.find((d) => d.sessionId.startsWith("019e4b82"));
    assert.ok(dossier, "expected the 019e4b82 dossier in the corpus");

    const parsed = jsonNormalize(
      await parseDossierRaw(dossier)
    ) as ParsedSessionView | null;
    assert.ok(parsed, `${dossier.sessionId}: expected a parsed session`);

    const healthy = parsedTokensByModel(parsed);
    const signedCostUsd = computeDerivedCostUsd(signedTokensByModel(dossier));
    assert.ok(
      signedCostUsd !== null,
      `${dossier.sessionId}: expected a priced signed oracle`
    );

    assert.equal(
      reconcileSessionCost(
        {
          derivedCostUsd: computeDerivedCostUsd(healthy),
          authoritativeCostUsd: signedCostUsd,
        },
        CORPUS_ORACLE_TOLERANCE
      ).status,
      ReconciliationStatus.Matched,
      "baseline must be matched before the regression is injected"
    );

    // Inject exactly what a dedup-key regression does: one model's usage
    // record counted twice.
    const [firstModel] = Object.keys(healthy).sort();
    assert.ok(firstModel, "expected at least one priced model");
    const deduped: Record<string, ModelTokenUsage> = {
      ...healthy,
      [firstModel]: {
        input: healthy[firstModel].input * 2,
        output: healthy[firstModel].output * 2,
        cacheRead: healthy[firstModel].cacheRead * 2,
        cacheCreation: healthy[firstModel].cacheCreation * 2,
      },
    };

    const drifted = reconcileSessionCost(
      {
        derivedCostUsd: computeDerivedCostUsd(deduped),
        authoritativeCostUsd: signedCostUsd,
      },
      CORPUS_ORACLE_TOLERANCE
    );
    assert.equal(
      drifted.status,
      ReconciliationStatus.Drifted,
      "a double-counted model must drift"
    );
    assert.ok(
      drifted.deltaUsd !== null && drifted.deltaUsd > 0,
      "the drift must be reported as an overcount, with a real delta"
    );
  });
}
