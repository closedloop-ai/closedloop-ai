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
import { describe, test } from "vitest";
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

/**
 * ISS-8565. Two arms, because they kill different mutations.
 *
 * The absent-key case kills reverting the write to `target[model] = ...`.
 * The inherited-bucket case is the ONLY one that kills deleting the
 * `Object.hasOwn` READ guard: without it `target["__proto__"]` reads back
 * `Object.prototype`, and the child's spend is summed onto whatever that
 * inherited object happens to expose instead of onto zero.
 *
 * The child fixture is built with `Object.create(null)`, not a literal: a
 * quoted `"__proto__"` key in an object LITERAL is the prototype-setter form
 * and creates no own key, so the fixture itself would drop it and the test
 * would prove nothing.
 */
describe("mergeTokensByModel: a model named __proto__ (ISS-8565)", () => {
  test("adds a __proto__ model the target does not carry yet", () => {
    const target: Record<string, NormalizedTokenCounts> = {
      [SIBLING_MODEL]: counts(100, 10, 40, 5),
    };
    const source: Record<string, NormalizedTokenCounts> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    source.__proto__ = counts(7, 3, 2, 1);

    mergeTokensByModel(target, source);

    assert.ok(Object.keys(target).includes("__proto__"));
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.deepEqual(target.__proto__, counts(7, 3, 2, 1));
    assert.deepEqual(target[SIBLING_MODEL], counts(100, 10, 40, 5));
    assert.equal(Object.getPrototypeOf(target), Object.prototype);
  });

  test("sums onto an OWN __proto__ bucket the target already carries", () => {
    const target: Record<string, NormalizedTokenCounts> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    target.__proto__ = counts(100, 10, 40, 5);
    const source: Record<string, NormalizedTokenCounts> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    source.__proto__ = counts(7, 3, 2, 1);

    mergeTokensByModel(target, source);

    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.deepEqual(target.__proto__, counts(107, 13, 42, 6));
  });

  test("defines the key on a PLAIN-LITERAL caller target", () => {
    // The load-bearing half for this shape. `target` here is a plain `{}` — the
    // exact object `opencode-subagent-fold.ts` hands in — so a bare
    // `target[model] = ...` would hit the inherited `__proto__` setter and
    // create no own key. Only the `defineProperty` write survives this.
    //
    // The sibling `Object.hasOwn` READ guard is idiom-consistent defence
    // (ISS-8234/8235) but is NOT pinned here and is not claimed to be: on
    // `Object.prototype` the `existing?.input ?? 0` chain already yields 0, so
    // no reachable input distinguishes the guarded read from the bare one.
    const target: Record<string, NormalizedTokenCounts> = {};
    const source: Record<string, NormalizedTokenCounts> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    source.__proto__ = counts(7, 3, 2, 1);

    mergeTokensByModel(target, source);

    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.deepEqual(target.__proto__, counts(7, 3, 2, 1));
    assert.ok(Object.hasOwn(target, "__proto__"));
  });
});
