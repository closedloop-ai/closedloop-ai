/**
 * ISS-12517 — `CheckboxTree`: tri-state derivation, the toggle rule, the
 * WAI-ARIA APG tree keys, and locked rows.
 *
 * Every expectation below is written out by hand from the fixture, never derived
 * from the module under test, and every focus assertion names WHICH row holds
 * focus — each destination differs from the other rows reachable from the same
 * origin, so a key that resolves to the wrong neighbour is red.
 */

import {
  CheckboxTree,
  type CheckboxTreeNode,
  type CheckboxTreeProps,
} from "@closedloop-ai/design-system/components/ui/checkbox-tree";
import { toggleCheckboxTreeNode } from "@closedloop-ai/design-system/lib/checkbox-tree";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const NODES: readonly CheckboxTreeNode[] = [
  {
    id: "acme-web",
    label: "~/code/acme-web",
    children: [
      {
        id: "src",
        label: "src",
        children: [
          { id: "app", label: "app.ts" },
          { id: "util", label: "util.ts" },
        ],
      },
      { id: "readme", label: "README.md" },
      {
        id: "secrets",
        label: ".secrets",
        readOnly: true,
        reason: "Fixture reason: locked by policy",
      },
    ],
  },
  {
    id: "archive",
    label: "~/code/archive",
    disabled: true,
    reason: "Fixture reason: not connected",
  },
  {
    id: "vendor",
    label: "~/vendor",
    readOnly: true,
    reason: "Fixture reason: vendored",
    children: [{ id: "vendor-lib", label: "lib" }],
  },
  { id: "notes", label: "~/notes" },
];

function item(name: string): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

function renderTree(
  props: Pick<
    CheckboxTreeProps,
    "defaultCheckedIds" | "defaultExpandedIds"
  > = {}
) {
  const onCheckedChange = vi.fn();
  render(
    <CheckboxTree
      aria-label="Fixture tree"
      nodes={NODES}
      onCheckedChange={onCheckedChange}
      {...props}
    />
  );
  return { onCheckedChange };
}

describe("CheckboxTree tri-state", () => {
  it("derives mixed up the lineage from one checked leaf", () => {
    renderTree({
      defaultCheckedIds: ["app"],
      defaultExpandedIds: ["acme-web", "src"],
    });
    expect(item("app.ts")).toHaveAttribute("aria-checked", "true");
    expect(item("util.ts")).toHaveAttribute("aria-checked", "false");
    expect(item("src")).toHaveAttribute("aria-checked", "mixed");
    expect(item("~/code/acme-web")).toHaveAttribute("aria-checked", "mixed");
    expect(item("~/notes")).toHaveAttribute("aria-checked", "false");
  });

  it("inherits a checked parent id down to every descendant", () => {
    renderTree({
      defaultCheckedIds: ["src"],
      defaultExpandedIds: ["acme-web", "src"],
    });
    expect(item("app.ts")).toHaveAttribute("aria-checked", "true");
    expect(item("util.ts")).toHaveAttribute("aria-checked", "true");
    expect(item("src")).toHaveAttribute("aria-checked", "true");
    expect(item("~/code/acme-web")).toHaveAttribute("aria-checked", "mixed");
  });

  it("checks a mixed parent's unlocked subtree, then clears it although a locked row keeps it mixed", () => {
    const { onCheckedChange } = renderTree({ defaultCheckedIds: ["app"] });
    const parent = item("~/code/acme-web");

    fireEvent.keyDown(parent, { key: " " });
    // `.secrets` would be checked by `acme-web`, so the widest ids that leave
    // it alone are written: `src` (which absorbs `app`) and `readme`.
    expect(onCheckedChange).toHaveBeenLastCalledWith(["src", "readme"]);
    // `.secrets` is read-only and unchecked, so the parent stays mixed.
    expect(parent).toHaveAttribute("aria-checked", "mixed");

    fireEvent.keyDown(parent, { key: " " });
    expect(onCheckedChange).toHaveBeenLastCalledWith([]);
    expect(parent).toHaveAttribute("aria-checked", "false");
  });
});

describe("CheckboxTree keyboard (WAI-ARIA APG tree)", () => {
  it("opens, enters, leaves and closes with the arrows and jumps with Home/End", () => {
    renderTree();
    const root = item("~/code/acme-web");
    act(() => root.focus());
    expect(root).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(root).toHaveAttribute("aria-expanded", "true");
    expect(root).toHaveFocus();

    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(item("src")).toHaveFocus();

    fireEvent.keyDown(item("src"), { key: "ArrowDown" });
    expect(item("README.md")).toHaveFocus();

    fireEvent.keyDown(item("README.md"), { key: "ArrowUp" });
    expect(item("src")).toHaveFocus();

    fireEvent.keyDown(item("src"), { key: "ArrowLeft" });
    expect(root).toHaveFocus();

    fireEvent.keyDown(root, { key: "End" });
    expect(item("~/notes")).toHaveFocus();

    fireEvent.keyDown(item("~/notes"), { key: "Home" });
    expect(root).toHaveFocus();

    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(root).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "src" })).toBeNull();
  });

  it("keeps exactly one tab stop, following focus", () => {
    renderTree();
    const tabbable = () =>
      screen
        .getAllByRole("treeitem")
        .filter((row) => row.getAttribute("tabindex") === "0");
    expect(tabbable()).toEqual([item("~/code/acme-web")]);
    fireEvent.keyDown(item("~/code/acme-web"), { key: "ArrowDown" });
    expect(tabbable()).toEqual([item("~/code/archive")]);
  });

  it("leaves a modified key to the browser", () => {
    renderTree({ defaultExpandedIds: ["acme-web"] });
    const root = item("~/code/acme-web");
    const notPrevented = fireEvent.keyDown(root, {
      altKey: true,
      key: "ArrowLeft",
    });
    expect(notPrevented).toBe(true);
    expect(root).toHaveAttribute("aria-expanded", "true");
    expect(fireEvent.keyDown(root, { key: "ArrowLeft" })).toBe(false);
    expect(root).toHaveAttribute("aria-expanded", "false");
  });

  it("publishes aria-expanded only on rows that own children", () => {
    renderTree();
    expect(item("~/code/acme-web")).toHaveAttribute("aria-expanded", "false");
    expect(item("~/notes")).not.toHaveAttribute("aria-expanded");
  });
});

describe("CheckboxTree pointer and layout", () => {
  it("opens a row from its chevron without toggling the row's check", () => {
    const { onCheckedChange } = renderTree();
    const root = item("~/code/acme-web");
    const chevron = root.querySelector(
      '[data-slot="checkbox-tree-disclosure"]'
    ) as HTMLElement;
    fireEvent.click(chevron);
    expect(root).toHaveAttribute("aria-expanded", "true");
    expect(onCheckedChange).not.toHaveBeenCalled();
    fireEvent.click(root);
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
  });

  it("reserves a chevron track only when some row can expand", () => {
    const { container } = render(
      <CheckboxTree
        aria-label="Flat fixture"
        nodes={[
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ]}
      />
    );
    expect(
      container.querySelectorAll(
        '[data-slot="checkbox-tree-disclosure-spacer"]'
      )
    ).toHaveLength(0);
    renderTree();
    expect(
      document.querySelectorAll('[data-slot="checkbox-tree-disclosure-spacer"]')
        .length
    ).toBeGreaterThan(0);
  });

  it("paints the same node the model resolves when an id repeats under a closed row", () => {
    render(
      <CheckboxTree
        aria-label="Duplicate fixture"
        nodes={[
          { id: "p", label: "p", children: [{ id: "dup", label: "inner" }] },
          { id: "dup", label: "outer" },
        ]}
      />
    );
    // The top-level `dup` claims the id first, so `p` is left with no
    // children: it must not offer a chevron the model says it does not have.
    expect(item("p")).not.toHaveAttribute("aria-expanded");
    expect(item("outer")).toHaveAttribute("aria-checked", "false");
  });

  it("survives a node that is its own ancestor", () => {
    const loop: { id: string; label: string; children?: CheckboxTreeNode[] } = {
      id: "loop",
      label: "loop",
    };
    loop.children = [loop];
    const onCheckedChange = vi.fn();
    render(
      <CheckboxTree
        aria-label="Cyclic fixture"
        defaultExpandedIds={["loop"]}
        nodes={[loop]}
        onCheckedChange={onCheckedChange}
      />
    );
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    fireEvent.keyDown(item("loop"), { key: " " });
    expect(onCheckedChange).toHaveBeenLastCalledWith(["loop"]);
  });
});

describe("CheckboxTree locked rows", () => {
  it("toggles an unlocked leaf but neither a disabled nor a read-only one", () => {
    const { onCheckedChange } = renderTree({
      defaultExpandedIds: ["acme-web"],
    });

    fireEvent.keyDown(item("~/code/archive"), { key: " " });
    fireEvent.click(item("~/code/archive"));
    fireEvent.keyDown(item(".secrets"), { key: " " });
    fireEvent.click(item(".secrets"));
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(item("~/code/archive")).toHaveAttribute("aria-checked", "false");
    expect(item(".secrets")).toHaveAttribute("aria-checked", "false");

    fireEvent.keyDown(item("~/notes"), { key: " " });
    expect(onCheckedChange).toHaveBeenLastCalledWith(["notes"]);
    expect(item("~/notes")).toHaveAttribute("aria-checked", "true");
  });

  it("locks a locked parent's children and describes them with its reason", () => {
    const { onCheckedChange } = renderTree({ defaultExpandedIds: ["vendor"] });
    const child = item("lib");
    fireEvent.keyDown(child, { key: " " });
    fireEvent.click(child);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(child).toHaveAttribute("aria-checked", "false");
    expect(item("~/vendor")).toHaveAttribute("aria-checked", "false");
    expect(child).toHaveAccessibleDescription("Fixture reason: vendored");
    expect(
      child.querySelector('[data-slot="checkbox-tree-lock"]')
    ).not.toBeNull();
    expect(
      item("~/notes").querySelector('[data-slot="checkbox-tree-lock"]')
    ).toBeNull();
  });

  it("names the row by its label and describes it with its reason", () => {
    renderTree({ defaultExpandedIds: ["acme-web"] });
    const disabled = item("~/code/archive");
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).toHaveAccessibleDescription(
      "Fixture reason: not connected"
    );
    const readOnly = item(".secrets");
    expect(readOnly).not.toHaveAttribute("aria-disabled");
    expect(readOnly).toHaveAccessibleDescription(
      "Fixture reason: locked by policy"
    );
    expect(item("~/notes")).not.toHaveAttribute("aria-describedby");
  });
});

describe("CheckboxTreeNode type", () => {
  it("refuses a locked row without a reason", () => {
    // @ts-expect-error a read-only row must say why (no aria-readonly on treeitem)
    const unexplained: CheckboxTreeNode = {
      id: "x",
      label: "x",
      readOnly: true,
    };
    expect(unexplained.id).toBe("x");
  });
});

describe("toggleCheckboxTreeNode", () => {
  it("never cascades into a locked subtree and keeps a locked row's own state", () => {
    expect(
      toggleCheckboxTreeNode(NODES, new Set(["secrets"]), "acme-web")
    ).toEqual(["acme-web"]);
    expect(
      toggleCheckboxTreeNode(
        NODES,
        new Set(["acme-web", "src", "app", "util", "readme", "secrets"]),
        "acme-web"
      )
    ).toEqual(["secrets"]);
  });

  it("refuses a direct toggle of a row under a locked ancestor", () => {
    expect(toggleCheckboxTreeNode(NODES, new Set(), "vendor-lib")).toEqual([]);
  });

  it("carries an id for a node not in the tree through a toggle of another row", () => {
    expect(
      toggleCheckboxTreeNode(NODES, new Set(["gone-folder", "app"]), "notes")
    ).toEqual(["gone-folder", "app", "notes"]);
    expect(
      toggleCheckboxTreeNode(NODES, new Set(["gone-folder", "notes"]), "notes")
    ).toEqual(["gone-folder"]);
  });
});

describe("toggleCheckboxTreeNode consent (no promotion)", () => {
  const FOLDER: readonly CheckboxTreeNode[] = [
    {
      id: "folder",
      label: "folder",
      children: [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
      ],
    },
  ];
  const GROWN: readonly CheckboxTreeNode[] = [
    {
      id: "folder",
      label: "folder",
      children: [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
        { id: "c", label: "c" },
      ],
    },
  ];

  it("checks every child one by one without writing the parent id", () => {
    const afterA = toggleCheckboxTreeNode(FOLDER, new Set(), "a");
    const afterB = toggleCheckboxTreeNode(FOLDER, new Set(afterA), "b");
    expect(afterB).toEqual(["a", "b"]);
  });

  it("leaves a child added later unchecked under a parent checked one by one", () => {
    const { rerender } = render(
      <CheckboxTree
        aria-label="Grown fixture"
        defaultExpandedIds={["folder"]}
        nodes={FOLDER}
      />
    );
    fireEvent.click(item("a"));
    fireEvent.click(item("b"));
    expect(item("folder")).toHaveAttribute("aria-checked", "true");
    rerender(
      <CheckboxTree
        aria-label="Grown fixture"
        defaultExpandedIds={["folder"]}
        nodes={GROWN}
      />
    );
    expect(item("c")).toHaveAttribute("aria-checked", "false");
    expect(item("folder")).toHaveAttribute("aria-checked", "mixed");
  });

  it("writes the parent id on an explicit parent click, so a later child inherits", () => {
    const clicked = toggleCheckboxTreeNode(FOLDER, new Set(["a"]), "folder");
    expect(clicked).toEqual(["folder"]);
    render(
      <CheckboxTree
        aria-label="Grown fixture"
        checkedIds={clicked}
        defaultExpandedIds={["folder"]}
        nodes={GROWN}
      />
    );
    expect(item("c")).toHaveAttribute("aria-checked", "true");
  });

  it("demotes a clicked parent to its remaining children when one is unchecked", () => {
    expect(toggleCheckboxTreeNode(GROWN, new Set(["folder"]), "b")).toEqual([
      "a",
      "c",
    ]);
    expect(toggleCheckboxTreeNode(NODES, new Set(["acme-web"]), "app")).toEqual(
      ["readme", "secrets", "util"]
    );
  });
});

describe("CheckboxTree a parent whose every leaf is locked", () => {
  const ALL_LOCKED: readonly CheckboxTreeNode[] = [
    {
      id: "shell",
      label: "shell",
      children: [
        {
          id: "x",
          label: "x",
          readOnly: true,
          reason: "Fixture reason: managed",
        },
        {
          id: "y",
          label: "y",
          disabled: true,
          reason: "Fixture reason: offline",
        },
      ],
    },
    { id: "free", label: "free" },
  ];

  it("is announced and drawn as locked, and toggling it is a no-op", () => {
    const onCheckedChange = vi.fn();
    render(
      <CheckboxTree
        aria-label="Locked fixture"
        nodes={ALL_LOCKED}
        onCheckedChange={onCheckedChange}
      />
    );
    const shell = item("shell");
    expect(shell).toHaveAttribute("aria-disabled", "true");
    expect(shell.className).not.toContain("cursor-pointer");
    expect(shell.className).not.toContain("hover:bg-muted");
    fireEvent.click(shell);
    fireEvent.keyDown(shell, { key: " " });
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(toggleCheckboxTreeNode(ALL_LOCKED, new Set(), "shell")).toEqual([]);
    expect(item("free").className).toContain("cursor-pointer");
  });
});

describe("CheckboxTree semantics and forms", () => {
  it("declares the tree multiselectable", () => {
    renderTree();
    expect(screen.getByRole("tree")).toHaveAttribute(
      "aria-multiselectable",
      "true"
    );
  });

  it("toggles exactly once per click inside a <form>", () => {
    const onCheckedChange = vi.fn();
    render(
      <form>
        <CheckboxTree
          aria-label="Form fixture"
          nodes={NODES}
          onCheckedChange={onCheckedChange}
        />
      </form>
    );
    fireEvent.click(item("~/notes"));
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenLastCalledWith(["notes"]);
    expect(item("~/notes")).toHaveAttribute("aria-checked", "true");
  });
});
