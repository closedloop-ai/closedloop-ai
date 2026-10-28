import { join } from "node:path";
import {
  importsOf,
  parseSourceFileAt,
} from "@repo/app/shared/testing/source-ast";
import { describe, expect, it } from "vitest";

/**
 * ISS-5662: `session-detail-slots.ts` staying import-free is load-bearing, and
 * until now it was only a docstring.
 *
 * Three consumers depend on it and none of them fails locally when it breaks:
 *
 *  - The desktop Playwright specs (`session-detail-states.spec.ts`,
 *    `sessions-detail-route-switch.spec.ts`) load it through Node's own
 *    resolver. One extension-less workspace subpath added here and the WHOLE
 *    Electron e2e run aborts at load, before any test executes.
 *  - `route-fallbacks.tsx` is a STATIC import in the desktop shell, so anything
 *    this module pulls in lands in the eager renderer bundle — which is exactly
 *    the code split the fallbacks duplicate their geometry to preserve.
 *  - `agent-session-detail-states.tsx` is `"use client"`; a `node:`/server
 *    import reached from here would bundle into the browser.
 *
 * Vitest, `tsc`, and the vite renderer build all resolve whatever gets added,
 * so all three failures land somewhere other than the change that caused them.
 * This is the pin.
 */

const SLOTS_MODULE_PATH = join(
  import.meta.dirname,
  "..",
  "session-detail-slots.ts"
);

describe("session-detail-slots module edges (ISS-5662)", () => {
  it("declares no module edges at all, so every consumer can load it directly", () => {
    const edges = importsOf(parseSourceFileAt(SLOTS_MODULE_PATH));

    // `importsOf` covers static imports, `export … from`, dynamic `import(…)`,
    // and `require(…)`, and reports a load whose target is COMPUTED
    // (`import(moduleName)`) as an edge too — so the guard cannot be
    // sidestepped by import form or by not writing a literal. Its edge
    // contract is pinned in `shared/testing/__tests__/source-ast.test.ts`.
    expect(edges.map((edge) => edge.specifier)).toEqual([]);
  });
});
