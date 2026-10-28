// @vitest-environment jsdom

/**
 * PRD-722 (ISS-9349): `EditableTagsCell` is a thin adapter over the open-list
 * tag champion, `InlineTagCell`. What these cases pin is what the adapter
 * still owns (the canonical tag colours, the create-then-colour flow through
 * the tag editor context, the words) and that each capability the hand-rolled
 * popover had survives the move: filter, toggle, remove from a chip, create
 * only a new label, colour a created one. The trigger's name, the empty state
 * and the option role are now the champion's.
 */

import { tagChipClassName } from "@repo/app/shared/components/tag-chip";
import {
  pickTagColorLabel,
  TAG_COLOR_PALETTE,
} from "@repo/app/shared/components/tag-color-picker";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableTagsCell } from "../artifact-list-custom-cells";
import {
  INITIAL_TAG_DEFINITIONS,
  type TagDefinition,
  TagEditorContext,
} from "../artifact-list-model";

const SEARCH_LABEL = "Search or create tags";
const EMPTY_HINT = "Type to find or create a tag";
const CREATE_NOVEL = /Create tag “Novel”/;
const CREATE_ANY = /^Create tag/;
// The trigger is the champion's (PRD-722): named for the set it holds, or for
// the action when it holds none.
const EDIT_TAGS_TRIGGER = /^(Edit|Set) tags/;

function renderTags({
  definitions = INITIAL_TAG_DEFINITIONS,
  initialTags = [],
  withContext = true,
}: {
  definitions?: TagDefinition[];
  initialTags?: readonly string[];
  withContext?: boolean;
} = {}) {
  const onChange = vi.fn();
  const createTag = vi.fn();
  const setTagColor = vi.fn();
  const cell = (
    <EditableTagsCell initialTags={initialTags} onChange={onChange} />
  );
  const result = render(
    withContext ? (
      <TagEditorContext.Provider
        value={{ createTag, definitions, setTagColor }}
      >
        {cell}
      </TagEditorContext.Provider>
    ) : (
      cell
    )
  );
  return { createTag, onChange, result, setTagColor };
}

function trigger() {
  return screen.getByRole("button", { name: EDIT_TAGS_TRIGGER });
}

function openEditor() {
  fireEvent.click(trigger());
  return screen.getByRole("combobox", { name: SEARCH_LABEL });
}

/** The champion dispatches each commit a microtask after the pick. */
async function flushCommits() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function popover() {
  return screen.getByRole("dialog");
}

/** Enter chooses the highlighted item: the first match, or the create action. */
function submitQuery(input: HTMLElement) {
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("EditableTagsCell trigger", () => {
  it("names the applied tags, or the action when there are none", () => {
    renderTags({ initialTags: ["Design", "UX"] });
    renderTags();

    expect(
      screen.getByRole("button", { name: "Edit tags, currently Design, UX" })
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Set tags" })
        .querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("follows a changed initialTags prop", () => {
    // Same tree shape on rerender, so the cell updates in place rather than remounting.
    const { result } = renderTags({
      initialTags: ["Design"],
      withContext: false,
    });

    result.rerender(
      <EditableTagsCell initialTags={["Platform"]} onChange={vi.fn()} />
    );

    expect(trigger()).toHaveAccessibleName("Edit tags, currently Platform");
  });
});

describe("EditableTagsCell picker", () => {
  it("prompts with a placeholder while no tag is applied", () => {
    renderTags();
    expect(openEditor()).toHaveAttribute(
      "placeholder",
      "Search or create tag…"
    );
    expect(within(popover()).queryByText(EMPTY_HINT)).toBeNull();
  });

  // ISS-12938 visual QA: the applied chips sit in their own header row, so
  // the search row keeps its prompt and takes focus ahead of their remove
  // buttons; typed text then reaches the search box, not a highlighted option.
  it("keeps the prompt and the focus on the search box once a tag is applied", async () => {
    renderTags({ initialTags: ["Design"] });
    const search = openEditor();
    await waitFor(() => expect(search).toHaveFocus());
    expect(search).toHaveAttribute("placeholder", "Search or create tag…");
  });

  it("toggles a definition on and off and marks the selected one", async () => {
    const { onChange } = renderTags({ initialTags: ["UX"] });
    openEditor();

    const design = within(popover()).getByRole("option", { name: "Design" });
    expect(design).toHaveAttribute("aria-checked", "false");
    fireEvent.click(design);
    await flushCommits();
    expect(onChange).toHaveBeenLastCalledWith(["UX", "Design"]);
    expect(
      within(popover()).getByRole("option", { name: "Design" })
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(popover()).getByRole("option", { name: "UX" }));
    await flushCommits();
    expect(onChange).toHaveBeenLastCalledWith(["Design"]);
    expect(trigger()).toHaveAccessibleName("Edit tags, currently Design");
  });

  it("filters definitions case-insensitively and clears the query on pick", () => {
    renderTags();
    const input = openEditor();

    fireEvent.change(input, { target: { value: "DES" } });

    expect(
      within(popover()).queryByRole("option", { name: "Platform" })
    ).toBeNull();
    expect(
      within(popover()).getByRole("option", { name: "Design system" })
    ).toBeInTheDocument();

    fireEvent.click(within(popover()).getByRole("option", { name: "Design" }));
    expect(input).toHaveValue("");
  });

  it("offers Create only when no definition matches exactly", () => {
    renderTags();
    const input = openEditor();

    fireEvent.change(input, { target: { value: "  Novel " } });
    expect(
      within(popover()).getByRole("option", { name: CREATE_ANY })
    ).toHaveAccessibleName("Create tag “Novel”");

    fireEvent.change(input, { target: { value: "design" } });
    expect(
      within(popover()).queryByRole("option", { name: CREATE_ANY })
    ).toBeNull();
  });

  it("removes an applied tag from its chip", async () => {
    const { onChange } = renderTags({ initialTags: ["Design", "UX"] });
    openEditor();

    fireEvent.click(screen.getByRole("button", { name: "Remove Design" }));
    await flushCommits();

    expect(onChange).toHaveBeenLastCalledWith(["UX"]);
    expect(trigger()).toHaveAccessibleName("Edit tags, currently UX");
  });

  it("draws an undefined tag in the first canonical colour", () => {
    renderTags({ initialTags: ["Legacy"] });
    openEditor();

    const chip = screen.getByRole("button", {
      name: "Remove Legacy",
    }).parentElement;
    for (const token of tagChipClassName(TAG_COLOR_PALETTE[0].name).split(
      " "
    )) {
      expect(chip).toHaveClass(token);
    }
  });

  it("shows the empty hint when no definitions exist and nothing is typed", () => {
    renderTags({ definitions: [] });
    const input = openEditor();

    expect(within(popover()).getByText(EMPTY_HINT)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Novel" } });
    expect(within(popover()).queryByText(EMPTY_HINT)).toBeNull();
    expect(
      within(popover()).getByRole("option", { name: CREATE_NOVEL })
    ).toBeInTheDocument();
  });
});

describe("EditableTagsCell create flow", () => {
  it("creates a trimmed tag, applies it, then colours it from the swatch grid", async () => {
    const { createTag, onChange, setTagColor } = renderTags({
      initialTags: ["UX"],
    });
    const input = openEditor();

    fireEvent.change(input, { target: { value: "  Novel " } });
    fireEvent.click(
      within(popover()).getByRole("option", { name: CREATE_NOVEL })
    );
    await flushCommits();

    expect(createTag).toHaveBeenCalledWith("Novel");
    expect(onChange).toHaveBeenLastCalledWith(["UX", "Novel"]);
    expect(input).toHaveValue("");
    expect(
      within(popover()).getByText(pickTagColorLabel("Novel"))
    ).toBeInTheDocument();
    // The ring is the swatch grid's only selected-state signal; a label with no
    // definition yet preselects the first canonical colour.
    expect(
      within(popover()).getByRole("button", { name: TAG_COLOR_PALETTE[0].name })
    ).toHaveClass("ring-2");
    expect(
      within(popover()).getByRole("button", { name: TAG_COLOR_PALETTE[1].name })
    ).not.toHaveClass("ring-2");

    const swatch = TAG_COLOR_PALETTE[3].name;
    fireEvent.click(within(popover()).getByRole("button", { name: swatch }));

    expect(setTagColor).toHaveBeenCalledWith("Novel", swatch);
    expect(within(popover()).queryByText(pickTagColorLabel("Novel"))).toBe(
      null
    );
  });

  it("offers no create for a label already applied, and Enter toggles it", async () => {
    const { createTag, onChange } = renderTags({ initialTags: ["Legacy"] });
    const input = openEditor();

    fireEvent.change(input, { target: { value: "Legacy" } });
    expect(
      within(popover()).queryByRole("option", { name: CREATE_ANY })
    ).toBeNull();
    submitQuery(input);
    await flushCommits();

    expect(createTag).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("creates without a tag editor context and still leaves the picker", async () => {
    const { onChange } = renderTags({ withContext: false });
    const input = openEditor();

    fireEvent.change(input, { target: { value: "Novel" } });
    submitQuery(input);
    await flushCommits();
    expect(onChange).toHaveBeenLastCalledWith(["Novel"]);

    fireEvent.click(
      within(popover()).getByRole("button", {
        name: TAG_COLOR_PALETTE[0].name,
      })
    );
    expect(within(popover()).queryByText(pickTagColorLabel("Novel"))).toBe(
      null
    );
    expect(
      within(popover()).getByRole("option", { name: "Design" })
    ).toBeInTheDocument();
  });

  it("forgets a pending colour pick and the query when the popover closes", () => {
    renderTags();
    const input = openEditor();
    fireEvent.change(input, { target: { value: "Novel" } });
    submitQuery(input);
    expect(
      within(popover()).getByText(pickTagColorLabel("Novel"))
    ).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    const reopened = openEditor();
    expect(reopened).toHaveValue("");
    expect(within(popover()).queryByText(pickTagColorLabel("Novel"))).toBe(
      null
    );
  });
});

describe("EditableTagsCell submit", () => {
  it("applies the first matching definition on Enter", async () => {
    const { createTag, onChange } = renderTags();
    const input = openEditor();

    fireEvent.change(input, { target: { value: "plat" } });
    submitQuery(input);
    await flushCommits();

    expect(onChange).toHaveBeenLastCalledWith(["Platform"]);
    expect(createTag).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("does nothing on an empty Enter with no definitions", async () => {
    const { createTag, onChange } = renderTags({ definitions: [] });
    const input = openEditor();

    submitQuery(input);
    await flushCommits();

    expect(onChange).not.toHaveBeenCalled();
    expect(createTag).not.toHaveBeenCalled();
    expect(within(popover()).getByText(EMPTY_HINT)).toBeInTheDocument();
  });
});

describe("EditableTagsCell edge inputs", () => {
  it("edits every way without an onChange listener", async () => {
    render(<EditableTagsCell initialTags={["UX"]} />);
    const input = openEditor();

    fireEvent.click(within(popover()).getByRole("option", { name: "Design" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove UX" }));
    fireEvent.change(input, { target: { value: "plat" } });
    submitQuery(input);
    fireEvent.change(input, { target: { value: "Novel" } });
    submitQuery(input);
    await flushCommits();

    expect(trigger()).toHaveAccessibleName(
      "Edit tags, currently Design, Platform, Novel"
    );
  });

  it("trims the query before matching definitions", () => {
    renderTags();
    const input = openEditor();

    fireEvent.change(input, { target: { value: "  plat  " } });
    expect(
      within(popover()).getByRole("option", { name: "Platform" })
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "  design  " } });
    expect(
      within(popover()).queryByRole("option", { name: CREATE_ANY })
    ).toBeNull();
  });

  it("treats a whitespace query as no query", () => {
    renderTags({ definitions: [] });
    const input = openEditor();

    fireEvent.change(input, { target: { value: "   " } });

    expect(within(popover()).getByText(EMPTY_HINT)).toBeInTheDocument();
    expect(
      within(popover()).queryByRole("option", { name: CREATE_ANY })
    ).toBeNull();
  });

  it("draws an applied tag in its own defined colour", () => {
    renderTags({ initialTags: ["Design"] });
    openEditor();
    const design = INITIAL_TAG_DEFINITIONS.find(
      (definition) => definition.label === "Design"
    );
    if (!design) {
      throw new Error("Design is not a seeded tag");
    }
    const [designBg] = tagChipClassName(design.color).split(" ");
    const [fallbackBg] = tagChipClassName(TAG_COLOR_PALETTE[0].name).split(" ");

    const chip = screen.getByRole("button", {
      name: "Remove Design",
    }).parentElement;
    expect(designBg).not.toBe(fallbackBg);
    expect(chip).toHaveClass(designBg ?? "");
    expect(chip).not.toHaveClass(fallbackBg ?? "");
  });
});
