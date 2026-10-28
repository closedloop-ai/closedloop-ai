/**
 * ISS-9567 — the width axis.
 *
 * The record has declared `columnWidths` since ISS-9447 M2 so a newer build's
 * map survived this build's mount, and nothing ever read it back: this hook
 * dropped the axis and `useSessionsListColumns` kept the widths in component
 * state, so a Sessions resize lasted exactly one mount. ISS-12992 retired the
 * flag that gated it, so the axis is always handed on.
 *
 * What a stored record RESTORES to is `usePersistedTableViewState`'s and is
 * covered by its own suite; what this file owns is that Sessions hands the axis
 * on rather than swallowing it.
 */

import { MAX_CUSTOM_FIELDS_PER_ORG } from "@repo/api/src/types/custom-field";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SERIALIZED_TABLE_VIEW_LENGTH } from "../../../shared/hooks/persisted-table-view-snapshot";
import { MAX_PRESERVED_COLUMN_IDS_PER_AXIS } from "../../../shared/lib/preserved-column-ids";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { sessionsCustomFieldColumnId } from "../../components/sessions/sessions-list-custom-fields";
import { SessionSortDir } from "../../lib/session-sort-group";
import { useSessionsViewState } from "../use-sessions-view-state";

const PERSIST_KEY = "sessions:test";
/**
 * The PER-USER key, which is the one production writes: `AppCoreStoryProviders`
 * mounts a static auth adapter reporting `user_test`, and a saved view has been
 * namespaced by the signed-in user since FEA-4168 so two accounts sharing one OS
 * profile never read each other's layout.
 */
const STORAGE_KEY = `sessions:saved-view:${PERSIST_KEY}:u:user_test`;
const STORED_WIDTH_PX = 321;
/**
 * ISS-10356: a custom-field column id, which the record holds a WIDTH for.
 * Built from a UUID because `CustomField.id` is one, and only such an id is a
 * width-only column (tamsinb, PR #8117).
 */
const CUSTOM_FIELD_COLUMN_ID = customFieldColumnId(0);
const CUSTOM_FIELD_WIDTH_PX = 287;
/** One more custom field than the version-skew carry holds. */
const SKEW_CAP_PLUS_ONE = MAX_PRESERVED_COLUMN_IDS_PER_AXIS + 1;
/** "A few hundred width-only ids of 200+ chars each" (tamsinb, PR #8117). */
const LONG_ID_COUNT = 300;
const LONG_ID_LENGTH = 250;

afterEach(() => {
  localStorage.clear();
});

function seedStoredWidth(): void {
  localStorage.setItem(
    STORAGE_KEY,
    // A WHOLE record: the surface's Zod schema is the restore boundary, and a
    // partial object parses to null, which restores nothing at all.
    JSON.stringify({
      columnWidths: { cost: STORED_WIDTH_PX },
      hiddenColumns: [],
      sortDir: SessionSortDir.Desc,
      sortKey: null,
    })
  );
}

describe("useSessionsViewState column widths", () => {
  it("hands back the stored width axis", () => {
    seedStoredWidth();

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    expect(result.current.columnWidths.cost).toBe(STORED_WIDTH_PX);
    expect(result.current.setColumnWidth).toBeTypeOf("function");
  });

  it("persists a resize the reader makes", () => {
    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    act(() => {
      result.current.setColumnWidth("cost", STORED_WIDTH_PX);
    });

    expect(result.current.columnWidths.cost).toBe(STORED_WIDTH_PX);
    // Read back off the record itself, not the hook: what makes a resize
    // survive a reload is the write, and a setter that only moved React state
    // would satisfy the assertion above and nothing a reader cares about.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.columnWidths).toEqual({ cost: STORED_WIDTH_PX });
  });

  it("restores a stored custom-field width beside the built-in one (ISS-10356)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnWidths: {
          cost: STORED_WIDTH_PX,
          [CUSTOM_FIELD_COLUMN_ID]: CUSTOM_FIELD_WIDTH_PX,
        },
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    expect(result.current.columnWidths).toEqual({
      cost: STORED_WIDTH_PX,
      [CUSTOM_FIELD_COLUMN_ID]: CUSTOM_FIELD_WIDTH_PX,
    });
  });

  it("persists a custom-field resize into the record (ISS-10356)", () => {
    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    act(() => {
      result.current.setColumnWidth(
        CUSTOM_FIELD_COLUMN_ID,
        CUSTOM_FIELD_WIDTH_PX
      );
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.columnWidths).toEqual({
      [CUSTOM_FIELD_COLUMN_ID]: CUSTOM_FIELD_WIDTH_PX,
    });
  });

  it("keeps the 65th custom field's width, past the version-skew carry cap (whitlockk, PR #8117)", () => {
    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    act(() => {
      resizeCustomFields(result.current.setColumnWidth, SKEW_CAP_PLUS_ONE);
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(Object.keys(stored.columnWidths)).toHaveLength(SKEW_CAP_PLUS_ONE);
    expect(stored.columnWidths).toHaveProperty(customFieldColumnId(0));
  });

  it("caps live custom-field resizes at the org's custom-field limit, dropping the one resized longest ago (ISS-10356)", () => {
    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    act(() => {
      resizeCustomFields(
        result.current.setColumnWidth,
        MAX_CUSTOM_FIELDS_PER_ORG
      );
      // Field 0 was resized first; touching it again makes field 1 the oldest.
      result.current.setColumnWidth(customFieldColumnId(0), 250);
      result.current.setColumnWidth(
        customFieldColumnId(MAX_CUSTOM_FIELDS_PER_ORG),
        200
      );
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(Object.keys(stored.columnWidths)).toHaveLength(
      MAX_CUSTOM_FIELDS_PER_ORG
    );
    expect(stored.columnWidths[customFieldColumnId(0)]).toBe(250);
    expect(stored.columnWidths).not.toHaveProperty(customFieldColumnId(1));
  });

  it("persists the reader's next edit past a record of long custom-field ids (tamsinb, PR #8117)", () => {
    // Under the width-only COUNT cap and far over the byte ceiling: the ids
    // share the prefix and nothing else a real field's id has.
    const longIdWidths = Object.fromEntries(
      Array.from({ length: LONG_ID_COUNT }, (_, i) => [
        sessionsCustomFieldColumnId(`${i}-${"x".repeat(LONG_ID_LENGTH)}`),
        200,
      ])
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnWidths: {
          ...longIdWidths,
          [CUSTOM_FIELD_COLUMN_ID]: CUSTOM_FIELD_WIDTH_PX,
        },
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    expect(localStorage.getItem(STORAGE_KEY)?.length).toBeGreaterThan(
      MAX_SERIALIZED_TABLE_VIEW_LENGTH
    );
    const { result } = renderHook(() => useSessionsViewState(PERSIST_KEY), {
      wrapper: AppCoreStoryProviders,
    });

    act(() => {
      result.current.setColumnWidth("cost", STORED_WIDTH_PX);
    });

    // The ISS-9449 wedge: were those ids applied, no rung could shed them and
    // every write — this edit's included — would be refused.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.columnWidths.cost).toBe(STORED_WIDTH_PX);
    expect(stored.columnWidths[CUSTOM_FIELD_COLUMN_ID]).toBe(
      CUSTOM_FIELD_WIDTH_PX
    );
    expect(result.current.columnWidths).toEqual({
      cost: STORED_WIDTH_PX,
      [CUSTOM_FIELD_COLUMN_ID]: CUSTOM_FIELD_WIDTH_PX,
    });
  });
});

function resizeCustomFields(
  setColumnWidth: (id: string, widthPx: number) => void,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    setColumnWidth(customFieldColumnId(i), 200);
  }
}

/** The column id of the `n`th custom field, whose id is a UUID like a real one. */
function customFieldColumnId(n: number): string {
  return sessionsCustomFieldColumnId(
    `0197f3c2-0000-7000-8000-${String(n).padStart(12, "0")}`
  );
}
