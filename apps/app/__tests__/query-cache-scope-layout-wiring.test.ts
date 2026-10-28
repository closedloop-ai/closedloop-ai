/**
 * ISS-7442 — the root layout mounts the query-cache identity binding, and mounts
 * it above every query.
 *
 * `lib/__tests__/query-cache-scope-binding.test.tsx` proves the binding's
 * behavior. It cannot prove the app TAKES that behavior: it renders
 * `<QueryCacheScopeBinding />` inside its own provider and never loads the root
 * layout, so deleting the element from `app/layout.tsx` leaves all of it green
 * while nothing in production ever sets a cache scope — every query in the app
 * silently returns to one shared, organization-agnostic namespace. Root
 * `AGENTS.md`: "A new helper needs an assertion that its production caller
 * actually invokes it."
 *
 * The POSITION is asserted too, not just the presence. React renders siblings in
 * source order, so a binding moved below `AppCoreAdapterProvider` sets the new
 * identity only after that subtree has already read the cache — the beat-later
 * window the render-phase design exists to close. Presence alone would call that
 * move correct.
 *
 * Detector shared with `datadog-rum-layout-wiring.test.ts`, which pins it in
 * both directions with synthetic fixtures.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderedPositionOf } from "./support/renders-imported-component";

const LAYOUT_PATH = path.join(process.cwd(), "app", "layout.tsx");
const BINDING_MODULE = "@/lib/query-cache-scope-binding";
const BINDING_EXPORT = "QueryCacheScopeBinding";
const ADAPTERS_MODULE = "@/lib/app-core-adapters";
const ADAPTERS_EXPORT = "AppCoreAdapterProvider";

const layoutSource = readFileSync(LAYOUT_PATH, "utf8");

describe("root layout query cache identity wiring", () => {
  it("renders the cache identity binding", () => {
    expect(
      renderedPositionOf(layoutSource, BINDING_MODULE, BINDING_EXPORT)
    ).toBeDefined();
  });

  it("renders it before the app-core adapters that every query sits under", () => {
    const binding = renderedPositionOf(
      layoutSource,
      BINDING_MODULE,
      BINDING_EXPORT
    );
    const adapters = renderedPositionOf(
      layoutSource,
      ADAPTERS_MODULE,
      ADAPTERS_EXPORT
    );

    // Both resolved, so this cannot pass by one of them being absent.
    expect(binding).toBeDefined();
    expect(adapters).toBeDefined();
    expect(binding as number).toBeLessThan(adapters as number);
  });
});
