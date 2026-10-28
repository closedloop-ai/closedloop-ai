/**
 * @file local-insights-captured-kpi-labels.test.ts
 * @description ISS-7868 — the local delivery KPIs name the population they
 * measure, because the desktop swaps producers on auth state and the cloud twin
 * measures a DIFFERENT one under the same tile id.
 *
 * These live in their own file rather than in `local-insights-contract.test.ts`
 * because that file is in the shrink-only grandfather list in `biome.jsonc` —
 * the same reason `local-insights-prose-population.test.ts` exists. They were
 * briefly asserted there (ISS-7868) and moved here when the growth gate caught
 * it; pinning them against `capturedLocKpis` directly also drops a Prisma
 * round-trip, since a label is a property of the producer rather than of any
 * particular seeded corpus.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { capturedLocKpis } from "../src/main/database/local-insights-loc.js";

const NO_DELTAS = { klocDeltaPct: null, prSizeDeltaPct: null };

test("captured LOC KPIs name their population in the LABEL", () => {
  const kpis = capturedLocKpis(
    {
      // 400 gross lines over three captured PRs, one of them un-enriched — the
      // same shape `local-insights-contract.test.ts` seeds, so the two agree on
      // what a realistic window looks like.
      totalLoc: 400,
      klocCaptured: 0.4,
      medianPrSize: 200,
      scanned: 3,
      prsWithoutKnownSize: 1,
    },
    NO_DELTAS
  );

  // The label is the only IN-CARD disclosure of which PRs these describe — the
  // population also rides `sub`, which renders behind the info tooltip. Cloud
  // sends "Median PR size" / "KLOC merged" for these same tile ids over MERGED
  // PRs, so a shared label let one card silently mean two different
  // measurements depending on whether the reader happened to be signed in.
  assert.equal(kpis.prSize.label, "Median captured PR size");
  assert.equal(kpis.kloc.label, "KLOC captured");
  // The ids stay shared on purpose — same tile, same slot, different producer.
  // That sharing is exactly what makes the label disclosure load-bearing, so if
  // these ever diverge this file is the thing to revisit.
  assert.equal(kpis.prSize.key, "pr-size");
  assert.equal(kpis.kloc.key, "kloc");
});

test("ISS-8184: the raw-line twin names the same population, on the LOC vocabulary", () => {
  // 8,987 lines, NOT a round multiple of 1,000. `klocCaptured` is rounded to one
  // decimal (9), so rewriting the producer as `klocCaptured * 1000` yields 9,000
  // and this case fails — which is the whole point of the case. A 400/0.4 pair
  // would satisfy that mutation exactly and prove nothing.
  const kpis = capturedLocKpis(
    {
      totalLoc: 8987,
      klocCaptured: 9,
      medianPrSize: 200,
      scanned: 3,
      prsWithoutKnownSize: 1,
    },
    NO_DELTAS
  );

  // Literals, not the producer's own constants: a fixture reading the label back
  // out of `capturedLocKpis` agrees with any future edit to it.
  assert.equal(kpis.loc.label, "Captured LOC");
  // Still DIFFERENT from cloud's "Merged LOC", and deliberately so — the two
  // measure different PR populations (FEA-2947), and one label would assert a
  // match nobody measured.
  assert.notEqual(kpis.loc.label, "Merged LOC");
  assert.equal(kpis.loc.key, "loc");
  // Raw lines, not the rounded thousands scaled back up.
  assert.equal(kpis.loc.value, 8987);
  assert.equal(kpis.kloc.value, 9);
  assert.notEqual(kpis.loc.value, (kpis.kloc.value as number) * 1000);
});

test("ISS-8184: an unsizable window dashes on BOTH vocabularies", () => {
  const kpis = capturedLocKpis(
    {
      totalLoc: 0,
      klocCaptured: null,
      medianPrSize: null,
      scanned: 2,
      prsWithoutKnownSize: 2,
    },
    NO_DELTAS
  );

  // A raw-line 0 here would read as a measured "no lines changed" over PRs whose
  // size is simply unknown — the conflation the null rule exists to stop, and
  // the one place the raw unit could reintroduce it.
  assert.equal(kpis.kloc.value, null);
  assert.equal(kpis.loc.value, null);
});
