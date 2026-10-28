/**
 * ISS-12520 — `DirectoryScopeList`: every row state the data-control flows
 * need (AC-001), inherited selection through the CheckboxTree contract
 * (AC-002), and ISS-11914 automatic exclusions drawn read-only (AC-003).
 *
 * Expectations are written out by hand from the fixture. The copy below is
 * test-only wording; the component owns no strings.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type AutoExcludedDirectory,
  type DirectoryScopeEntry,
  DirectoryScopeList,
  type DirectoryScopeListCopy,
} from "../directory-scope-list";

const COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: "Fixture: excluded automatically",
  autoExcludedReason: "Fixture: protected by macOS",
  empty: "Fixture: nothing found",
  newlyDiscovered: "Fixture-new",
  noSelection: "Fixture: nothing included",
  treeLabel: "Fixture directories",
  unavailable: "Fixture-offline",
  unavailableReason: "Fixture: not reachable",
};

const ENTRIES: readonly DirectoryScopeEntry[] = [
  {
    id: "~/code",
    label: "~/code",
    children: [
      { id: "~/code/orbit-api", label: "orbit-api" },
      { id: "~/code/orbit-web", label: "orbit-web" },
      {
        id: "~/code/orbit-docs",
        label: "orbit-docs",
        newlyDiscovered: true,
      },
    ],
  },
  { id: "~/sandbox", label: "~/sandbox", newlyDiscovered: true },
  {
    id: "/Volumes/scratch/lab",
    label: "/Volumes/scratch/lab",
    unavailable: true,
  },
];

const AUTO_EXCLUDED: readonly AutoExcludedDirectory[] = [
  { id: "~/Documents", label: "~/Documents" },
];

const ALL_OPEN = ["~/code"];

/** An unavailable row is named by its label, its badge and its reason. */
const LAB_NAME = "/Volumes/scratch/lab Fixture-offline Fixture: not reachable";

function renderList(
  includedIds: readonly string[],
  overrides: Partial<Parameters<typeof DirectoryScopeList>[0]> = {}
) {
  const onIncludedIdsChange = vi.fn();
  render(
    <DirectoryScopeList
      autoExcluded={AUTO_EXCLUDED}
      copy={COPY}
      defaultExpandedIds={ALL_OPEN}
      entries={ENTRIES}
      includedIds={includedIds}
      onIncludedIdsChange={onIncludedIdsChange}
      {...overrides}
    />
  );
  return onIncludedIdsChange;
}

function userTree() {
  return screen.getByRole("tree", { name: "Fixture directories" });
}

function row(name: string | RegExp) {
  return within(userTree()).getByRole("treeitem", { name });
}

describe("DirectoryScopeList row states (AC-001)", () => {
  it("draws an included row checked and an excluded row unchecked", () => {
    renderList(["~/code/orbit-api"]);
    expect(row("orbit-api")).toHaveAttribute("aria-checked", "true");
    expect(row("orbit-web")).toHaveAttribute("aria-checked", "false");
    expect(row("~/code")).toHaveAttribute("aria-checked", "mixed");
  });

  it("names a newly discovered row with its badge and leaves it excluded", () => {
    renderList(["~/code/orbit-api"]);
    const sandbox = row("~/sandbox Fixture-new");
    expect(sandbox).toHaveAttribute("aria-checked", "false");
    expect(sandbox).not.toHaveAttribute("aria-disabled");
    expect(row("orbit-api")).toBeInTheDocument();
  });

  it("marks an unavailable row with its badge and reason, without locking it", () => {
    renderList(["~/code/orbit-api"]);
    const lab = row(LAB_NAME);
    expect(lab).not.toHaveAttribute("aria-disabled");
    expect(lab).not.toHaveAttribute("data-readonly");
  });

  it("lets an included unavailable row be unchecked directly", () => {
    const onChange = renderList(["/Volumes/scratch/lab", "~/sandbox"]);
    fireEvent.click(row(LAB_NAME));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(["~/sandbox"]);
  });

  it("revokes an offline child along with its unchecked parent", () => {
    // Marisol's review scenario on #8841: ~/client-work included, quill offline.
    // Unchecking the parent must not write quill back into the set.
    const onChange = renderList(["~/client-work"], {
      defaultExpandedIds: ["~/client-work"],
      entries: [
        {
          id: "~/client-work",
          label: "~/client-work",
          children: [
            { id: "~/client-work/harbor", label: "harbor" },
            {
              id: "~/client-work/quill",
              label: "quill",
              unavailable: true,
            },
          ],
        },
      ],
    });
    fireEvent.click(row("~/client-work"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted: string[] = onChange.mock.calls[0][0];
    expect(emitted).not.toContain("~/client-work/quill");
    expect(emitted).not.toContain("~/client-work");
  });

  it("shows the empty copy and no tree when there are no directories", () => {
    renderList([], { autoExcluded: [], entries: [] });
    expect(screen.getByText("Fixture: nothing found")).toBeInTheDocument();
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.queryByText(COPY.noSelection)).toBeNull();
  });

  it("announces no selection only while nothing is included", () => {
    renderList([]);
    expect(screen.getByRole("status")).toHaveTextContent(COPY.noSelection);
  });

  it("hides the no-selection notice once something is included", () => {
    renderList(["~/sandbox"]);
    expect(screen.queryByText(COPY.noSelection)).toBeNull();
  });

  it("keeps the status region mounted while something is included", () => {
    renderList(["~/sandbox"]);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces no selection when the selection names only a protected folder", () => {
    renderList(["~/Documents"]);
    expect(screen.getByRole("status")).toHaveTextContent(COPY.noSelection);
  });

  it("counts an id the list cannot show as a selection", () => {
    renderList(["~/gone"]);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("DirectoryScopeList inheritance (AC-002)", () => {
  it("draws every child of an included parent as included", () => {
    renderList(["~/code"]);
    expect(row("orbit-api")).toHaveAttribute("aria-checked", "true");
    expect(row("orbit-docs Fixture-new")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(row("~/code")).toHaveAttribute("aria-checked", "true");
  });

  it("overrides one inherited child by demoting the parent to its siblings", () => {
    const onChange = renderList(["~/code", "~/gone"]);
    fireEvent.click(row("orbit-web"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...onChange.mock.calls[0][0]].sort()).toEqual([
      "~/code/orbit-api",
      "~/code/orbit-docs",
      "~/gone",
    ]);
  });

  it("records a parent click as the parent id, unknown ids carried through", () => {
    const onChange = renderList(["~/gone"]);
    fireEvent.click(row("~/code"));
    expect([...onChange.mock.calls[0][0]].sort()).toEqual(["~/code", "~/gone"]);
  });
});

describe("DirectoryScopeList automatic exclusions (AC-003)", () => {
  function autoTree() {
    return screen.getByRole("tree", {
      name: "Fixture: excluded automatically",
    });
  }

  it("draws protected folders read-only, excluded, with the reason", () => {
    renderList([]);
    const documents = within(autoTree()).getByRole("treeitem", {
      name: "~/Documents",
    });
    expect(documents).toHaveAttribute("aria-checked", "false");
    expect(documents).toHaveAttribute("data-readonly");
    expect(documents).toHaveAccessibleDescription(
      "Fixture: protected by macOS"
    );
  });

  it("never lets a click change a protected folder", () => {
    const onChange = renderList([]);
    fireEvent.click(
      within(autoTree()).getByRole("treeitem", { name: "~/Documents" })
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a protected folder excluded even when the selection names it", () => {
    renderList(["~/Documents", "~"]);
    expect(
      within(autoTree()).getByRole("treeitem", { name: "~/Documents" })
    ).toHaveAttribute("aria-checked", "false");
  });

  it("keeps protected folders out of the user tree", () => {
    renderList([]);
    expect(
      within(userTree()).queryByRole("treeitem", { name: "~/Documents" })
    ).toBeNull();
  });
});

describe("DirectoryScopeList read-only (ISS-12531)", () => {
  const READ_ONLY_REASON = "Fixture: set on the device";

  it("locks every row and says why on each top-level row", () => {
    renderList(["~/code"], { readOnlyReason: READ_ONLY_REASON });
    for (const name of ["~/code", "orbit-api", "orbit-docs Fixture-new"]) {
      expect(row(name)).toHaveAttribute("data-readonly");
    }
    expect(row("~/code")).toHaveAccessibleDescription(READ_ONLY_REASON);
    expect(row(LAB_NAME)).toHaveAttribute("data-readonly");
    expect(screen.getAllByText(READ_ONLY_REASON)).toHaveLength(3);
  });

  it("never emits a toggle, keeping the reported selection as drawn", () => {
    const onChange = renderList(["~/code"], {
      readOnlyReason: READ_ONLY_REASON,
    });
    fireEvent.click(row("~/code"));
    fireEvent.click(row("orbit-api"));
    fireEvent.click(row("~/sandbox Fixture-new"));
    fireEvent.keyDown(row("~/sandbox Fixture-new"), { key: " " });
    expect(onChange).not.toHaveBeenCalled();
    expect(row("~/code")).toHaveAttribute("aria-checked", "true");
    expect(row("orbit-api")).toHaveAttribute("aria-checked", "true");
    expect(row("~/sandbox Fixture-new")).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("leaves an editable list unlocked when no reason is given", () => {
    renderList(["~/code"]);
    expect(row("~/code")).not.toHaveAttribute("data-readonly");
    expect(screen.queryByText(READ_ONLY_REASON)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n "],
  ])(
    "treats an %s reason as unset: no lock, no blank reason row, toggles still emit",
    (_kind, reason) => {
      const onChange = renderList(["~/code"], { readOnlyReason: reason });
      for (const name of ["~/code", "orbit-api", "~/sandbox Fixture-new"]) {
        expect(row(name)).not.toHaveAttribute("data-readonly");
      }
      expect(row("~/code")).not.toHaveAccessibleDescription();
      fireEvent.click(row("~/sandbox Fixture-new"));
      expect(onChange).toHaveBeenCalledTimes(1);
    }
  );
});
