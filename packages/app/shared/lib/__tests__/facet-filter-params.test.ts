import { afterEach, describe, expect, test } from "vitest";
import {
  type FacetFilterParamMap,
  initialFacetParamsSource,
  parseFacetFilterParams,
  writeFacetFilterParams,
} from "../facet-filter-params";

/**
 * Codec coverage for the FEA-3560 facet↔URL mirroring: list surfaces write the
 * active facet selections into the list URL and re-seed from it on mount, so a
 * detail→back (or reload / shared link) restores the filtered view.
 */

type TestFilters = {
  statuses: string[];
  owners: string[];
};

const DEFAULTS: TestFilters = { statuses: [], owners: [] };

const PARAM_MAP: FacetFilterParamMap<TestFilters> = {
  statuses: "status",
  owners: "owner",
};

describe("writeFacetFilterParams", () => {
  test("writes one repeated param per selected value and preserves unrelated params", () => {
    const params = new URLSearchParams("page=3&search=fix");

    writeFacetFilterParams(
      params,
      { statuses: ["open", "merged"], owners: ["alex"] },
      PARAM_MAP
    );

    expect(params.getAll("status")).toEqual(["open", "merged"]);
    expect(params.getAll("owner")).toEqual(["alex"]);
    // Unrelated params (page, search) pass through untouched.
    expect(params.get("page")).toBe("3");
    expect(params.get("search")).toBe("fix");
  });

  test("replaces previous values and deletes params for cleared facets", () => {
    const params = new URLSearchParams(
      "status=open&status=merged&owner=alex&page=2"
    );

    writeFacetFilterParams(
      params,
      { statuses: ["closed"], owners: [] },
      PARAM_MAP
    );

    expect(params.getAll("status")).toEqual(["closed"]);
    // Cleared facet leaves no param behind — default state keeps a clean URL.
    expect(params.has("owner")).toBe(false);
    expect(params.get("page")).toBe("2");
  });
});

describe("parseFacetFilterParams", () => {
  test("round-trips what writeFacetFilterParams wrote", () => {
    const filters: TestFilters = {
      statuses: ["open", "merged"],
      owners: ["acme/web team"],
    };
    const params = new URLSearchParams();
    writeFacetFilterParams(params, filters, PARAM_MAP);

    // Serialize → reparse, as a real navigation round-trip would.
    const reparsed = parseFacetFilterParams(
      new URLSearchParams(params.toString()),
      DEFAULTS,
      PARAM_MAP
    );

    expect(reparsed).toEqual(filters);
  });

  test("returns the defaults object itself when no facet param is present", () => {
    const parsed = parseFacetFilterParams(
      new URLSearchParams("page=4&search=x"),
      DEFAULTS,
      PARAM_MAP
    );

    // Referential equality — callers rely on "nothing to restore" being cheap
    // to detect and on default-state no-change checks staying stable.
    expect(parsed).toBe(DEFAULTS);
  });

  test("keeps per-facet defaults for facets without params", () => {
    const parsed = parseFacetFilterParams(
      new URLSearchParams("status=open"),
      DEFAULTS,
      PARAM_MAP
    );

    expect(parsed).toEqual({ statuses: ["open"], owners: [] });
    expect(parsed).not.toBe(DEFAULTS);
  });

  test("drops empty and duplicate values", () => {
    const parsed = parseFacetFilterParams(
      new URLSearchParams("status=&status=open&status=open"),
      DEFAULTS,
      PARAM_MAP
    );

    expect(parsed).toEqual({ statuses: ["open"], owners: [] });
  });
});

describe("initialFacetParamsSource", () => {
  afterEach(() => {
    globalThis.history.replaceState(null, "", "/");
  });

  test("prefers a populated snapshot over the browser URL", () => {
    globalThis.history.replaceState(null, "", "/sessions?status=merged");
    const snapshot = new URLSearchParams("status=open");

    expect(initialFacetParamsSource(snapshot)).toBe(snapshot);
  });

  test("falls back to the browser URL when the snapshot is still empty", () => {
    // Reload/deep-link on the web App Router: the first client render can see
    // an empty search-params snapshot while the browser URL has the filters.
    globalThis.history.replaceState(null, "", "/sessions?status=open&owner=a");
    const source = initialFacetParamsSource(new URLSearchParams());

    expect(source.getAll("status")).toEqual(["open"]);
    expect(source.getAll("owner")).toEqual(["a"]);
  });

  test("returns the empty snapshot itself when the browser URL has no query", () => {
    const snapshot = new URLSearchParams();

    expect(initialFacetParamsSource(snapshot)).toBe(snapshot);
  });
});
