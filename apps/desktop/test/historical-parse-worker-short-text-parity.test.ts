/**
 * @file historical-parse-worker-short-text-parity.test.ts
 * @description PR #6418 review: the parse-time short-string bound must never
 * rise above the worker boundary's own cap.
 *
 * The two constants cannot live in one module. `MAX_HARNESS_SHORT_TEXT_CHARS` is
 * in `@repo/lib`, which knows nothing about the desktop worker;
 * `HistoricalParseWorkerLimits.maxShortTextLength` is in `apps/desktop`, which
 * depends on `@repo/lib` and not the reverse. So the relationship is asserted
 * from this side rather than derived, and this file is the thing that fails when
 * it drifts.
 *
 * Why it matters: the boundary schema is `.strict()`, so a single over-cap string
 * rejects the ENTIRE worker response — the source is dropped and re-dropped on
 * every retry, not merely missing a field. A parse-time bound ABOVE the boundary
 * cap would admit exactly the values that trigger that, which is the hole this
 * pairing exists to keep shut. Below is fine and merely conservative; above is
 * the defect.
 */

import assert from "node:assert/strict";
import { MAX_HARNESS_SHORT_TEXT_CHARS } from "@repo/lib/harness/parser-utils";
import { test } from "vitest";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";

test("the parse-time short-text bound cannot exceed the worker boundary cap", () => {
  assert.ok(
    MAX_HARNESS_SHORT_TEXT_CHARS <=
      HistoricalParseWorkerLimits.maxShortTextLength,
    `parse-time bound ${MAX_HARNESS_SHORT_TEXT_CHARS} exceeds the worker boundary cap ${HistoricalParseWorkerLimits.maxShortTextLength}; a value between the two would pass the parser and then reject its whole source at the .strict() boundary`
  );
});
