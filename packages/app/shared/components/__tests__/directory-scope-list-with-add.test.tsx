/**
 * ISS-12521: the add control on the directory scope list. A pick resolves to
 * exactly one of four outcomes (AC-001, AC-002), and the control is absent when
 * the host supplies no picker (AC-003).
 *
 * The copy values are slot markers so a test can tell which slot rendered;
 * the component owns no strings.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryScopeEntry } from "../directory-scope-list";
import {
  type AddDirectoryAdapter,
  type AddDirectoryControlCopy,
  AddDirectoryOutcome,
  AddDirectoryStatus,
  DirectoryScopeListWithAdd,
  type PickedDirectory,
  resolveAddDirectoryOutcome,
} from "../directory-scope-list-with-add";
import {
  FIXTURE_INCLUDED_IDS,
  FIXTURE_PICKS,
  FIXTURE_SCOPE_ENTRIES,
  UNWIRED_PICKED_DIRECTORY,
  UNWRITTEN_SCOPE_LIST_COPY,
} from "../directory-scope-list-with-add-fixtures";

const ADD_COPY: AddDirectoryControlCopy = {
  added: "slot:added",
  duplicate: "slot:duplicate",
  protectedFolder: "slot:protected",
  trigger: "slot:trigger",
  unreadable: "slot:unreadable",
};

const ADDED = FIXTURE_PICKS[AddDirectoryOutcome.Added];
const DUPLICATE = FIXTURE_PICKS[AddDirectoryOutcome.Duplicate];
const UNREADABLE = FIXTURE_PICKS[AddDirectoryOutcome.Unreadable];
const PROTECTED = FIXTURE_PICKS[AddDirectoryOutcome.Protected];

function renderWithAdd(
  pickDirectory: AddDirectoryAdapter["pickDirectory"],
  entries: readonly DirectoryScopeEntry[] = FIXTURE_SCOPE_ENTRIES,
  includedIds: readonly string[] = []
) {
  const onAdd = vi.fn();
  const onPickError = vi.fn();
  const onIncludedIdsChange = vi.fn();
  const adapter: AddDirectoryAdapter = {
    copy: ADD_COPY,
    onAdd,
    onPickError,
    pickDirectory,
  };
  const view = render(
    <DirectoryScopeListWithAdd
      add={adapter}
      copy={UNWRITTEN_SCOPE_LIST_COPY}
      entries={entries}
      includedIds={includedIds}
      onIncludedIdsChange={onIncludedIdsChange}
    />
  );
  return { adapter, onAdd, onIncludedIdsChange, onPickError, view };
}

function controlRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>(
    '[data-slot="directory-scope-add"]'
  );
  if (root === null) {
    throw new Error("add control is not rendered");
  }
  return root;
}

function outcomeAlert(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-slot="directory-scope-add-outcome"]'
  );
}

/** Runs `action` and lets the pick's promise chain settle inside `act`. */
async function settle(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function clickAdd() {
  return settle(() => {
    fireEvent.click(screen.getByRole("button", { name: ADD_COPY.trigger }));
  });
}

describe("resolveAddDirectoryOutcome", () => {
  it.each([
    [ADDED, AddDirectoryOutcome.Added],
    // ~/code/orbit-web is nested under ~/code, which FIXTURE_INCLUDED_IDS
    // includes, so inheritance already covers it.
    [DUPLICATE, AddDirectoryOutcome.Duplicate],
    [UNREADABLE, AddDirectoryOutcome.Unreadable],
    [PROTECTED, AddDirectoryOutcome.Protected],
  ])("resolves %o to %s", (picked, expected) => {
    expect(resolveAddDirectoryOutcome(picked, FIXTURE_INCLUDED_IDS)).toBe(
      expected
    );
  });

  it("resolves a listed-but-unselected directory to Added, not Duplicate (design review item 3)", () => {
    // ~/sandbox is a row in FIXTURE_SCOPE_ENTRIES but not in
    // FIXTURE_INCLUDED_IDS: "already selected" would be false if shown here.
    const listedButUnselected: PickedDirectory = {
      ...ADDED,
      id: "~/sandbox",
      label: "~/sandbox",
    };
    expect(
      resolveAddDirectoryOutcome(listedButUnselected, FIXTURE_INCLUDED_IDS)
    ).toBe(AddDirectoryOutcome.Added);
  });

  it("resolves a subfolder of an included parent to Duplicate even when it is not a row yet (design review item 5)", () => {
    const unlistedSubfolder: PickedDirectory = {
      ...ADDED,
      id: "~/code/not-yet-a-row",
      label: "~/code/not-yet-a-row",
    };
    expect(
      resolveAddDirectoryOutcome(unlistedSubfolder, FIXTURE_INCLUDED_IDS)
    ).toBe(AddDirectoryOutcome.Duplicate);
  });

  it("does not treat a sibling path as covered merely by a string prefix match", () => {
    // ~/code-extra shares the "~/code" prefix but is not actually nested
    // under the included ~/code; the check must respect the "/" boundary.
    const sibling: PickedDirectory = {
      ...ADDED,
      id: "~/code-extra",
      label: "~/code-extra",
    };
    expect(resolveAddDirectoryOutcome(sibling, FIXTURE_INCLUDED_IDS)).toBe(
      AddDirectoryOutcome.Added
    );
  });

  it("reports an already-selected directory as duplicate even when it also probes unreadable", () => {
    const selected: PickedDirectory = {
      ...DUPLICATE,
      unreadable: true,
    };
    expect(resolveAddDirectoryOutcome(selected, FIXTURE_INCLUDED_IDS)).toBe(
      AddDirectoryOutcome.Duplicate
    );
  });

  it("reports a protected folder as protected even though it also probes unreadable", () => {
    expect(PROTECTED.unreadable).toBe(true);
    expect(resolveAddDirectoryOutcome(PROTECTED, FIXTURE_INCLUDED_IDS)).toBe(
      AddDirectoryOutcome.Protected
    );
  });

  it("reports protected even when the path is also covered by inclusion (design review round 2, item 1)", () => {
    // Round 1's "duplicate wins over everything" never anticipated this: a
    // TCC folder can never be a row or an included id, so a path-prefix
    // match covering it (here, an included "~") is someone else's inclusion,
    // not evidence this one is selected.
    expect(resolveAddDirectoryOutcome(PROTECTED, ["~"])).toBe(
      AddDirectoryOutcome.Protected
    );
  });

  it("treats differently-cased picks of an included path as covered (design review round 2, item 4)", () => {
    const differentCase: PickedDirectory = {
      ...ADDED,
      id: "~/Code/Orbit-Web",
      label: "~/Code/Orbit-Web",
    };
    expect(
      resolveAddDirectoryOutcome(differentCase, FIXTURE_INCLUDED_IDS)
    ).toBe(AddDirectoryOutcome.Duplicate);
  });
});

describe("DirectoryScopeListWithAdd", () => {
  it("renders no add control when the host supplies no picker (AC-003)", () => {
    render(
      <DirectoryScopeListWithAdd
        copy={UNWRITTEN_SCOPE_LIST_COPY}
        entries={FIXTURE_SCOPE_ENTRIES}
        includedIds={[]}
      />
    );
    expect(
      document.querySelector('[data-slot="directory-scope-add"]')
    ).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("tree")).toBeTruthy();
  });

  it("starts idle with the trigger named by its copy slot", () => {
    renderWithAdd(vi.fn());
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Idle);
    expect(screen.getByRole("button", { name: ADD_COPY.trigger })).toBeTruthy();
  });

  it("adds the picked directory as a newly discovered entry, included (AC-001, design review item 1)", async () => {
    const pickDirectory = vi.fn().mockResolvedValue(ADDED);
    const { onAdd, onIncludedIdsChange } = renderWithAdd(pickDirectory);
    await clickAdd();
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      id: ADDED.id,
      label: ADDED.label,
      newlyDiscovered: true,
    });
    expect(onIncludedIdsChange).toHaveBeenCalledWith([ADDED.id]);
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
    const alert = screen.getByRole("alert");
    expect(alert.dataset.outcome).toBe(AddDirectoryOutcome.Added);
    expect(alert.textContent).toBe(ADD_COPY.added);
    expect(
      document.querySelector('[data-slot="directory-scope-add-announcement"]')
    ).toBeNull();
  });

  it("includes a listed-but-unselected row instead of adding a duplicate (design review item 3)", async () => {
    const picked: PickedDirectory = {
      ...ADDED,
      id: "~/sandbox",
      label: "~/sandbox",
    };
    const { onAdd, onIncludedIdsChange } = renderWithAdd(
      vi.fn().mockResolvedValue(picked),
      FIXTURE_SCOPE_ENTRIES,
      []
    );
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onIncludedIdsChange).toHaveBeenCalledWith(["~/sandbox"]);
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
    expect(screen.getByRole("alert").textContent).toBe(ADD_COPY.added);
  });

  it.each([
    [DUPLICATE, AddDirectoryOutcome.Duplicate, ADD_COPY.duplicate],
    [UNREADABLE, AddDirectoryOutcome.Unreadable, ADD_COPY.unreadable],
    [PROTECTED, AddDirectoryOutcome.Protected, ADD_COPY.protectedFolder],
  ])(
    "refuses %o with its own alert, icon and copy slot, and changes no state (AC-002)",
    async (picked, outcome, copy) => {
      const { onAdd, onIncludedIdsChange } = renderWithAdd(
        vi.fn().mockResolvedValue(picked),
        FIXTURE_SCOPE_ENTRIES,
        FIXTURE_INCLUDED_IDS
      );
      await clickAdd();
      expect(onAdd).not.toHaveBeenCalled();
      expect(onIncludedIdsChange).not.toHaveBeenCalled();
      expect(controlRoot().dataset.state).toBe(outcome);
      const alert = screen.getByRole("alert");
      expect(alert.dataset.outcome).toBe(outcome);
      expect(alert.textContent).toBe(copy);
      expect(
        alert.querySelector(`[data-slot="directory-scope-add-${outcome}-icon"]`)
      ).not.toBeNull();
    }
  );

  it("gives every outcome its own icon, and shares one tone across the two refusals that are equally serious (design review item 7)", async () => {
    const seen = new Map<string, { icon: Element | null; className: string }>();
    for (const [outcome, picked] of [
      [AddDirectoryOutcome.Added, ADDED],
      [AddDirectoryOutcome.Duplicate, DUPLICATE],
      [AddDirectoryOutcome.Unreadable, UNREADABLE],
      [AddDirectoryOutcome.Protected, PROTECTED],
    ] as const) {
      const { view } = renderWithAdd(
        vi.fn().mockResolvedValue(picked),
        FIXTURE_SCOPE_ENTRIES,
        outcome === AddDirectoryOutcome.Duplicate ? FIXTURE_INCLUDED_IDS : []
      );
      await clickAdd();
      const alert = screen.getByRole("alert");
      seen.set(outcome, {
        className: alert.className,
        icon: alert.querySelector(
          `[data-slot="directory-scope-add-${outcome}-icon"]`
        ),
      });
      view.unmount();
    }
    for (const entry of seen.values()) {
      expect(entry.icon).not.toBeNull();
    }
    const iconSlots = [...seen.keys()].map((outcome) =>
      seen.get(outcome)?.icon?.getAttribute("data-slot")
    );
    expect(new Set(iconSlots).size).toBe(4);
    expect(seen.get(AddDirectoryOutcome.Unreadable)?.className).toBe(
      seen.get(AddDirectoryOutcome.Protected)?.className
    );
    expect(seen.get(AddDirectoryOutcome.Duplicate)?.className).not.toBe(
      seen.get(AddDirectoryOutcome.Unreadable)?.className
    );
    expect(seen.get(AddDirectoryOutcome.Added)?.className).not.toBe(
      seen.get(AddDirectoryOutcome.Unreadable)?.className
    );
  });

  it("returns to idle and adds nothing when the picker is cancelled", async () => {
    const { onAdd, onIncludedIdsChange } = renderWithAdd(
      vi.fn().mockResolvedValue(null)
    );
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onIncludedIdsChange).not.toHaveBeenCalled();
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Idle);
    expect(outcomeAlert()).toBeNull();
  });

  it("disables the trigger while the picker is open", async () => {
    let resolvePick: (picked: PickedDirectory | null) => void = () => {
      throw new Error("pick never started");
    };
    const pickDirectory = () =>
      new Promise<PickedDirectory | null>((resolve) => {
        resolvePick = resolve;
      });
    renderWithAdd(pickDirectory);
    await clickAdd();
    const trigger = screen.getByRole("button", { name: ADD_COPY.trigger });
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Picking);
    expect(trigger.hasAttribute("disabled")).toBe(true);
    await settle(() => resolvePick(null));
    expect(trigger.hasAttribute("disabled")).toBe(false);
  });

  it("hands a rejected pick to the host and returns to idle", async () => {
    const failure = new Error("picker unavailable");
    const { onAdd, onPickError } = renderWithAdd(
      vi.fn().mockRejectedValue(failure)
    );
    await clickAdd();
    expect(onPickError).toHaveBeenCalledWith(failure);
    expect(onAdd).not.toHaveBeenCalled();
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Idle);
    expect(outcomeAlert()).toBeNull();
  });

  it("clears the previous refusal when the next pick starts", async () => {
    const pickDirectory = vi
      .fn()
      .mockResolvedValueOnce(UNREADABLE)
      .mockResolvedValueOnce(null);
    renderWithAdd(pickDirectory);
    await clickAdd();
    expect(outcomeAlert()).not.toBeNull();
    await clickAdd();
    expect(outcomeAlert()).toBeNull();
  });

  it("skips onAdd, but still includes, when a row for the path arrives while the picker is open", async () => {
    let resolvePick: (picked: PickedDirectory | null) => void = () => {
      throw new Error("pick never started");
    };
    const pickDirectory = () =>
      new Promise<PickedDirectory | null>((resolve) => {
        resolvePick = resolve;
      });
    const { adapter, onAdd, onIncludedIdsChange, view } =
      renderWithAdd(pickDirectory);
    await clickAdd();
    // Discovery finds ADDED's path and lists it, still unselected, while the
    // picker is open.
    view.rerender(
      <DirectoryScopeListWithAdd
        add={adapter}
        copy={UNWRITTEN_SCOPE_LIST_COPY}
        entries={[
          ...FIXTURE_SCOPE_ENTRIES,
          { id: ADDED.id, label: ADDED.label },
        ]}
        includedIds={[]}
        onIncludedIdsChange={onIncludedIdsChange}
      />
    );
    await settle(() => resolvePick(ADDED));
    expect(onAdd).not.toHaveBeenCalled();
    expect(onIncludedIdsChange).toHaveBeenCalledWith([ADDED.id]);
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
  });

  it("does not clear its own just-set Added alert (regression guard on the staleness fix)", async () => {
    renderWithAdd(vi.fn().mockResolvedValue(ADDED));
    await clickAdd();
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
    expect(screen.getByRole("alert").dataset.outcome).toBe(
      AddDirectoryOutcome.Added
    );
  });

  it("clears a Duplicate alert once the selection it described changes (design review round 2, item 2)", async () => {
    const { adapter, view } = renderWithAdd(
      vi.fn().mockResolvedValue(DUPLICATE),
      FIXTURE_SCOPE_ENTRIES,
      FIXTURE_INCLUDED_IDS
    );
    await clickAdd();
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Duplicate);
    // ~/code gets unticked by some other control, e.g. the tree itself.
    await act(() => {
      view.rerender(
        <DirectoryScopeListWithAdd
          add={adapter}
          copy={UNWRITTEN_SCOPE_LIST_COPY}
          entries={FIXTURE_SCOPE_ENTRIES}
          includedIds={[]}
        />
      );
    });
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Idle);
    expect(outcomeAlert()).toBeNull();
  });

  it("includes the listed row's own id when the pick differs from it only in case", async () => {
    // The row is "~/Code" and the picker hands back "~/code". The lookup folds
    // case, so no second row is created — but `CheckboxTree` resolves ticks
    // with an exact `checkedIds.has(node.id)`, so the id that reaches
    // `includedIds` has to be the ROW's spelling, or the row stays unticked
    // while the alert says the directory was added.
    const entries: readonly DirectoryScopeEntry[] = [
      { id: "~/Code", label: "~/Code" },
    ];
    const picked: PickedDirectory = { ...ADDED, id: "~/code", label: "~/code" };
    const { onAdd, onIncludedIdsChange } = renderWithAdd(
      vi.fn().mockResolvedValue(picked),
      entries,
      []
    );
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onIncludedIdsChange).toHaveBeenCalledWith(["~/Code"]);
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
    expect(screen.getByRole("alert").textContent).toBe(ADD_COPY.added);
  });

  it("includes a nested row's own id when the pick differs from it only in case", async () => {
    const entries: readonly DirectoryScopeEntry[] = [
      {
        id: "~/Code",
        label: "~/Code",
        children: [{ id: "~/Code/Orbit-Web", label: "Orbit-Web" }],
      },
    ];
    const picked: PickedDirectory = {
      ...ADDED,
      id: "~/code/orbit-web",
      label: "~/code/orbit-web",
    };
    const { onAdd, onIncludedIdsChange } = renderWithAdd(
      vi.fn().mockResolvedValue(picked),
      entries,
      []
    );
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onIncludedIdsChange).toHaveBeenCalledWith(["~/Code/Orbit-Web"]);
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
  });

  it("keeps its Added alert when the host stores a copied, reordered, deduped set of the same ids", async () => {
    // A real host persists these ids as a setting, so it normalizes the array
    // the control handed it and renders a NEW one back. Nothing about the
    // selection changed, so the alert must survive; a reference check would
    // clear it the moment it appeared.
    const { adapter, onIncludedIdsChange, view } = renderWithAdd(
      vi.fn().mockResolvedValue(ADDED),
      FIXTURE_SCOPE_ENTRIES,
      ["~/sandbox"]
    );
    await clickAdd();
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
    expect(onIncludedIdsChange).toHaveBeenCalledWith(["~/sandbox", ADDED.id]);
    const stored = [...new Set(["~/sandbox", ADDED.id])].sort();
    // Same paths, a different array in a different order.
    expect(stored).toEqual([ADDED.id, "~/sandbox"]);
    await act(() => {
      view.rerender(
        <DirectoryScopeListWithAdd
          add={adapter}
          copy={UNWRITTEN_SCOPE_LIST_COPY}
          entries={FIXTURE_SCOPE_ENTRIES}
          includedIds={stored}
          onIncludedIdsChange={onIncludedIdsChange}
        />
      );
    });
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Added);
    expect(screen.getByRole("alert").dataset.outcome).toBe(
      AddDirectoryOutcome.Added
    );
  });

  it("checks for a duplicate against the selection as it is when the pick resolves", async () => {
    let resolvePick: (picked: PickedDirectory | null) => void = () => {
      throw new Error("pick never started");
    };
    const pickDirectory = () =>
      new Promise<PickedDirectory | null>((resolve) => {
        resolvePick = resolve;
      });
    const { adapter, onAdd, onIncludedIdsChange, view } = renderWithAdd(
      pickDirectory,
      FIXTURE_SCOPE_ENTRIES,
      []
    );
    await clickAdd();
    // ADDED's path becomes selected by some other means while the picker is
    // open (e.g. the user checked it directly in the tree).
    view.rerender(
      <DirectoryScopeListWithAdd
        add={adapter}
        copy={UNWRITTEN_SCOPE_LIST_COPY}
        entries={FIXTURE_SCOPE_ENTRIES}
        includedIds={[ADDED.id]}
        onIncludedIdsChange={onIncludedIdsChange}
      />
    );
    await settle(() => resolvePick(ADDED));
    expect(onAdd).not.toHaveBeenCalled();
    expect(onIncludedIdsChange).not.toHaveBeenCalled();
    expect(controlRoot().dataset.state).toBe(AddDirectoryStatus.Duplicate);
  });
});

describe("unwired register", () => {
  it("names an owning ticket for every picked-directory field", () => {
    for (const datum of Object.values(UNWIRED_PICKED_DIRECTORY)) {
      expect(datum.ownedBy).toMatch(TICKET_SLUG);
    }
  });

  it("is supplied by every fixture pick", () => {
    const fields = Object.keys(UNWIRED_PICKED_DIRECTORY).sort();
    for (const picked of Object.values(FIXTURE_PICKS)) {
      expect(Object.keys(picked).sort()).toEqual(fields);
    }
  });
});

const TICKET_SLUG = /^ISS-\d+$/;
