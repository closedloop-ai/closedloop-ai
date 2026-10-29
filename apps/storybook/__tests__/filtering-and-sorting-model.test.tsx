import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { appComponentCatalog } from "@repo/design-system/storybook/component-catalog";
import { composeStory } from "@storybook/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import {
  SESSION_DATE_RANGE_DEFINITIONS,
  SESSION_DATE_RANGES,
  SESSION_ROWS,
  SESSION_SORT_OPTIONS,
  SESSION_STATUS_OPTIONS,
} from "../stories/composites-v2/filtering-and-sorting-model/fixtures";
import { SESSION_SORT_CONFIGS } from "../stories/composites-v2/filtering-and-sorting-model/model";
import meta, {
  ActiveFilters,
  ComposedToolbar,
  Dark,
  Default,
  Narrow,
  RangeEscapeRecovery,
  Sorting,
} from "../stories/composites-v2/filtering-and-sorting-model.stories";
import { SESSION_ROWS as FROZEN_SESSION_ROWS } from "../stories/grid-table-toolbar-demo/fixtures";

describe("PRD-721 AC-3 / DT-FS-13 filtering and sorting stories", () => {
  it.each([
    ["Default", Default],
    ["Active Filters", ActiveFilters],
    ["Sorting", Sorting],
    ["Composed Toolbar", ComposedToolbar],
    ["Range Escape Recovery", RangeEscapeRecovery],
  ])("runs the %s interaction contract", async (_name, story) => {
    await composeStory(story, meta).run();
  });

  it("declares stable light/dark and wide/narrow review coverage", () => {
    expect(meta.tags).toEqual(["stable"]);
    expect(Dark.globals).toEqual({ theme: "dark" });
    expect(Narrow.globals).toEqual({ viewport: { value: "390-844" } });
    expect(meta.parameters?.controls).toEqual({ disable: true });
  });

  it("catalogs the production shared toolbar against the current story", () => {
    expect(
      appComponentCatalog.find(
        (entry) => entry.id === "list-surface-toolbar-v2"
      )
    ).toMatchObject({
      level: "Composites",
      sourcePath: "packages/app/shared/components/list-surface-toolbar-v2.tsx",
      storyId: "filtering-and-sorting-model",
      storyTitle: "Composites/Shared/Artifact List/Filtering and Sorting Model",
    });
  });

  it("has no serious or critical non-contrast axe violations after the composed transitions", async () => {
    await composeStory(ComposedToolbar, meta).run();
    // JSDOM has no layout/color engine, so axe cannot evaluate contrast here.
    // The routed live visual-QA pass owns WCAG color-contrast evidence.
    const results = await axe.run(globalThis.document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      results.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious"
      )
    ).toEqual([]);
  });

  it("derives every visible sort and date option from behavioral metadata", () => {
    expect(Object.keys(SESSION_SORT_CONFIGS).sort()).toEqual(
      SESSION_SORT_OPTIONS.map((option) => option.id).sort()
    );
    for (const option of SESSION_DATE_RANGES) {
      const definition = SESSION_DATE_RANGE_DEFINITIONS.find(
        (candidate) => candidate.value === option.value
      );
      expect(definition).toBeDefined();
      expect(Object.hasOwn(definition ?? {}, "days")).toBe(true);
    }
  });

  it("derives fixture status values and labels from the canonical session vocabulary", () => {
    expect(new Set(SESSION_ROWS.map((row) => row.status))).toEqual(
      new Set(Object.values(SESSION_STATUS))
    );
    expect(SESSION_STATUS_OPTIONS).toEqual(
      Object.values(SESSION_STATUS).map((status) => ({
        id: status,
        label: SESSION_STATUS_LABELS[status],
      }))
    );
  });

  it("owns current fixtures without changing the frozen v1 toolbar values", () => {
    const currentEmptyModel = SESSION_ROWS.find((row) => row.id === "ses_7b12");
    const frozenBlocked = FROZEN_SESSION_ROWS.find(
      (row) => row.id === "ses_7b12"
    );

    expect(currentEmptyModel).toMatchObject({ cost: 0.24, model: null });
    expect(frozenBlocked).toMatchObject({ cost: 0.61, model: "Haiku 4.5" });
    expect(SESSION_ROWS).not.toBe(FROZEN_SESSION_ROWS);
  });

  it("renders representative table values through the canonical cell primitives", async () => {
    await composeStory(Sorting, meta).run();
    const emptyModelRow = globalThis.document.body.querySelector(
      '[data-grid-row-id="ses_7b12"]'
    );
    expect(emptyModelRow).not.toBeNull();
    expect(
      emptyModelRow?.querySelector(
        '[data-column-id="owner"] [data-slot="avatar"]'
      )
    ).not.toBeNull();
    expect(
      emptyModelRow?.querySelector(
        '[data-column-id="status"] [data-slot="chip"]'
      )
    ).not.toBeNull();
    expect(
      emptyModelRow?.querySelector(
        '[data-column-id="repository"] [title="closedloop-ai/closedloop-electron"] svg'
      )
    ).not.toBeNull();
    expect(
      emptyModelRow?.querySelector(
        '[data-column-id="model"] [data-slot="grid-empty-value"]'
      )
    ).not.toBeNull();
    expect(
      emptyModelRow?.querySelector('[data-column-id="cost"] .tabular-nums')
    ).toHaveTextContent("$0.24");
    expect(
      emptyModelRow?.querySelector(
        '[data-column-id="updated"] [title="2026-08-15T00:00:00.000Z"]'
      )
    ).toHaveTextContent("5 days ago");

    const textModelRow = globalThis.document.body.querySelector(
      '[data-grid-row-id="ses_7a98"]'
    );
    expect(
      textModelRow?.querySelector('[data-column-id="model"] .min-w-0')
    ).toHaveTextContent("Sonnet 5");
    expect(
      textModelRow?.querySelector(
        '[data-column-id="model"] [aria-hidden="true"].rounded-full'
      )
    ).not.toBeNull();
    expect(globalThis.document.body).not.toHaveTextContent("No model recorded");
  });
});
