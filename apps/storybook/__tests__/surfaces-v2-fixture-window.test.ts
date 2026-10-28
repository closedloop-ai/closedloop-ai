/**
 * ISS-12442 — a fixture instant that ages out of its surface's default window.
 *
 * `v2-branches-list > Default` went red on a calendar boundary with no code
 * change, once its newest pinned row fell outside the range the list defaults
 * to; restoring the pins reproduces it on demand. The story sweep catches that
 * only on the day it happens, so these cases assert the property the sweep
 * depends on, at each clock in {@link PINNED_CLOCKS}.
 *
 * Both fixtures map their authored instants in a module-level const, so the
 * clock is pinned and the fixture modules are then imported dynamically: a
 * static import evaluates those instants against the real clock whatever a
 * later `beforeEach` pins, which leaves the window these cases read moving
 * under them at UTC midnight.
 */
import type { ArtifactDateDimension } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-date-dimension";
import {
  DEFAULT_ARTIFACT_DATE_RANGE,
  withinArtifactDateDimension,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-date-dimension";
import {
  DEFAULT_DATE_RANGE,
  getStableDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureInstant } from "../stories/surfaces-v2/fixtures/fixture-clock";

const MINUTE_MS = 60_000;

/**
 * Either side of the UTC midnight the original failure crossed, then a year
 * on, where an instant pinned at authoring time would be long gone.
 */
const PINNED_CLOCKS = [
  "2026-10-13T23:59:59.000Z",
  "2026-10-14T00:00:01.000Z",
  "2027-10-13T12:00:00.000Z",
] as const;

type OutOfWindow = { subject: string; field: string; at: string };

describe("surfaces-v2 fixture instants stay inside their surface's window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(PINNED_CLOCKS)(
    "keeps every Branches row inside the live default window at %s",
    async (nowIso) => {
      const { branchesListRowsFixture } = await loadFixturesAt(nowIso);
      const { startDate } = getStableDateWindowForRange(DEFAULT_DATE_RANGE);
      // An unbounded range would make every assertion below vacuous.
      expect(startDate).toBeDefined();
      const windowStartMs = Date.parse(startDate ?? "");
      const now = Date.now();
      const outside = branchesListRowsFixture
        .flatMap((row) => [
          {
            subject: row.branchName,
            field: "lastActivityAt",
            at: row.lastActivityAt,
          },
          ...(row.mergedAt
            ? [{ subject: row.branchName, field: "mergedAt", at: row.mergedAt }]
            : []),
        ])
        .filter(({ at }) => isOutsideWindow(at, windowStartMs, now));
      expect(outside).toEqual<OutOfWindow[]>([]);
    }
  );

  it.each(PINNED_CLOCKS)(
    "keeps every Documents row inside the artifact list's default window at %s",
    async (nowIso) => {
      const { documentsListFixture } = await loadFixturesAt(nowIso);
      // The production predicate, not a second day-subtraction written here:
      // the generic artifact list is what narrows these rows, on
      // `updatedAgoMinutes`.
      const dimension: ArtifactDateDimension = {
        present: true,
        range: DEFAULT_ARTIFACT_DATE_RANGE,
        setRange: () => undefined,
      };
      const now = Date.now();
      const outside = documentsListFixture
        .map((document) => ({
          subject: document.title,
          field: "updatedAt",
          at: document.updatedAt.toISOString(),
          agoMinutes: (now - document.updatedAt.getTime()) / MINUTE_MS,
        }))
        .filter(
          ({ agoMinutes }) =>
            agoMinutes < 0 ||
            !withinArtifactDateDimension(dimension, agoMinutes)
        )
        .map(({ subject, field, at }) => ({ subject, field, at }));
      expect(outside).toEqual<OutOfWindow[]>([]);
    }
  );

  it("anchors an authored day onto yesterday whatever the calendar says", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-07-04T03:17:00.000Z"));
    const fixtureInstant = createFixtureInstant("2026-10-06T00:00:00.000Z");
    // The newest authored instant keeps its time of day on yesterday, and an
    // instant five days older stays five days older.
    expect(fixtureInstant("2026-10-06T09:24:00.000Z")).toBe(
      "2027-07-03T09:24:00.000Z"
    );
    expect(fixtureInstant("2026-10-01T14:32:00.000Z")).toBe(
      "2027-06-28T14:32:00.000Z"
    );
  });
});

/**
 * Only `Date` is faked: these imports resolve through the module loader, which
 * a fully faked timer set can hold.
 */
async function loadFixturesAt(nowIso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(nowIso));
  vi.resetModules();
  const [branches, documents] = await Promise.all([
    import("../stories/surfaces-v2/fixtures/branches-list-fixtures"),
    import("../stories/surfaces-v2/fixtures/documents-list-fixtures"),
  ]);
  return {
    branchesListRowsFixture: branches.branchesListRowsFixture,
    documentsListFixture: documents.documentsListFixture,
  };
}

function isOutsideWindow(
  at: string,
  windowStartMs: number,
  now: number
): boolean {
  const atMs = Date.parse(at);
  return Number.isNaN(atMs) || atMs < windowStartMs || atMs > now;
}
