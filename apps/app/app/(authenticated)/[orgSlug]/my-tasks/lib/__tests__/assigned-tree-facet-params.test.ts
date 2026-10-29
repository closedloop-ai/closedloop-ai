import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DocumentStatus,
  IssueStatus,
} from "@repo/api/src/types/document";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import {
  DatePreset,
  type TableFilters,
} from "@repo/app/documents/hooks/use-table-filters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignedTreeFacetParams,
  withUnsetPriorityDisplayFallback,
} from "../assigned-tree-facet-params";

/** A pinned instant, so every window below is checked against a fixed clock. */
const NOW = new Date("2026-10-21T12:00:00.000Z");

const NO_FILTERS: TableFilters = {
  assigneeIds: [],
  assignToMe: false,
  date: null,
  favoritesOnly: false,
  hideCompletedItems: false,
  priorities: [],
  statuses: [],
  tagIds: [],
};

function filters(overrides: Partial<TableFilters>): TableFilters {
  return { ...NO_FILTERS, ...overrides };
}

/**
 * Pin the zone for the whole file.
 *
 * `dateRangeForPreset` walks the LOCAL calendar while these assertions are
 * absolute UTC, and the longer windows cross southern-hemisphere DST starts
 * (NZDT 2026-09-27, AEDT 2026-10-04) — under `TZ=Pacific/Auckland` `Last30d`
 * resolves an hour off. Same shape as `use-table-filters.date-filters.test.ts`,
 * which pins the zone for the same derivation; duplicated rather than imported
 * because it is a local test helper there, not an export.
 */
function pinZone(timeZone: string) {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = timeZone;
  });

  afterEach(() => {
    if (originalTz === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = originalTz;
    }
  });
}

describe("assignedTreeFacetParams", () => {
  pinZone("UTC");

  it("sends nothing when no filter and no window is active", () => {
    const facets = assignedTreeFacetParams(NO_FILTERS, false, NOW);

    expect(facets).toEqual({});
  });

  // TWO statuses, because one cannot tell a per-value mapping from a flag that
  // happens to be set whenever any status is selected.
  it("sends every selected stored status", () => {
    const facets = assignedTreeFacetParams(
      filters({ statuses: [IssueStatus.Todo, DocumentStatus.Approved] }),
      false,
      NOW
    );

    expect(facets.status).toEqual([IssueStatus.Todo, DocumentStatus.Approved]);
  });

  it("keeps the render-only Unknown status off the wire", () => {
    const facets = assignedTreeFacetParams(
      filters({
        statuses: [IssueStatus.Todo, DISPLAYED_ARTIFACT_STATUS.Unknown],
      }),
      false,
      NOW
    );

    expect(facets.status).toEqual([IssueStatus.Todo]);
  });

  // Not an empty `status=` occurrence, which the route rejects as a value that
  // failed to spell itself, and not a silently unfiltered read either: the
  // option is not offered on this surface, so the selection cannot arise.
  it("omits the status facet entirely when only Unknown is selected", () => {
    const facets = assignedTreeFacetParams(
      filters({ statuses: [DISPLAYED_ARTIFACT_STATUS.Unknown] }),
      false,
      NOW
    );

    expect(facets.status).toBeUndefined();
  });

  it("sends the unset priority token alongside a real priority", () => {
    const facets = assignedTreeFacetParams(
      filters({ priorities: [PRIORITY_UNSET_VALUE, Priority.High] }),
      false,
      NOW
    );

    expect(facets.priority).toEqual([PRIORITY_UNSET_VALUE, Priority.High]);
  });

  it("sends every selected tag", () => {
    const facets = assignedTreeFacetParams(
      filters({ tagIds: ["tag-a", "tag-b"] }),
      false,
      NOW
    );

    expect(facets.tagId).toEqual(["tag-a", "tag-b"]);
  });

  it("omits both booleans when they are false, since false narrows nothing", () => {
    const facets = assignedTreeFacetParams(
      filters({ favoritesOnly: false, hideCompletedItems: false }),
      false,
      NOW
    );

    expect(facets.favoritesOnly).toBeUndefined();
    expect(facets.hideCompletedItems).toBeUndefined();
  });

  it("sends each boolean independently when set", () => {
    const facets = assignedTreeFacetParams(
      filters({ favoritesOnly: true, hideCompletedItems: false }),
      false,
      NOW
    );

    expect(facets.favoritesOnly).toBe(true);
    expect(facets.hideCompletedItems).toBeUndefined();
  });

  it("resolves a preset to absolute bounds against the given clock", () => {
    const facets = assignedTreeFacetParams(
      filters({
        date: {
          field: ArtifactDateField.CreatedAt,
          preset: DatePreset.Last7d,
        },
      }),
      false,
      NOW
    );

    expect(facets.dateField).toBe(ArtifactDateField.CreatedAt);
    expect(facets.dateFrom?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    expect(facets.dateTo?.toISOString()).toBe(NOW.toISOString());
  });

  it("sends a custom range verbatim", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");
    const facets = assignedTreeFacetParams(
      filters({
        date: {
          endDate: to,
          field: ArtifactDateField.UpdatedAt,
          preset: DatePreset.Custom,
          startDate: from,
        },
      }),
      false,
      NOW
    );

    expect(facets.dateFrom).toBe(from);
    expect(facets.dateTo).toBe(to);
  });

  it("sends no window for a half-entered custom range", () => {
    const facets = assignedTreeFacetParams(
      filters({
        date: {
          field: ArtifactDateField.UpdatedAt,
          preset: DatePreset.Custom,
          startDate: new Date("2026-01-01T00:00:00.000Z"),
        },
      }),
      false,
      NOW
    );

    expect(facets.dateField).toBeUndefined();
    expect(facets.dateFrom).toBeUndefined();
    expect(facets.dateTo).toBeUndefined();
  });

  it("maps an active recency window onto the updated-at date facet", () => {
    const facets = assignedTreeFacetParams(NO_FILTERS, true, NOW);

    expect(facets.dateField).toBe(ArtifactDateField.UpdatedAt);
    expect(facets.dateTo?.toISOString()).toBe(NOW.toISOString());
    const spanDays =
      (NOW.getTime() - (facets.dateFrom?.getTime() ?? 0)) / 86_400_000;
    expect(spanDays).toBe(DOCUMENT_LIST_DEFAULT_RECENCY_DAYS);
  });

  // Precedence, not a merge: two windows on one field would need an
  // intersection the route cannot express, and the user's own selection is the
  // more specific statement of intent.
  it("lets an explicit date filter take precedence over the window", () => {
    const facets = assignedTreeFacetParams(
      filters({
        date: {
          field: ArtifactDateField.CreatedAt,
          preset: DatePreset.Last24h,
        },
      }),
      true,
      NOW
    );

    expect(facets.dateField).toBe(ArtifactDateField.CreatedAt);
    expect(facets.dateFrom?.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });
  // The browser treats an inverted range as NO narrowing, and the route 400s
  // `dateFrom > dateTo`. Sending one both diverged from the browser and took
  // the whole board to its load-failed state.
  it("sends no window for a custom range whose end precedes its start", () => {
    const facets = assignedTreeFacetParams(
      filters({
        date: {
          endDate: new Date("2026-01-01T00:00:00.000Z"),
          field: ArtifactDateField.UpdatedAt,
          preset: DatePreset.Custom,
          startDate: new Date("2026-02-01T00:00:00.000Z"),
        },
      }),
      false,
      NOW
    );

    expect(facets.dateField).toBeUndefined();
    expect(facets.dateFrom).toBeUndefined();
    expect(facets.dateTo).toBeUndefined();
  });

  // A same-instant range is a legitimate one-moment selection, not an inverted
  // one — the guard above must not swallow it.
  it("sends a custom range whose bounds are equal", () => {
    const at = new Date("2026-03-03T09:00:00.000Z");
    const facets = assignedTreeFacetParams(
      filters({
        date: {
          endDate: at,
          field: ArtifactDateField.UpdatedAt,
          preset: DatePreset.Custom,
          startDate: at,
        },
      }),
      false,
      NOW
    );

    expect(facets.dateFrom).toBe(at);
    expect(facets.dateTo).toBe(at);
  });

  // All four presets, because the facet narrows the ANCHOR set: a wrong window
  // makes the board and its footer agree with each other and both disagree
  // with the chip the reader is looking at. The exhaustive `never` guard is a
  // type guarantee only — it stops a new preset compiling, not a wrong window.
  it.each([
    [DatePreset.Last24h, "2026-10-20T12:00:00.000Z"],
    [DatePreset.Last7d, "2026-10-14T12:00:00.000Z"],
    [DatePreset.Last30d, "2026-09-21T12:00:00.000Z"],
    [DatePreset.Last3m, "2026-07-21T12:00:00.000Z"],
  ])("resolves %s against the given clock", (preset, expectedFrom) => {
    const facets = assignedTreeFacetParams(
      filters({ date: { field: ArtifactDateField.CreatedAt, preset } }),
      false,
      NOW
    );

    expect(facets.dateFrom?.toISOString()).toBe(expectedFrom);
    expect(facets.dateTo?.toISOString()).toBe(NOW.toISOString());
  });
});

describe("withUnsetPriorityDisplayFallback", () => {
  // ISS-9665 flag-OFF semantics (whitlockk, PR #9091): an artifact holding no
  // priority RENDERS as `Medium`, and the browser predicate the flat tabs run
  // matches it on that substituted value. The route filters the stored column,
  // so `MEDIUM` alone drops those rows and one selection would mean two
  // different sets on two tabs of the same board.
  it("adds the unset token beside a Medium selection", () => {
    const facets = withUnsetPriorityDisplayFallback({
      priority: [Priority.Medium, Priority.High],
    });

    expect(facets.priority).toEqual([
      Priority.Medium,
      Priority.High,
      PRIORITY_UNSET_VALUE,
    ]);
  });

  it("leaves a selection without Medium alone", () => {
    const facets = withUnsetPriorityDisplayFallback({
      priority: [Priority.High],
    });

    expect(facets.priority).toEqual([Priority.High]);
  });

  it("does not repeat an unset token the selection already carries", () => {
    const selected = [Priority.Medium, PRIORITY_UNSET_VALUE];
    const facets = withUnsetPriorityDisplayFallback({ priority: selected });

    expect(facets.priority).toEqual(selected);
  });

  it("leaves an unfiltered selection unfiltered", () => {
    // Guards the whole-population case: inventing a priority facet here would
    // narrow a board the reader asked nothing of.
    expect(withUnsetPriorityDisplayFallback({}).priority).toBeUndefined();
  });
});
