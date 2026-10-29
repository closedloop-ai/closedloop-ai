import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { describe, expect, it } from "vitest";
import {
  createSessionCustomFieldFixture,
  createSessionTableRowFixture,
} from "../session-list-fixtures";
import { sessionsCustomFieldColumnId } from "../sessions-list-custom-fields";
import { resolveSessionsRows } from "../sessions-list-surface-model";

const ROWS = [
  createSessionTableRowFixture({
    id: "active-zoe",
    name: "active-zoe",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "zoe", name: "Zoe" },
  }),
  createSessionTableRowFixture({
    id: "error-amy",
    name: "error-amy",
    status: SESSION_STATUS.ERROR,
    user: { id: "amy", name: "Amy" },
  }),
  createSessionTableRowFixture({
    id: "active-amy",
    name: "active-amy",
    status: SESSION_STATUS.ACTIVE,
    user: { id: "amy", name: "Amy" },
  }),
];

describe("SessionsListSurfaceV2 ordered sorting", () => {
  it("uses later clauses as tie-breakers without replacing the primary", () => {
    const result = resolveSessionsRows({
      customFieldFilters: new Map(),
      // The fixture rows sit at a FIXED instant, so an unbounded window is what
      // keeps this a test about ordering rather than about the clock.
      dateRange: "all",
      facets: DEFAULT_SESSION_FACET_FILTERS,
      isServerDriven: false,
      search: "",
      rows: ROWS,
      scopeUserId: null,
      sorts: [
        { fieldId: "status", direction: "asc" },
        { fieldId: "owner", direction: "asc" },
      ],
    });

    expect(result.sorted.map((row) => row.id)).toEqual([
      "active-amy",
      "active-zoe",
      "error-amy",
    ]);
  });

  it("applies session id only after custom-field and secondary sort ties", () => {
    const customField = createSessionCustomFieldFixture({
      fieldType: CustomFieldType.Text,
      id: "review-note",
      name: "Review note",
    });
    const result = resolveSessionsRows({
      customFieldFilters: new Map(),
      customFields: {
        fields: [customField],
        valuesBySessionId: new Map(),
      },
      dateRange: "all",
      facets: DEFAULT_SESSION_FACET_FILTERS,
      isServerDriven: false,
      search: "",
      rows: [
        createSessionTableRowFixture({
          id: "z-amy",
          name: "z-amy",
          user: { id: "amy", name: "Amy" },
        }),
        createSessionTableRowFixture({
          id: "a-zoe",
          name: "a-zoe",
          user: { id: "zoe", name: "Zoe" },
        }),
        createSessionTableRowFixture({
          id: "y-amy",
          name: "y-amy",
          user: { id: "amy", name: "Amy" },
        }),
      ],
      scopeUserId: null,
      sorts: [
        {
          fieldId: sessionsCustomFieldColumnId(customField.id),
          direction: "asc",
        },
        { fieldId: "owner", direction: "asc" },
      ],
    });

    expect(result.sorted.map((row) => row.id)).toEqual([
      "y-amy",
      "z-amy",
      "a-zoe",
    ]);
  });

  it("leaves input order unchanged when a custom-field sort no longer resolves", () => {
    const result = resolveSessionsRows({
      customFieldFilters: new Map(),
      customFields: {
        fields: [],
        valuesBySessionId: new Map(),
      },
      dateRange: "all",
      facets: DEFAULT_SESSION_FACET_FILTERS,
      isServerDriven: false,
      search: "",
      rows: [
        createSessionTableRowFixture({ id: "z-first" }),
        createSessionTableRowFixture({ id: "a-second" }),
      ],
      scopeUserId: null,
      sorts: [
        {
          fieldId: sessionsCustomFieldColumnId("deleted-field"),
          direction: "asc",
        },
      ],
    });

    expect(result.sorted.map((row) => row.id)).toEqual(["z-first", "a-second"]);
  });
});
