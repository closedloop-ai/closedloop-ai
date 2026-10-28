/**
 * ISS-6891: the shared page-follower behind every complete-population read of
 * the agent-component list.
 *
 * The defect it exists to prevent is not exotic — it is taking the first page of
 * a paginated read and reducing facet counts and summary aggregates over it as
 * if it were the org. So the cases below are about EXHAUSTION and about what the
 * follower says when it could not exhaust: a producer that pages honestly, one
 * that predates `hasMore`, and one that stops short of its own `total`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "../types/agent-component.js";
import { collectComponentPopulation } from "./agent-component-population.js";

/** A population several pages deep, so a first-page read is visibly short. */
const POPULATION_SIZE = 47;
const PAGE_SIZE = 10;
/** Reachable only once the last partial page is read. */
const LAST_ID = `c-${POPULATION_SIZE - 1}`;

describe("collectComponentPopulation", () => {
  it("follows every page of an honestly paginated producer", async () => {
    const readPage = pagingProducer(POPULATION_SIZE);

    // An in-process producer: no wire `limit` ceiling, so the whole remainder
    // may be asked for at once.
    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
      maxPageSize: Number.POSITIVE_INFINITY,
    });

    // Pinned to independent literals rather than re-derived from the follower.
    expect(result.items).toHaveLength(POPULATION_SIZE);
    expect(result.total).toBe(POPULATION_SIZE);
    expect(result.hasMore).toBe(false);
    expect(result.items.at(-1)?.id).toBe(LAST_ID);
    // #6483: NOT a page walk. The short first page proves more remains; the
    // whole remainder is then read in ONE request from the base offset, so the
    // population comes from a single producer snapshot instead of five. A walk
    // would be five calls here and would stitch five snapshots together.
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage).toHaveBeenNthCalledWith(1, {
      limit: PAGE_SIZE,
      offset: 0,
    });
    expect(readPage).toHaveBeenNthCalledWith(2, {
      limit: POPULATION_SIZE,
      offset: 0,
    });
  });

  it("never asks a wire producer for a page wider than it accepts", async () => {
    // The HTTP list validator REJECTS a `limit` over the shared page bound
    // rather than clamping it, so a wide re-read there is a 400, not a big page.
    // At the ceiling the follower must page instead — and still exhaust.
    const readPage = pagingProducer(POPULATION_SIZE);

    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
      maxPageSize: PAGE_SIZE,
    });

    expect(result.items).toHaveLength(POPULATION_SIZE);
    expect(result.hasMore).toBe(false);
    for (const [page] of readPage.mock.calls) {
      expect(page.limit).toBeLessThanOrEqual(PAGE_SIZE);
    }
    // Five pages, and not a sixth spent re-reading the first at a width the
    // producer already refused to widen past.
    expect(readPage).toHaveBeenCalledTimes(5);
  });

  it("advances by the rows a clamping producer RETURNED, not the width asked for", async () => {
    // A version-skewed producer that still enforces the former 1,000-row page.
    // Advancing by the requested `limit` would jump the offset past the gap
    // between `items.length` and `limit`, permanently omitting those rows.
    const readPage = pagingProducer(POPULATION_SIZE, { clampTo: 4 });

    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
    });

    expect(result.items).toHaveLength(POPULATION_SIZE);
    expect(result.hasMore).toBe(false);
    // Every id exactly once, in population order — the gap-skipping bug shows up
    // here as missing ids, not as a short-by-one count.
    expect(result.items.map((item) => item.id)).toEqual(
      Array.from({ length: POPULATION_SIZE }, (_u, index) => `c-${index}`)
    );
  });

  it("admits a row seen in two snapshots once, and reports the set it displaced as partial", async () => {
    // The boundary shift: page 2 re-serves a row page 1 already returned (the
    // list is ordered on a column that moves), which pushes a real row out.
    // Concatenating gives an accumulated length equal to `total` — a MIXED set
    // that passes the completeness check while missing a component.
    const snapshots: AgentComponentListResponse[] = [
      { items: [component("a"), component("b")], total: 4, hasMore: true },
      { items: [component("a"), component("b")], total: 4, hasMore: true },
      { items: [component("b"), component("c")], total: 4, hasMore: false },
    ];
    // Not reached by a correct follower; a spin would surface as an empty page.
    const exhausted: AgentComponentListResponse = {
      items: [],
      total: 4,
      hasMore: false,
    };
    const readPage = vi.fn(
      (): Promise<AgentComponentListResponse> =>
        Promise.resolve(snapshots.shift() ?? exhausted)
    );

    const result = await collectComponentPopulation(readPage, { pageSize: 2 });

    expect(result.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.total).toBe(4);
    // Three of a reported four. Without the de-dupe this reads as four items and
    // `hasMore: false` — the missing component silently absent from every facet
    // count and summary aggregate reduced over it.
    expect(result.hasMore).toBe(true);
  });

  it("pages a producer that omits `hasMore`, using `total` alone", async () => {
    // `hasMore` is optional on the wire, so an older producer sends none. Reading
    // its absence as "single page" would truncate exactly the producers a
    // compatibility rule exists to keep working.
    const readPage = pagingProducer(POPULATION_SIZE, { omitHasMore: true });

    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
    });

    expect(result.items).toHaveLength(POPULATION_SIZE);
    expect(result.hasMore).toBe(false);
  });

  it("stops — and says so — when a producer contradicts its own total", async () => {
    const readPage = vi.fn(() =>
      Promise.resolve({
        items: [component("only")],
        total: 9,
        hasMore: false,
      })
    );

    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
    });

    // `hasMore: false` is believed about STOPPING — a producer that spins is
    // worse than one that returns less. But the population it handed back is not
    // the whole one, and the re-derived flag has to say that rather than echo the
    // page's own `false`.
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it("stops on an empty page even when the producer still claims more", async () => {
    const readPage = vi.fn(() =>
      Promise.resolve({ items: [], total: 500, hasMore: true })
    );

    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
    });

    // The spin guard. A producer whose `hasMore` never clears would otherwise
    // loop forever against an exhausted population.
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(true);
  });

  it("clamps a nonsensical page size and offset at BOTH ends", async () => {
    const readPage = pagingProducer(3);

    await collectComponentPopulation(readPage, { pageSize: 0, offset: -5 });

    // A zero page never advances the offset, and a negative offset asks the
    // producer for rows before the start of the population. `Math.min` alone
    // guards neither.
    expect(readPage).toHaveBeenCalledWith({ limit: 1, offset: 0 });
  });

  it("starts from the requested offset", async () => {
    const readPage = pagingProducer(POPULATION_SIZE);

    const result = await collectComponentPopulation(readPage, {
      pageSize: PAGE_SIZE,
      offset: 40,
    });

    // The tail alone: seven rows, which is under `total`, so the result reports
    // itself as partial rather than claiming to be the population.
    expect(result.items).toHaveLength(7);
    expect(result.total).toBe(POPULATION_SIZE);
    expect(result.hasMore).toBe(true);
  });
});

/** One list row, shaped enough to be counted and identified. */
function component(id: string): AgentComponent {
  return {
    id,
    slug: `skill::${id}`,
    name: id,
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 0,
    sessions: 0,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    locPerDollar: null,
    firstSeenAt: "",
    lastSeenAt: "",
  };
}

/**
 * A producer that slices its own population on the requested `limit`/`offset`.
 *
 * `clampTo` models a version-skewed producer enforcing a page narrower than the
 * one requested — it returns a SHORT page while still reporting `hasMore`.
 */
function pagingProducer(
  size: number,
  options: { omitHasMore?: boolean; clampTo?: number } = {}
) {
  const population = Array.from({ length: size }, (_unused, index) =>
    component(`c-${index}`)
  );
  return vi.fn(
    (page: {
      limit: number;
      offset: number;
    }): Promise<AgentComponentListResponse> => {
      const width = Math.min(page.limit, options.clampTo ?? page.limit);
      const items = population.slice(page.offset, page.offset + width);
      return Promise.resolve({
        items,
        total: population.length,
        ...(options.omitHasMore
          ? {}
          : { hasMore: page.offset + items.length < population.length }),
      });
    }
  );
}
