import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

// Mock the session→PR-link DB seam so the aggregator runs without a database.
// `hasMatchingSessionPrLinks` returns true (there are links, so the function
// does not early-return) and `visitSessionDetailPages` yields an empty page —
// this test asserts the PREDICATE the scan runs over, not the accumulated
// output. `scopeToSessionsWithPrLinks` stays the REAL helper (via importActual)
// so the expectation matches exactly what production passes.
let hasLinks = true;

vi.mock("./session-pr-links", async () => {
  const actual =
    await vi.importActual<typeof import("./session-pr-links")>(
      "./session-pr-links"
    );
  return {
    ...actual,
    hasMatchingSessionPrLinks: vi.fn(() => Promise.resolve(hasLinks)),
    visitSessionDetailPages: vi.fn(
      async (
        _where: unknown,
        _select: unknown,
        visitPage: (records: never[]) => void | Promise<void>
      ) => {
        await visitPage([]);
      }
    ),
  };
});

const { aggregateSessionAttributionLenses } = await import(
  "./agent-session-attribution"
);
const { scopeToSessionsWithPrLinks, visitSessionDetailPages } = await import(
  "./session-pr-links"
);

describe("aggregateSessionAttributionLenses — scan scoping (ISS-4549)", () => {
  it("pages only PR-linked sessions, not the full matched set", async () => {
    hasLinks = true;
    const where = { userId: "user-1" } as Prisma.SessionDetailWhereInput;
    vi.mocked(visitSessionDetailPages).mockClear();

    await aggregateSessionAttributionLenses(where);

    // The paginated attribution scan must run over the PR-link-scoped `where`,
    // not the raw matched-session `where`. Output assertions can't catch a
    // regression here — an unlinked session has no PR-derived branches and is
    // dropped by the accumulator's early-return regardless — so guard the
    // predicate itself: reverting line 137 to bare `where` fails this.
    expect(vi.mocked(visitSessionDetailPages).mock.calls[0]?.[0]).toEqual(
      scopeToSessionsWithPrLinks(where)
    );
  });

  it("short-circuits before scanning when no session→PR links match", async () => {
    hasLinks = false;
    const where = { userId: "user-2" } as Prisma.SessionDetailWhereInput;
    vi.mocked(visitSessionDetailPages).mockClear();

    const lenses = await aggregateSessionAttributionLenses(where);

    expect(lenses).toEqual({ byBranch: [], byPr: [] });
    expect(vi.mocked(visitSessionDetailPages)).not.toHaveBeenCalled();
  });
});
