/**
 * FEA-4001: guards the DesktopWindow default (fresh-window) size in
 * apps/desktop/src/main/window.ts.
 *
 * ISS-5068 moved the two constants out of window.ts into the electron-free leaf
 * `src/shared/window-defaults.ts`, so the VALUE half of this guard now imports
 * them directly, the strongest available mechanism, and the one AGENTS.md
 * prefers over reading source. window.ts itself still statically imports
 * `electron` and so still cannot be loaded in a plain node test; the WIRING half
 * therefore stays on the sanctioned TypeScript-compiler-API AST parse (immune to
 * formatting/comments, unlike a raw-text regex). We assert:
 *   - the default width is pinned to the proven 1400 (at and above the 1380 at
 *     which the first-launch dashboard summary-card titles — notably "Active
 *     Branches" — stay on a single line), and opens INSET on the smallest
 *     supported display (STRICTLY under 1440 logical width, not at it),
 *   - the default height is pinned to 800, the tallest fresh window that clears
 *     both pieces of macOS chrome on a 1440 × 900 Air — the menu bar AND the Dock
 *     in its default bottom position — so the bottom edge stays grabbable,
 *   - the `new BrowserWindow({ ... })` call reads that width/height from the
 *     imported constants rather than an inline literal.
 *
 * NOTE: this test deliberately does NOT re-assert the BrowserWindow security
 * config (contextIsolation/sandbox/nodeIntegration). That AST guard was
 * intentionally retired with test/agent-dashboard-boundary.test.ts (see
 * apps/desktop/AGENTS.md, "Test Practices"); FEA-4001 must not resurrect it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Node, ObjectLiteralExpression, SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import {
  CONTENT_SCROLLBAR_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  SESSIONS_CONTENT_WIDTH,
  SESSIONS_STRIP_COMPUTED_TRACK_WIDTH,
  SESSIONS_STRIP_TRACK_WIDTH,
} from "../src/shared/window-defaults.js";

// The proven fresh-window width that keeps the dashboard summary-card titles on
// a single line, and the modern-laptop logical-width ceiling it must stay under.
//
// The ceiling is asserted STRICTLY (`<`), and it must stay a different number
// from the default. #4445 review: an earlier revision widened the default to
// 1440 — the ceiling itself — which made the bound dead, because the exact-value
// `assert.equal` above it already pinned the width and a `<=` at equality can
// never fail on its own. Parking the default at the ceiling is also the thing
// the bound exists to prevent: a 1440-wide default opens flush to both edges of
// a 1440 × 900 display instead of inset.
const PROVEN_DEFAULT_WIDTH = 1400;
const LAPTOP_MAX_WIDTH = 1440;

// The tallest fresh window that clears BOTH the macOS menu bar and the default
// bottom Dock on a 1440 × 900 Air. Pinned exactly, for the same reason the width
// is: nothing else in the suite guarded the height at all, so a change to the
// vertical reasoning in `window-defaults.ts` had no test to fail (#4445 review).
const WORK_AREA_SAFE_HEIGHT = 800;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const windowSourcePath = path.resolve(testDir, "..", "src/main/window.ts");

function parseWindowSource(): SourceFile {
  return createSourceFile(
    windowSourcePath,
    readFileSync(windowSourcePath, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

function findBrowserWindowOptions(
  source: SourceFile
): ObjectLiteralExpression | undefined {
  let options: ObjectLiteralExpression | undefined;

  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "BrowserWindow" &&
      node.arguments &&
      node.arguments.length > 0 &&
      isObjectLiteralExpression(node.arguments[0])
    ) {
      options = node.arguments[0];
      return;
    }
    forEachChild(node, visit);
  };

  visit(source);
  return options;
}

function topLevelPropertyValueText(
  options: ObjectLiteralExpression,
  key: string
): string | undefined {
  for (const prop of options.properties) {
    if (
      isPropertyAssignment(prop) &&
      isIdentifier(prop.name) &&
      prop.name.text === key
    ) {
      return prop.initializer.getText();
    }
  }
  return undefined;
}

test("FEA-4001: default fresh-window size is the proven 1400 x 800, laptop-safe", () => {
  // Pin the exact proven value — a looser `> 1280` bound would pass at 1281,
  // which still reproduces the "Active Branches" title wrap (the regression).
  assert.equal(
    DEFAULT_WINDOW_WIDTH,
    PROVEN_DEFAULT_WIDTH,
    `default width must be the proven ${PROVEN_DEFAULT_WIDTH}px so the dashboard summary-card titles stay single-line (got ${DEFAULT_WINDOW_WIDTH}px)`
  );
  assert.ok(
    DEFAULT_WINDOW_WIDTH < LAPTOP_MAX_WIDTH,
    `default width must stay STRICTLY under ${LAPTOP_MAX_WIDTH}px so a fresh window opens inset on the smallest supported display rather than flush to both edges (got ${DEFAULT_WINDOW_WIDTH}px)`
  );
  assert.equal(
    DEFAULT_WINDOW_HEIGHT,
    WORK_AREA_SAFE_HEIGHT,
    `default height must be ${WORK_AREA_SAFE_HEIGHT}px — the 1440 x 900 work area left after the menu bar AND the default bottom Dock — so the window's bottom edge is not opened behind the Dock (got ${DEFAULT_WINDOW_HEIGHT}px)`
  );
});

test("FEA-4001: BrowserWindow uses the default-size constants, not literals", () => {
  const source = parseWindowSource();
  const options = findBrowserWindowOptions(source);
  assert.ok(options, "expected a new BrowserWindow({ ... }) call");

  assert.equal(
    topLevelPropertyValueText(options, "width"),
    "DEFAULT_WINDOW_WIDTH"
  );
  assert.equal(
    topLevelPropertyValueText(options, "height"),
    "DEFAULT_WINDOW_HEIGHT"
  );
});

test("#4445: the derived Sessions widths reconcile as one chain off the default", () => {
  // The repo used to carry 1079 and 1092 as unrelated constants for the SAME
  // strip at the SAME window, straddling the 1088px a fourth `auto-fit` column
  // needs, so it answered both 3-across and 4-across for the launch rank and a
  // reader could not tell which was the real track. The two are now one chain
  // with the scrollbar named, and this pins that they still differ by exactly it.
  assert.equal(
    SESSIONS_STRIP_TRACK_WIDTH,
    SESSIONS_STRIP_COMPUTED_TRACK_WIDTH - CONTENT_SCROLLBAR_WIDTH,
    "the measured strip track must be the computed one less the scrollbar — if these drift apart the 13px gap is unattributable again"
  );

  // The concrete values, pinned so a width change that forgets to re-derive the
  // `packages/app` jsdom fixtures fails HERE with the list of files to update.
  // Those fixtures cannot import this module (packages/app must not depend on
  // apps/desktop), so they carry the literals and this is the reconciliation.
  assert.deepEqual(
    {
      content: SESSIONS_CONTENT_WIDTH,
      computedTrack: SESSIONS_STRIP_COMPUTED_TRACK_WIDTH,
      measuredTrack: SESSIONS_STRIP_TRACK_WIDTH,
    },
    { content: 1128, computedTrack: 1112, measuredTrack: 1099 },
    "re-derive the desktop widths pinned in packages/app/shared/components/__tests__/summary-card-row-column-cardinality.test.tsx, packages/app/shared/hooks/__tests__/use-summary-card-columns.test.ts, packages/app/shared/components/__tests__/summary-card-row-density-tier.test.tsx and apps/desktop/src/renderer/components/sessions/__tests__/sessions-table-column-fold.test.tsx"
  );
});
