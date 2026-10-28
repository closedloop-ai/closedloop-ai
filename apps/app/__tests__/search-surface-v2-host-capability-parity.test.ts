/**
 * ISS-9414 — `SearchSurfaceV2` host capability parity, and the executable proof
 * of AC4.
 *
 * AC4 says the Web route and the Desktop command palette import the FINAL
 * surface rather than parallel result components. A test that mounts the
 * surface cannot say that: it proves the surface works, not that the product
 * reaches it. This file reads the repository instead — every production mount
 * of `SearchSurfaceV2`, discovered off the AST — and fails if that set is
 * anything other than the two hosts named below. A third host is then guarded
 * from birth, and a host that quietly stops mounting it reddens here.
 *
 * ## The one host difference this surface has, classified
 *
 * `onActivateResult` is the only optional prop, and it is `host-capability`.
 * Its absence states a fact about the shell rather than a rendering choice: a
 * page IS the destination context, so there is no container for a row's
 * activation to dismiss, while a palette must close itself — including when the
 * row's destination is the route already showing, where no navigation fires at
 * all and the link alone would leave the overlay open over its own target.
 *
 * ## What a prop's KIND means here
 *
 * {@link SEARCH_SURFACE_V2_CAPABILITY_KINDS} carries one entry. ISS-9216 AC2 is
 * why there is nothing else: a prop that changes what the user sees by being
 * omitted is REQUIRED on this surface rather than classified in this file.
 * `UnifiedSearchResults`' `onRetry` was exactly that prop — the retry
 * affordance appeared only where a host wired one, so the same failed read
 * offered a way out on `/search` and none in the mobile sheet — and it is
 * required here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SEARCH_SURFACE_V2_CAPABILITY_KINDS } from "@repo/app/search/components/search-surface-v2-capability-kinds";
import { describe, expect, it } from "vitest";
import { propsPassedToImported } from "./support/jsx-mount-props";
import {
  capabilityDrift,
  declaredOptionalProps,
  type HostCapabilityLedger,
  productionMountsOf,
  SUPPLIED,
  unledgeredMounts,
} from "./support/surface-capability-parity";

const REPO_ROOT = path.join(process.cwd(), "..", "..");
const SEARCH_ROOTS = ["apps", "packages"];
/** A full `apps` + `packages` walk; the sibling ledgers reuse the same budget. */
const REPO_WALK_TIMEOUT_MS = 60_000;

const COMPONENT_NAME = "SearchSurfaceV2";
const COMPONENT_MODULE = "@repo/app/search/components/search-surface-v2";
const COMPONENT_PATH = "packages/app/search/components/search-surface-v2.tsx";
const COMPONENT_MODULE_SUFFIX = "search-surface-v2";

const WEB_HOST_PATH =
  "apps/app/app/(authenticated)/[orgSlug]/search/components/search-results.tsx";
const DESKTOP_HOST_PATH =
  "apps/desktop/src/renderer/components/command-palette/docs-search-surface-group.tsx";

/**
 * What the web page LACKS, stated as the thing it lacks.
 *
 * Not "web does not need it" — that restates the omission. `/search` is a route
 * body: the surface occupies the page, so there is no dismissible container
 * above it for an activated row to close, and the row's own navigation is the
 * whole of what activation means there.
 */
const NO_DISMISSIBLE_CONTAINER =
  "The `/search` route body is not hosted in a dismissible container: the surface IS the page, so an activated row has nothing above it to close and the anchor's own navigation is the entire activation. The web overlay that does have one is the mobile search sheet, which is a different mount and not this host.";

const WEB_LEDGER: HostCapabilityLedger = {
  componentModule: COMPONENT_MODULE,
  componentName: COMPONENT_NAME,
  componentPath: COMPONENT_PATH,
  hostPath: WEB_HOST_PATH,
  kinds: SEARCH_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    onActivateResult: { notSupported: NO_DISMISSIBLE_CONTAINER },
  },
};

const DESKTOP_LEDGER: HostCapabilityLedger = {
  componentModule: COMPONENT_MODULE,
  componentName: COMPONENT_NAME,
  componentPath: COMPONENT_PATH,
  hostPath: DESKTOP_HOST_PATH,
  kinds: SEARCH_SURFACE_V2_CAPABILITY_KINDS,
  capabilities: {
    onActivateResult: SUPPLIED,
  },
};

const LEDGERS = [WEB_LEDGER, DESKTOP_LEDGER];

describe.each(LEDGERS)("$hostPath SearchSurfaceV2 capabilities", (ledger) => {
  const componentFile = path.join(REPO_ROOT, ledger.componentPath);
  const declaredOptional = declaredOptionalProps(
    readFileSync(componentFile, "utf8"),
    ledger.componentName,
    componentFile
  );
  const supplied = propsPassedToImported(
    readFileSync(path.join(REPO_ROOT, ledger.hostPath), "utf8"),
    ledger.componentModule,
    ledger.componentName
  );

  it("classifies every optional capability, and every claim matches the JSX", () => {
    expect(
      capabilityDrift({ declaredOptional, ledger, supplied })
    ).toStrictEqual([]);
  });

  it("reads a non-empty capability set from both sources", () => {
    expect(declaredOptional.size).toBeGreaterThan(0);
    expect(supplied.size).toBeGreaterThan(0);
    expect(Object.keys(ledger.capabilities)).toHaveLength(
      declaredOptional.size
    );
    // ISS-9218: the kind map is `satisfies`-bound to the prop TYPE; this reads
    // the same props off the AST. A prop reaching this ledger with no kind
    // would restore the old, unrestricted escape hatch.
    expect(Object.keys(ledger.kinds)).toHaveLength(declaredOptional.size);
  });
});

describe("SearchSurfaceV2 production mounts (AC4)", () => {
  it(
    "is mounted by exactly the web search route and the desktop command palette",
    () => {
      const mounts = productionMountsOf({
        exportName: COMPONENT_NAME,
        moduleSuffix: COMPONENT_MODULE_SUFFIX,
        repoRoot: REPO_ROOT,
        searchRoots: SEARCH_ROOTS,
      });

      // Written out, not counted. A length assertion passes on any two hosts,
      // including the day one of these is replaced by a parallel component
      // somewhere else — which is the exact thing AC4 forbids.
      expect([...mounts].sort()).toStrictEqual(
        [WEB_HOST_PATH, DESKTOP_HOST_PATH].sort()
      );
      expect(
        unledgeredMounts({
          componentName: COMPONENT_NAME,
          ledgers: LEDGERS,
          mounts,
        })
      ).toStrictEqual([]);
    },
    REPO_WALK_TIMEOUT_MS
  );
});
