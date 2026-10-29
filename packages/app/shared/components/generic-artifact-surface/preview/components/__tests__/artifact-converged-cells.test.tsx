// @vitest-environment jsdom

/**
 * ISS-6385: the converged cells actually render the SHARED treatment.
 *
 * The convergence is mostly a deletion — a third tag-colour palette, a
 * re-implemented inline editor, a raw `<input type="date">`. A deletion diff
 * proves nothing on its own: "the old thing is gone" is equally satisfied by a
 * cell that renders nothing at all. These are the positive half, asserting on
 * locators only the shared components can emit, so a revert to a
 * prototype-local control fails here rather than passing quietly.
 *
 * Plain DOM assertions, no jest-dom: the sandbox's jsdom setup deliberately
 * ships polyfills only (see `vitest.setup.dom.ts`).
 */

import { TAG_COLOR_PALETTE } from "@repo/app/shared/components/tag-color-picker";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { genericArtifacts } from "../../fixtures";
import { CustomFieldCell } from "../artifact-custom-field-cell";
import { EditableTagsCell } from "../artifact-list-custom-cells";
import {
  INITIAL_TAG_DEFINITIONS,
  TagEditorContext,
} from "../artifact-list-model";

const ARTIFACT = genericArtifacts[0];

/**
 * `CustomFieldCell` shows its empty state for a row whose trailing id digit is
 * divisible by three, so the empty case is asked for by picking that row rather
 * than by reaching past the component.
 */
const EMPTY_STATE_ARTIFACT = genericArtifacts.find(
  (artifact) => Number(artifact.id.split("-").at(-1)) % 3 === 0
);

const DATE_FIELD = {
  id: "target",
  label: "Target date",
  type: "Date",
} as const;
const TEXT_FIELD = { id: "notes", label: "Notes", type: "Text" } as const;
const TIME_FIELD = { id: "slot", label: "Slot", type: "Time" } as const;
const SINGLE_SELECT_FIELD: CustomFieldDefinition = {
  id: "team",
  label: "Team",
  optionColors: [],
  options: ["Infra", "UX"],
  type: "Single-select",
};
const MULTI_SELECT_FIELD: CustomFieldDefinition = {
  id: "areas",
  label: "Areas",
  optionColors: [],
  options: ["Infra", "UX"],
  type: "Multi-select",
};

/** Hoisted per Ultracite's useTopLevelRegex rule. */
const EDIT_TARGET_DATE = /Edit Target date/i;
const NOTES_LABEL = /Notes/i;
const EDIT_SLOT = /Edit Slot/i;
const EDIT_TAGS_LABEL = /Edit tags, currently Design, Platform/;
const NAMES_A_FIELD = /^(Edit|Set) (Team|Areas)\b/;
const NAMES_NO_FIELD = /^(Edit|Set) values?\b/;
const BG_HUE_UTILITY = /^bg-[a-z]+-\d+/;

describe("converged custom-field cells", () => {
  it("edits a date through the design-system popover, not a native date input", () => {
    const { container } = render(
      <CustomFieldCell
        artifact={ARTIFACT}
        field={DATE_FIELD}
        referenceArtifacts={genericArtifacts}
      />
    );

    // `InlineDateCell`'s trigger names what it dates (WCAG 2.4.6) and carries
    // Radix's popover semantics. A native `<input type="date">` — what this
    // cell used to render — has neither.
    const trigger = screen.getByRole("button", { name: EDIT_TARGET_DATE });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it("renders no value as the shared empty sentinel, inside a named control", () => {
    expect(EMPTY_STATE_ARTIFACT).toBeDefined();
    const { container } = render(
      <CustomFieldCell
        artifact={EMPTY_STATE_ARTIFACT as (typeof genericArtifacts)[number]}
        field={TEXT_FIELD}
        referenceArtifacts={genericArtifacts}
      />
    );

    // `GridEmptyValue`'s stable slot, which the prototype's own
    // `EmptyCustomValue` never emitted. The assertion is on the RENDERED
    // sentinel: `isEmptyCellValue` reads a cell's top-level element type, and
    // this cell hands a card `<CustomFieldCell>`, so no card-drop is claimed.
    expect(container.querySelector('[data-slot="grid-empty-value"]')).not.toBe(
      null
    );
    expect(screen.getByRole("button", { name: NOTES_LABEL })).toBeTruthy();
  });

  it("keeps the empty-state affordance on Time, the one type the shared cell refuses", () => {
    // `InlineScalarCell` declines `time` on purpose, so this field keeps a local
    // editor — and an earlier cut of this refactor silently shipped it without
    // the click-to-edit empty state and Escape-cancel every sibling has. The
    // control, not the raw input, is what proves the affordance survived.
    const { container } = render(
      <CustomFieldCell
        artifact={EMPTY_STATE_ARTIFACT as (typeof genericArtifacts)[number]}
        field={TIME_FIELD}
        referenceArtifacts={genericArtifacts}
      />
    );

    expect(screen.getByRole("button", { name: EDIT_SLOT })).toBeTruthy();
    expect(container.querySelector('input[type="time"]')).toBeNull();
  });

  it.each([
    ["Single-select", SINGLE_SELECT_FIELD],
    ["Multi-select", MULTI_SELECT_FIELD],
  ])('names the %s trigger for the field, not for "value"', (_type, field) => {
    render(
      <CustomFieldCell
        artifact={ARTIFACT}
        field={field}
        referenceArtifacts={genericArtifacts}
      />
    );

    // "Edit value, currently Infra" is the exact name the shared cell exists
    // to stop: a trigger that does not say what it sets (WCAG 2.4.6). The
    // field's own label is in `CustomFieldCell`'s hand, so it is threaded.
    expect(screen.getByRole("button", { name: NAMES_A_FIELD })).toBeTruthy();
    expect(screen.queryByRole("button", { name: NAMES_NO_FIELD })).toBe(null);
  });
});

describe("converged tag cell", () => {
  it("renders applied tags with colours drawn only from the canonical palette", () => {
    // The real mount supplies the tag definitions through this context
    // (`ArtifactListShell` does), and the colour of an applied tag is looked up
    // there — so the provider is the production path, not test scaffolding.
    const { container } = render(
      <TagEditorContext.Provider
        value={{
          createTag: () => undefined,
          definitions: INITIAL_TAG_DEFINITIONS,
          setTagColor: () => undefined,
        }}
      >
        <EditableTagsCell initialTags={["Design", "Platform"]} />
      </TagEditorContext.Provider>
    );

    expect(screen.getByRole("button", { name: EDIT_TAGS_LABEL })).toBeTruthy();

    // Assert the SET, not one member: a chip that fell back to a single colour
    // for every tag would satisfy a spot-check of one name. Any `bg-<hue>-`
    // utility the cell renders must name a canonical tag colour — the deleted
    // third palette drew `bg-fuchsia-400`, `bg-slate-400` and `bg-amber-400`
    // for `magenta`, `cool-gray` and `yellow-orange`, none of which are.
    const canonicalHues = new Set(
      TAG_COLOR_PALETTE.map((swatch) => swatch.name as string)
    );
    const hues = [...container.querySelectorAll("*")]
      .flatMap((element) => [...element.classList])
      .filter((name) => BG_HUE_UTILITY.test(name))
      .map((name) => name.split("-")[1] as string);

    expect(hues.filter((hue) => !canonicalHues.has(hue))).toEqual([]);
    // Membership alone is not enough: a `tagColorFor` that returned
    // `TAG_COLOR_PALETTE[0]` for every tag — the single-colour fallback this
    // test exists to catch — draws only canonical hues and would pass it.
    // The two seeded tags hold different colours in INITIAL_TAG_DEFINITIONS.
    expect(new Set(hues).size).toBeGreaterThan(1);
  });
});
