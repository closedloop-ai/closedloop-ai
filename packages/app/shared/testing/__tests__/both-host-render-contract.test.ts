/**
 * ISS-9544 — the harness's own counterfactual.
 *
 * A both-host harness that cannot fail is the defect it exists to prevent, so
 * every branch that decides "this shell is fine" is driven here against a
 * synthetic host rather than only against whatever the two real shells happen
 * to render today.
 *
 * The expected sentences are written out by hand rather than composed from the
 * module under test: a fixture that built them from the same template could not
 * fail when the message stops naming the host, the surface, or the case, and
 * the message IS the whole product of a failed run.
 */

import {
  type BothHostRenderContract,
  caseOutcomeProblem,
  contractShapeProblems,
  DESKTOP_HOST,
  foundOrAbsent,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import { describe, expect, it, vi } from "vitest";

type Fixture = { readonly rows: number };

const FIXTURE: Fixture = { rows: 2 };
const SURFACE = "Widgets list";
const ABSENT = "Unable to find an element with the text: Widget A";

function contractOf(
  ...cases: BothHostRenderContract<Fixture>["cases"]
): BothHostRenderContract<Fixture> {
  return { cases, surface: SURFACE };
}

/** A case whose shared state this host does render. */
const RENDERED = {
  fixture: FIXTURE,
  name: "lists every widget",
  renderProblem: () => Promise.resolve(undefined),
} as const;

/** The same case against a shell that does not render it. */
const MISSING = {
  fixture: FIXTURE,
  name: "lists every widget",
  renderProblem: () => Promise.resolve(ABSENT),
} as const;

const FOUND = "Unable to find an element with the text: Widget A";
const AMBIGUOUS = "Found multiple elements with the role region";

const noopMount = () => {
  // The synthetic host renders nothing; each case decides its own outcome.
};

describe("caseOutcomeProblem", () => {
  it("passes a host that renders the shared state", async () => {
    expect(
      await caseOutcomeProblem({
        contract: contractOf(RENDERED),
        host: WEB_HOST,
        mount: noopMount,
        testCase: RENDERED,
      })
    ).toBeUndefined();
  });

  it("names the host, the surface and the failure when a shell does not render it", async () => {
    expect(
      await caseOutcomeProblem({
        contract: contractOf(MISSING),
        host: DESKTOP_HOST,
        mount: noopMount,
        testCase: MISSING,
      })
    ).toBe(
      'Widgets list: desktop does not render "lists every widget" from the shared fixture, and no divergence entry says it cannot — Unable to find an element with the text: Widget A'
    );
  });

  it("accepts a divergence the mounted DOM actually shows", async () => {
    expect(
      await caseOutcomeProblem({
        contract: contractOf(MISSING),
        host: DESKTOP_HOST,
        mount: noopMount,
        testCase: {
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
        },
      })
    ).toBeUndefined();
  });

  // The claim expires on its own. Without this the ledger would be free text
  // again: a shell could start rendering the state and keep the excuse forever.
  it("rejects a divergence claim the host has stopped needing", async () => {
    expect(
      await caseOutcomeProblem({
        contract: contractOf(RENDERED),
        host: DESKTOP_HOST,
        mount: noopMount,
        testCase: {
          ...RENDERED,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
        },
      })
    ).toBe(
      'Widgets list: case "lists every widget" claims desktop diverges ("no org in this shell\'s path"), but desktop renders it. Drop the divergence entry — a claim nothing checks is how two shells drift apart behind a green suite.'
    );
  });

  it("reads a divergence entry per host, not per case", async () => {
    expect(
      await caseOutcomeProblem({
        contract: contractOf(MISSING),
        host: WEB_HOST,
        mount: noopMount,
        testCase: {
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
        },
      })
    ).toBe(
      'Widgets list: web does not render "lists every widget" from the shared fixture, and no divergence entry says it cannot — Unable to find an element with the text: Widget A'
    );
  });

  // A shell whose provider stack has rotted throws from the mount, and a
  // divergence entry must not launder that into "this shell is excused".
  it("lets a broken mount throw instead of satisfying a divergence claim", async () => {
    await expect(
      caseOutcomeProblem({
        contract: contractOf(MISSING),
        host: DESKTOP_HOST,
        mount: () => {
          throw new Error("no QueryClient set");
        },
        testCase: {
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
        },
      })
    ).rejects.toThrow("no QueryClient set");
  });

  // Same laundering risk one step later: a reader that blew up mid-query is not
  // evidence that this shell legitimately withholds the state.
  it("lets a thrown reader escape instead of satisfying a divergence claim", async () => {
    await expect(
      caseOutcomeProblem({
        contract: contractOf(MISSING),
        host: DESKTOP_HOST,
        mount: noopMount,
        testCase: {
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
          renderProblem: () => Promise.reject(new Error("jsdom torn down")),
        },
      })
    ).rejects.toThrow("jsdom torn down");
  });

  // The ORDER is the contract, not merely that both ran: a reader that runs
  // first sees whatever the previous case left in `document.body`, so every
  // case would assert against a stale or empty DOM and the whole harness would
  // report on the wrong render.
  it("mounts the fixture before reading the host's DOM", async () => {
    const mount = vi.fn();
    const renderProblem = vi.fn(() => Promise.resolve(undefined));
    await caseOutcomeProblem({
      contract: contractOf({ ...RENDERED, renderProblem }),
      host: WEB_HOST,
      mount,
      testCase: { ...RENDERED, renderProblem },
    });
    expect(mount).toHaveBeenCalledWith(FIXTURE);
    expect(mount.mock.invocationCallOrder[0]).toBeLessThan(
      renderProblem.mock.invocationCallOrder[0]
    );
  });

  // Without this the reader could assert over a module constant while a
  // different fixture was mounted — green today, silently wrong on the first
  // case that does not share the default fixture.
  it("hands the reader the fixture that was mounted", async () => {
    const renderProblem = vi.fn(() => Promise.resolve(undefined));
    const other: Fixture = { rows: 9 };
    await caseOutcomeProblem({
      contract: contractOf(RENDERED),
      host: WEB_HOST,
      mount: noopMount,
      testCase: { ...RENDERED, fixture: other, renderProblem },
    });
    expect(renderProblem).toHaveBeenCalledWith(other);
  });
});

describe("foundOrAbsent", () => {
  it("reports a genuinely absent element as absent", async () => {
    expect(
      await foundOrAbsent(() => Promise.reject(new Error(FOUND)))
    ).toBeUndefined();
  });

  // The laundering guard: an ambiguous match is a regression, not an absence,
  // and swallowing it here would satisfy a divergence entry with it.
  it("rethrows an ambiguous match instead of calling it absent", async () => {
    await expect(
      foundOrAbsent(() => Promise.reject(new Error(AMBIGUOUS)))
    ).rejects.toThrow(AMBIGUOUS);
  });

  it("returns what the query found", async () => {
    expect(
      await foundOrAbsent(() => Promise.resolve(["a", "b"]))
    ).toStrictEqual(["a", "b"]);
  });
});

describe("contractShapeProblems", () => {
  it("accepts a contract with a state both shells owe the reader", () => {
    expect(
      contractShapeProblems({ contract: contractOf(RENDERED), host: WEB_HOST })
    ).toStrictEqual([]);
  });

  it("refuses a contract with no case", () => {
    expect(
      contractShapeProblems({ contract: contractOf(), host: WEB_HOST })
    ).toStrictEqual([
      "Widgets list: the both-host contract carries no case, so mounting web asserts nothing about it.",
    ]);
  });

  // Otherwise a shell could be excused case by case until the suite only ever
  // asserted that it renders nothing.
  it("refuses a host every case excuses", () => {
    expect(
      contractShapeProblems({
        contract: contractOf({
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
        }),
        host: DESKTOP_HOST,
      })
    ).toStrictEqual([
      "Widgets list: every case names desktop as diverging, so this host is only ever asserted to FAIL and nothing pins what it does render. Keep at least one state both shells owe the reader.",
    ]);
  });

  it("keeps the other host green when only its sibling is excused", () => {
    expect(
      contractShapeProblems({
        contract: contractOf({
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "no org in this shell's path" },
        }),
        host: WEB_HOST,
      })
    ).toStrictEqual([]);
  });

  it("refuses a divergence entry with no reason", () => {
    expect(
      contractShapeProblems({
        contract: contractOf(RENDERED, {
          ...MISSING,
          divergence: { [DESKTOP_HOST]: "   " },
          name: "shows the org-scoped detail link",
        }),
        host: DESKTOP_HOST,
      })
    ).toStrictEqual([
      'Widgets list: case "shows the org-scoped detail link" names desktop as diverging with no reason. State what this shell lacks.',
    ]);
  });
});
