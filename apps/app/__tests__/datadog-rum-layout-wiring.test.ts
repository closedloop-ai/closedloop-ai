/**
 * ISS-6383 — the root layout mounts the de-duplicating tracker, never the raw
 * vendor component.
 *
 * `datadog-rum-route-view-tracker.test.tsx` proves the tracker's behavior. It
 * cannot prove the app TAKES that behavior: it imports the tracker directly and
 * never loads the root layout, so reverting `apps/app/app/layout.tsx` to render
 * `<DatadogAppRouter />` again — the exact shipped state that produced 13,918
 * duplicate `/[orgSlug]/branches` views in 28 seconds — restores the storm with
 * a fully green suite. Root `AGENTS.md`: "A new helper needs an assertion that
 * its production caller actually invokes it."
 *
 * Read from the AST, not text-scanned: `no-raw-text-source-scan` bans scanning
 * implementation source and points at `ts.createSourceFile`. It matters beyond
 * compliance here — the layout's own docstrings name both components in prose,
 * which is exactly what a text scan false-positives on.
 *
 * The detector resolves the IMPORTED BINDING rather than a literal tag name, so
 * an aliased import cannot smuggle the vendor back in, and it is pinned by
 * synthetic fixtures in BOTH directions: a detector that regressed to
 * always-true would report this layout wired forever, and one that regressed to
 * always-false would pass the "vendor is absent" case forever. It now lives in
 * `./support/renders-imported-component` because the ISS-7442 query-cache
 * wiring suite asserts the same property about the same file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rendersImportedComponent } from "./support/renders-imported-component";

const LAYOUT_PATH = path.join(process.cwd(), "app", "layout.tsx");
const TRACKER_MODULE = "@/lib/datadog-rum/route-view-tracker";
const TRACKER_EXPORT = "DatadogRouteViewTracker";
const VENDOR_MODULE = "@datadog/browser-rum-nextjs";
const VENDOR_EXPORT = "DatadogAppRouter";

const layoutSource = readFileSync(LAYOUT_PATH, "utf8");

describe("root layout RUM view wiring", () => {
  it("renders the de-duplicating tracker", () => {
    expect(
      rendersImportedComponent(layoutSource, TRACKER_MODULE, TRACKER_EXPORT)
    ).toBe(true);
  });

  it("never renders the vendor component directly", () => {
    expect(
      rendersImportedComponent(layoutSource, VENDOR_MODULE, VENDOR_EXPORT)
    ).toBe(false);
  });
});

describe("the wiring detector itself", () => {
  const importLine = `import { ${VENDOR_EXPORT} } from "${VENDOR_MODULE}";`;

  it("reports true when the component is rendered", () => {
    const code = `${importLine}\nexport const L = () => <${VENDOR_EXPORT} />;`;
    expect(rendersImportedComponent(code, VENDOR_MODULE, VENDOR_EXPORT)).toBe(
      true
    );
  });

  it("reports false when it is imported but never rendered", () => {
    const code = `${importLine}\nexport const unused = ${VENDOR_EXPORT};`;
    expect(rendersImportedComponent(code, VENDOR_MODULE, VENDOR_EXPORT)).toBe(
      false
    );
  });

  it("resolves an aliased import rather than the literal tag name", () => {
    const code = `import { ${VENDOR_EXPORT} as Aliased } from "${VENDOR_MODULE}";\nexport const L = () => <Aliased />;`;
    expect(rendersImportedComponent(code, VENDOR_MODULE, VENDOR_EXPORT)).toBe(
      true
    );
  });
});
