import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { parseBranchSavedViews } from "../../lib/branch-saved-views";
import {
  BranchSortDir,
  BranchSortKey,
  DEFAULT_BRANCH_SORT_KEY,
} from "../../lib/branch-sort-group";
import { useBranchViewState } from "../use-branch-view-state";

/**
 * ISS-9447 M5 — the rename normalization Branches now routes all four id-keyed
 * persisted axes through, driven by a FABRICATED rename.
 *
 * Its own suite because of the module mock below, and because the real rename
 * table cannot exercise this at all: it is EMPTY. No Branches column id has ever
 * been renamed, so every stored value normalizes to itself and the parsers are
 * observably identical with the alias and without it. Fabricating a real entry
 * to make the table look busy would be a lie about the product; leaving the
 * wiring unpinned would mean the next rename of a Branches column discovers the
 * seam was never connected, which is the whole failure mode. So the LOOKUP is
 * mocked and everything else — the schemas, the closed sort enums, the hook, and
 * the `localStorage` round trip — stays on the production path. Delete
 * `BRANCH_STORED_SORT_KEY_SCHEMA`'s preprocess, or the `normalizeBranchColumnIds`
 * / `normalizeBranchColumnWidths` calls from either store, and these cases
 * redden.
 */
const { LEGACY_RENAME_PREFIX } = vi.hoisted(() => ({
  LEGACY_RENAME_PREFIX: "legacy:",
}));

vi.mock("../../lib/branch-column-renames", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/branch-column-renames")>();
  // A prefix rather than a named pair, so each case can spell its target with
  // the real enum member instead of a second copy of the string.
  const normalizeBranchColumnId = (columnId: string): string =>
    columnId.startsWith(LEGACY_RENAME_PREFIX)
      ? columnId.slice(LEGACY_RENAME_PREFIX.length)
      : actual.normalizeBranchColumnId(columnId);
  return {
    ...actual,
    normalizeBranchColumnId,
    normalizeBranchColumnIds: (columnIds: readonly string[]): string[] =>
      columnIds.map(normalizeBranchColumnId),
    normalizeBranchColumnWidths: (
      columnWidths: Readonly<Record<string, number>>
    ): Record<string, number> =>
      Object.fromEntries(
        Object.entries(columnWidths).map(([columnId, width]) => [
          normalizeBranchColumnId(columnId),
          width,
        ])
      ),
    normalizeStoredBranchSortKey: (value: unknown): unknown =>
      typeof value === "string" ? normalizeBranchColumnId(value) : value,
  };
});

const LEGACY_REPO_ID = `${LEGACY_RENAME_PREFIX}${BranchSortKey.Repo}`;
const USER_ID = "user_branch_rename";
const STORAGE_KEY = `branches:saved-view:branches:web:approved:u:${USER_ID}`;

function signedIn({ children }: { children: ReactNode }) {
  return (
    <AuthAdapterProvider adapter={createStaticAuthAdapter({ userId: USER_ID })}>
      {children}
    </AuthAdapterProvider>
  );
}

afterEach(() => localStorage.clear());

describe("ISS-9447 M5: a renamed Branches column id in the live saved view", () => {
  it("resolves the stored sort key instead of falling back to the default", async () => {
    // The sort axis is the one with teeth. Before M5 an unspellable stored key
    // failed the WHOLE object parse; it now falls back to the default sort, so
    // without the alias in front of the enum a renamed column would silently
    // move the reader off the sort they chose. The fallback is the safety net,
    // not the answer.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenColumns: [],
        sortDir: BranchSortDir.Asc,
        sortKey: LEGACY_REPO_ID,
      })
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: signedIn }
    );

    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    expect(result.current.sortKey).toBe(BranchSortKey.Repo);
    expect(result.current.sortKey).not.toBe(DEFAULT_BRANCH_SORT_KEY);
    expect(result.current.sortDir).toBe(BranchSortDir.Asc);
  });

  it("resolves a renamed id on the hidden-column and column-order axes", async () => {
    // Unresolved, both ids would be filtered out as columns this build does not
    // have: the reader's hidden column comes back visible and their arranged
    // slot disappears from the order.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnOrder: [LEGACY_REPO_ID, "status"],
        hiddenColumns: [LEGACY_REPO_ID],
        sortDir: BranchSortDir.Desc,
        sortKey: BranchSortKey.Name,
      })
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: signedIn }
    );

    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    expect(result.current.visibleColumns.has("repo")).toBe(false);
    expect(result.current.columnOrder).toEqual(["repo", "status"]);
  });

  it("resolves a renamed id on the column-WIDTH axis too", async () => {
    // The axis the seam originally left out. Unresolved, the width is keyed by a
    // column this build cannot draw, `filterValidColumnWidths` drops it, and the
    // reader gets the natural width back on the one column they had resized — a
    // half-migration on the very read the rename was supposed to be invisible on.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        columnWidths: { [LEGACY_REPO_ID]: 210 },
        hiddenColumns: [],
        sortDir: BranchSortDir.Desc,
        sortKey: BranchSortKey.Name,
      })
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: signedIn }
    );

    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    expect(result.current.columnWidths).toEqual({ [BranchSortKey.Repo]: 210 });
  });
});

describe("ISS-9447 M5: a renamed Branches column id in a NAMED saved view", () => {
  it("resolves it on all four id-keyed axes rather than dropping or ignoring it", () => {
    const [view] = parseBranchSavedViews({
      activeViewId: "v1",
      views: [
        {
          arrangement: {
            columnOrder: [LEGACY_REPO_ID, "status"],
            columnWidths: { [LEGACY_REPO_ID]: 210 },
            hiddenColumns: [LEGACY_REPO_ID],
            sortDir: BranchSortDir.Asc,
            sortKey: LEGACY_REPO_ID,
          },
          id: "v1",
          name: "Mine",
        },
      ],
    }).views;

    expect(view.arrangement.sortKey).toBe(BranchSortKey.Repo);
    expect(view.arrangement.hiddenColumns).toEqual([BranchSortKey.Repo]);
    expect(view.arrangement.columnOrder).toEqual([
      BranchSortKey.Repo,
      "status",
    ]);
    // The width rides the same read boundary, so the named store cannot resolve
    // three axes and strand the fourth either.
    expect(view.arrangement.columnWidths).toEqual({
      [BranchSortKey.Repo]: 210,
    });
  });
});
