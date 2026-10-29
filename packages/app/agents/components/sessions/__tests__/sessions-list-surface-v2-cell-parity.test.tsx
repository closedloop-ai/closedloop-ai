import { BranchProvenance } from "@repo/api/src/types/branch";
import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactTagAvailability, TagColor } from "@repo/api/src/types/tag";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS } from "@repo/app/agents/lib/sessions-column-visibility";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_STATUS_SYNC_BADGE_TEST_ID,
  SessionSyncPresentation,
} from "../../../lib/session-sync-presentation";
import {
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_HARNESS_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
} from "../../../lib/sessions-table-columns";
import { SESSION_HARNESS_CHIP_TEST_ID } from "../session-cell-chips";
import { SessionsTable } from "../session-detail-table";
import {
  createSessionCustomFieldFixture,
  createSessionTableRowFixture,
} from "../session-list-fixtures";
import { renderSessionTagsCell } from "../session-tags-cell";
import { sessionsCustomFieldColumnId } from "../sessions-list-custom-fields";
import { sortRows } from "../sessions-list-surface-rows";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-7902: the three ways `SessionsListSurfaceV2` still diverges from the
 * shipped `SessionsTable` after FEA-4206 closed the Autonomy one.
 *
 * Nothing here is user-visible yet — the surface only ever mounts behind
 * `grid-table-v2`, off on web PostHog and on the desktop Labs toggle — which is
 * why these are divergences to close now rather than shipped defects.
 *
 * The load-bearing assertions compare the TWO LISTINGS against each other on one
 * rendered corpus, the shape FEA-4206's own test established: a check against a
 * constant passes while both surfaces drift together, and passes while only one
 * of them is asserted at all. Where a literal IS pinned it is spelled out here
 * rather than read from the map under test, so a changed label cannot silently
 * re-derive its own expectation.
 */

/** Wide enough that no column folds out of the assertions on either surface. */
const NATURAL_LAYOUT_CONTAINER_PX = 4000;

/**
 * Explicit, for the reason the FEA-4206 sibling records: comparing two listings
 * costs two heavy mounts and the 5s default is not enough under a loaded
 * parallel run. Bounding a known cost, not hiding a hang — the work is
 * synchronous rendering with no waiting.
 */
const TWO_SURFACE_MOUNT_TIMEOUT_MS = 20_000;

/**
 * One row per DISTINCT status/harness pairing, so a renderer that read the
 * neighbouring column reddens instead of coincidentally matching: no two rows
 * here share both values, and the status order is not the harness order.
 *
 * `ses-blank-harness` carries the FALSY-but-valid `harness: ""`, which is a real
 * producer state and the one that separates the two treatments: the shipped chip
 * resolves it to the historical "Claude" default, while the `TableTextCell`
 * fallback this replaces rendered an em dash. An all-populated corpus cannot see
 * that, exactly as an all-truthy autonomy corpus could not see the measured
 * zero (ISS-5565).
 */
const ROWS: SessionTableRow[] = [
  createSessionTableRowFixture({
    harness: "codex",
    id: "ses-active-codex",
    name: "Active Codex session",
    provenance: BranchProvenance.Agent,
    status: SESSION_STATUS.ACTIVE,
    // ISS-5279's transport signal, which `TableChoiceCell` took no prop for and
    // therefore dropped in silence — the cell read "active" whether the record
    // was uploading or not. Only reachable on a DISPLAYED-Active row, which is
    // why it rides this one.
    syncPresentation: SessionSyncPresentation.Syncing,
    tagAvailability: ArtifactTagAvailability.Available,
    tags: [{ color: TagColor.Blue, id: "tag-1", name: "compact-tag-active" }],
  }),
  createSessionTableRowFixture({
    harness: "claude",
    id: "ses-error-claude",
    name: "Failed Claude session",
    status: SESSION_STATUS.ERROR,
    tagAvailability: ArtifactTagAvailability.Available,
    tags: [{ color: TagColor.Red, id: "tag-2", name: "compact-tag-failed" }],
  }),
  createSessionTableRowFixture({
    harness: "",
    id: "ses-blank-harness",
    name: "Inactive default-harness session",
    status: SESSION_STATUS.INACTIVE,
    tagAvailability: ArtifactTagAvailability.Available,
    tags: [
      { color: TagColor.Amber, id: "tag-3", name: "compact-tag-inactive" },
    ],
  }),
];

const REVIEW_SIGNAL_FIELD = createSessionCustomFieldFixture({
  fieldType: CustomFieldType.Text,
  id: "review-signal",
  name: "Review signal",
});
const REVIEW_SIGNAL_VALUES = ["ready", "blocked", "waiting"];
const REVIEW_SIGNAL_COLUMN_ID = sessionsCustomFieldColumnId(
  REVIEW_SIGNAL_FIELD.id
);
const REVIEW_SIGNAL_VALUES_BY_SESSION_ID = new Map(
  ROWS.map((row, index) => [
    row.id,
    [reviewSignalValue(row.id, REVIEW_SIGNAL_VALUES[index] ?? "missing")],
  ])
);

/**
 * The words each column must show, in row order. Spelled out rather than read
 * from `SESSION_STATUS_LABELS` / `HARNESS_DISPLAY_CONFIG`: those maps are what
 * these assertions police, so importing them would make a changed label unable
 * to fail. `error` reads "Failed" and a blank harness reads "Claude" —
 * neither is the stored string, which is the whole divergence.
 */
const EXPECTED_STATUS_WORDS = ["Active", "Failed", "Inactive"];
const EXPECTED_HARNESS_WORDS = ["Codex", "Claude", "Claude"];

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

/** The DATA cells of one column, in row order — never the same-id header. */
function columnCells(container: HTMLElement, columnId: string): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      `[data-column-id="${columnId}"]`
    ),
  ].filter((element) => element.getAttribute("role") !== "columnheader");
}

function columnText(container: HTMLElement, columnId: string): string[] {
  return columnCells(container, columnId).map(visibleCellText);
}

/**
 * A cell's VISIBLE text, with the mocked tooltip BODY removed.
 *
 * `tooltipMockModule` renders `TooltipContent` inline (Radix's portal never
 * mounts in jsdom), so a bare `textContent` read concatenates the pill's word
 * with whatever sentence the tooltip carries — the syncing row came back as
 * `"ActiveThis session is in the cloud, but its transcript is still
 * uploading…"`. That is not what a reader sees in the column, and folding the
 * two together would let a hover sentence stand in for a missing label.
 */
function visibleCellText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const tooltip of clone.querySelectorAll(
    '[data-testid="tooltip-content"]'
  )) {
    tooltip.remove();
  }
  return clone.textContent?.trim() ?? "";
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

describe("SessionsListSurfaceV2 cell parity", () => {
  it(
    "renders Status and Harness the way the shipped Sessions table does",
    () => {
      restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);

      const surface = render(
        <SessionsListSurfaceV2 rows={ROWS} usage={undefined} />
      );
      const table = render(
        <SessionsTable items={ROWS} mode="expanded" renderName={renderName} />
      );

      const surfaceStatuses = columnText(
        surface.container,
        SESSIONS_STATUS_COLUMN_ID
      );
      const surfaceHarnesses = columnText(
        surface.container,
        SESSIONS_HARNESS_COLUMN_ID
      );

      // Positive, per column and per row: the badge states the DISPLAYED word,
      // not the stored one, and the chip resolves the harness id. Asserting the
      // whole ordered list is what makes a swapped mapping fail — a "some chip
      // rendered" check passes when every column renders a chip.
      expect(surfaceStatuses).toEqual(EXPECTED_STATUS_WORDS);
      expect(surfaceHarnesses).toEqual(EXPECTED_HARNESS_WORDS);

      // The divergence guard: same rows, same words, on both listings. Fails if
      // either surface changes its treatment without the other.
      expect(surfaceStatuses).toEqual(
        columnText(table.container, SESSIONS_STATUS_COLUMN_ID)
      );
      expect(surfaceHarnesses).toEqual(
        columnText(table.container, SESSIONS_HARNESS_COLUMN_ID)
      );

      // ISS-5279's sync signal survives the swap and lands on the SAME pill on
      // both listings — the capability `TableChoiceCell` had no prop for. Read
      // by test id rather than by tone class, so it fails if the badge stops
      // modulating rather than merely restyling.
      const syncBadgeIds = (container: HTMLElement) =>
        columnCells(container, SESSIONS_STATUS_COLUMN_ID).map(
          (cell) =>
            cell.querySelector(
              `[data-testid="${SESSION_STATUS_SYNC_BADGE_TEST_ID}"]`
            ) !== null
        );
      expect(syncBadgeIds(surface.container)).toEqual([true, false, false]);
      expect(syncBadgeIds(surface.container)).toEqual(
        syncBadgeIds(table.container)
      );

      // The harness cell routes through the SHARED chip rather than reproducing
      // its label some other way — the text assertions above would stay green if
      // it did, and a second pill is what this ticket exists to prevent.
      expect(
        columnCells(surface.container, SESSIONS_HARNESS_COLUMN_ID).map(
          (cell) =>
            cell.querySelector(
              `[data-testid="${SESSION_HARNESS_CHIP_TEST_ID}"]`
            ) !== null
        )
      ).toEqual([true, true, true]);
    },
    TWO_SURFACE_MOUNT_TIMEOUT_MS
  );

  it.each([
    {
      enabled: false,
      enabledFlags: [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY],
      expectedRoot: "cards",
    },
    {
      enabled: true,
      enabledFlags: [
        GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
        SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY,
      ],
      expectedRoot: "grid",
    },
  ])(
    "keeps the production Sessions caller mutually exclusive with rollout $expectedRoot",
    ({ enabled, enabledFlags }) => {
      restoreContainerWidth = stubResponsiveNarrowViewport(true).restore;
      const favoriteChange = vi.fn();
      const selectedIds = new Set([ROWS[1].id]);
      const navigation = createMemoryNavigation({ orgSlug: "test-org" });

      const { container } = render(
        <NavigationProvider adapter={navigation.adapter}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
          >
            <SessionsListSurfaceV2
              controlledView={{
                onChange: vi.fn(),
                value: {
                  dateRange: DEFAULT_DATE_RANGE,
                  facets: DEFAULT_SESSION_FACET_FILTERS,
                  grouping: EMPTY_TABLE_GROUPING,
                  page: 0,
                  scopeUserId: null,
                  sortBy: null,
                  sortDir: "asc",
                  visibleColumnIds: new Set([
                    ...SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS,
                    SESSIONS_TAGS_COLUMN_ID,
                    REVIEW_SIGNAL_COLUMN_ID,
                  ]),
                },
              }}
              customFields={{
                fields: [REVIEW_SIGNAL_FIELD],
                valuesBySessionId: REVIEW_SIGNAL_VALUES_BY_SESSION_ID,
              }}
              favorites={{
                favoriteIds: new Set([ROWS[0].id]),
                onChange: favoriteChange,
              }}
              getSessionHref={(row) => `/sessions/${row.id}`}
              mode="compact"
              renderTags={renderSessionTagsCell}
              rows={ROWS}
              selection={{ onChange: vi.fn(), selectedIds }}
              usage={undefined}
            />
          </FeatureFlagAdapterProvider>
        </NavigationProvider>
      );

      const grid = container.querySelector<HTMLElement>('[role="grid"]');
      const cardWrappers = [
        ...container.querySelectorAll<HTMLElement>("[data-grid-card-id]"),
      ];
      const cards = [
        ...container.querySelectorAll<HTMLElement>(
          '[data-grid-card-id] > [data-slot="card"]'
        ),
      ];
      const cardFields = container.querySelectorAll("dl");
      if (!enabled) {
        expect(grid).toBeNull();
        expect(cards).toHaveLength(ROWS.length);
        expect(cardWrappers.map((card) => card.dataset.gridCardId)).toEqual(
          ROWS.map((row) => row.id)
        );
        expect(
          cardWrappers.map((card) => card.getAttribute("aria-label"))
        ).toEqual([
          "Active Codex session",
          "Failed Claude session, selected",
          "Inactive default-harness session",
        ]);
        expect(cardWrappers.map((card) => card.dataset.state ?? null)).toEqual([
          null,
          "selected",
          null,
        ]);
        expect(cardFields).toHaveLength(ROWS.length);
        expect(
          cards.map((card) =>
            [...card.querySelectorAll("dt")].map((term) => term.textContent)
          )
        ).toEqual([
          [
            "Tags",
            "Harness",
            "Duration",
            "Total estimated cost",
            "Last active",
            "Review signal",
          ],
          [
            "Tags",
            "Harness",
            "Duration",
            "Total estimated cost",
            "Last active",
            "Review signal",
          ],
          [
            "Tags",
            "Harness",
            "Duration",
            "Total estimated cost",
            "Last active",
            "Review signal",
          ],
        ]);
        expect(
          cards.map((card) =>
            [...card.querySelectorAll("dd")].map((value) =>
              value.textContent?.trim()
            )
          )
        ).toEqual([
          ["compact-tag-active", "Codex", "12m", "$4.12", "5m ago", "ready"],
          ["compact-tag-failed", "Claude", "12m", "$4.12", "5m ago", "blocked"],
          [
            "compact-tag-inactive",
            "Claude",
            "12m",
            "$4.12",
            "5m ago",
            "waiting",
          ],
        ]);
        expect(
          cards.map((card) =>
            card.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")
          )
        ).toEqual(ROWS.map((row) => `/sessions/${row.id}`));
        expect(cards.map((card) => card?.textContent)).toEqual(
          ROWS.map((row, index) =>
            expect.stringContaining(
              `${row.name}${EXPECTED_STATUS_WORDS[index]}`
            )
          )
        );
        expect(
          cards.map((card) =>
            card
              .querySelector<HTMLButtonElement>("button[aria-pressed]")
              ?.getAttribute("aria-label")
          )
        ).toEqual([
          "Remove Active Codex session from favorites",
          "Add Failed Claude session to favorites",
          "Add Inactive default-harness session to favorites",
        ]);
        expect(
          cards.map((card) =>
            card
              .querySelector<HTMLButtonElement>("button[aria-pressed]")
              ?.getAttribute("aria-pressed")
          )
        ).toEqual(["true", "false", "false"]);
        expect(
          container.querySelector('[aria-label="Agent session"]')
        ).toBeNull();
        expect(favoriteChange).not.toHaveBeenCalled();
        return;
      }

      expect(cards).toHaveLength(0);
      expect(cardFields).toHaveLength(0);
      expect(grid).not.toBeNull();
      expect(grid).toHaveClass("min-w-0");
      expect(grid).toHaveAttribute("aria-colcount", "1");
      const headers = container.querySelectorAll('[role="columnheader"]');
      expect(headers).toHaveLength(1);
      expect(headers[0]).toHaveTextContent("Name");
      // ISS-12959: the narrow row is status icon and title; Tags stay wide.
      expect(container).not.toHaveTextContent("compact-tag-active");
      expect(container).not.toHaveTextContent("compact-tag-failed");
      expect(container).not.toHaveTextContent("compact-tag-inactive");
      for (const row of ROWS) {
        expect(
          container.querySelector(`[data-grid-row-id="${row.id}"]`)
        ).not.toBeNull();
      }
    }
  );

  it("[DT-05] keeps every configured grid column above the breakpoint", () => {
    restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);

    const { container } = render(
      <SessionsListSurfaceV2 rows={ROWS} usage={undefined} />
    );

    const grid = container.querySelector<HTMLElement>('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid).toHaveClass("min-w-fit");
    expect(
      container.querySelectorAll('[role="columnheader"]').length
    ).toBeGreaterThan(1);
  });
});

function reviewSignalValue(
  entityId: string,
  displayValue: string
): CustomFieldValueDetail {
  return {
    customFieldId: REVIEW_SIGNAL_FIELD.id,
    dateValue: null,
    displayValue,
    entityId,
    enumValue: null,
    fieldType: CustomFieldType.Text,
    id: `${REVIEW_SIGNAL_FIELD.id}-${entityId}`,
    multiEnumValues: [],
    name: REVIEW_SIGNAL_FIELD.name,
    numberValue: null,
    peopleValues: [],
    referenceValues: [],
    showInTable: true,
    textValue: displayValue,
  };
}

/**
 * The Autonomy column's SORT key.
 *
 * The ticket reported v2 sorting this column by its rendered tier word; it does
 * not — `SESSION_CELL_READERS.autonomy` returns the score. What it did was
 * `localeCompare` that stringified score, which is lexicographic. The fixture
 * below is the discriminating one: alphabetically `"100"` precedes `"9"`, so the
 * buggy and the correct comparator DISAGREE on it, where a corpus of equal-width
 * numbers would have let both produce the same order.
 *
 * Driven through `sortRows` to pin the client execution arm directly. The v2
 * header can now reach the same raw reader; the host-parity suite pins that UI
 * handoff separately.
 */
describe("sortRows autonomy ordering", () => {
  const SCORED_ROWS: SessionTableRow[] = [
    createSessionTableRowFixture({ autonomy: 9, id: "ses-9" }),
    createSessionTableRowFixture({ autonomy: 100, id: "ses-100" }),
    createSessionTableRowFixture({ autonomy: 0, id: "ses-0" }),
    createSessionTableRowFixture({ autonomy: null, id: "ses-unscored" }),
  ];

  const idsOf = (rows: readonly SessionTableRow[]) => rows.map((row) => row.id);

  it("orders by the score, not by its stringified label", () => {
    expect(idsOf(sortRows(SCORED_ROWS, SESSIONS_AUTONOMY_COLUMN_ID, "asc")))
      // A measured 0 leads, 9 precedes 100, and the UNSCORED row is last rather
      // than sorting as if it were the lowest score (ISS-5565's distinction).
      .toEqual(["ses-0", "ses-9", "ses-100", "ses-unscored"]);
  });

  it("reverses the scores but keeps the unscored row last", () => {
    expect(
      idsOf(sortRows(SCORED_ROWS, SESSIONS_AUTONOMY_COLUMN_ID, "desc"))
    ).toEqual(["ses-100", "ses-9", "ses-0", "ses-unscored"]);
  });
});
