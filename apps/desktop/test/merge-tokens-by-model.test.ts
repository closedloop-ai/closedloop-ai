/**
 * @file merge-tokens-by-model.test.ts
 * @description Behavioral coverage for
 * `src/main/collectors/engine/merge-tokens-by-model.ts` — the per-model token
 * merge that BOTH the Codex and OpenCode descendant folds call, and which had
 * no owner suite anywhere (ISS-5302).
 *
 * Split out of `codex-collector-fold.test.ts`: this is a different production
 * module from `codex-collector.ts`, and keeping it here means neither file is
 * born near the 1,000-logical-line ceiling that root `AGENTS.md` sets. Every
 * case drives the exported function directly; there is no fixture on disk.
 *
 * The branch this suite exists for is the "already present" arm — before it,
 * `mergeTokensByModel` was only ever exercised against an EMPTY target, so the
 * `existing?.x ?? 0` summing arms and the `inferred` ternary never ran.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeTokensByModel } from "../src/main/collectors/engine/merge-tokens-by-model.js";
import type { NormalizedTokenCounts } from "../src/main/collectors/types.js";
import { CODEX_FALLBACK_MODEL } from "./codex-rollout-fixture.js";

const SIBLING_MODEL = "claude-sonnet-4-5";

function counts(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  inferred?: true
): NormalizedTokenCounts {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(inferred ? { inferred } : {}),
  };
}

describe("mergeTokensByModel (the fold's shared per-model token SSOT)", () => {
  test("sums into a model key the target already carries", () => {
    const target = { [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5) };

    mergeTokensByModel(target, {
      [CODEX_FALLBACK_MODEL]: counts(7, 3, 2, 1),
    });

    assert.deepEqual(target, {
      [CODEX_FALLBACK_MODEL]: counts(107, 13, 42, 6),
    });
  });

  test("adds a model key the target does not carry yet, leaving siblings alone", () => {
    const target = { [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5) };

    mergeTokensByModel(target, { [SIBLING_MODEL]: counts(1, 2, 3, 4) });

    assert.deepEqual(target, {
      [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5),
      [SIBLING_MODEL]: counts(1, 2, 3, 4),
    });
  });

  test("keeps `inferred` when only the target's existing entry carried it", () => {
    const target = { [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5, true) };

    mergeTokensByModel(target, {
      [CODEX_FALLBACK_MODEL]: counts(10, 1, 4, 0),
    });

    assert.deepEqual(
      target[CODEX_FALLBACK_MODEL],
      counts(110, 11, 44, 5, true)
    );
  });

  test("sets `inferred` when only the incoming source carries it", () => {
    const target = { [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5) };

    mergeTokensByModel(target, {
      [CODEX_FALLBACK_MODEL]: counts(10, 1, 4, 0, true),
    });

    assert.deepEqual(
      target[CODEX_FALLBACK_MODEL],
      counts(110, 11, 44, 5, true)
    );
  });

  test("omits `inferred` entirely when neither side carries it", () => {
    const target = { [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5) };

    mergeTokensByModel(target, {
      [CODEX_FALLBACK_MODEL]: counts(10, 1, 4, 0),
    });

    // Absent, not `inferred: false` — a false flag would round-trip through the
    // sync payload as a real (wrong) attribution signal.
    assert.equal(
      Object.hasOwn(target[CODEX_FALLBACK_MODEL], "inferred"),
      false
    );
  });

  test("does not mutate the source record", () => {
    const target = { [CODEX_FALLBACK_MODEL]: counts(100, 10, 40, 5) };
    const source = { [CODEX_FALLBACK_MODEL]: counts(10, 1, 4, 0, true) };

    mergeTokensByModel(target, source);

    assert.deepEqual(source, {
      [CODEX_FALLBACK_MODEL]: counts(10, 1, 4, 0, true),
    });
  });
});
