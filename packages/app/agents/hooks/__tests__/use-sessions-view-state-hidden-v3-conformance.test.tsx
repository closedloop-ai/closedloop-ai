import { renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SessionSortDir } from "../../lib/session-sort-group";
import { SESSIONS_SAVED_VIEW_HIDDEN_VERSION } from "../../lib/sessions-saved-view-migration";
import { useSessionsViewState } from "../use-sessions-view-state";

const VIEW_KEY = "sessions:hidden-v3-conformance";
const STORAGE_KEY = `sessions:saved-view:${VIEW_KEY}`;

afterEach(() => {
  localStorage.clear();
});

it("restores a v2 hidden set to v3 without re-hiding a user-enabled column", () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      hiddenColumns: ["pr", "merge", "updated", "started", "projects"],
      hiddenColumnsVersion: 2,
      sortDir: SessionSortDir.Desc,
      sortKey: null,
      viewStateVersions: { hiddenColumns: 2 },
    })
  );

  const first = renderHook(() => useSessionsViewState(VIEW_KEY));
  expect(first.result.current.visibleColumns.has("issues")).toBe(true);
  expect(first.result.current.visibleColumns.has("tags")).toBe(false);
  first.unmount();

  const migrated = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  expect(migrated.hiddenColumns).toEqual([
    "pr",
    "merge",
    "updated",
    "started",
    "projects",
    "tags",
  ]);
  expect(migrated.hiddenColumnsVersion).toBe(
    SESSIONS_SAVED_VIEW_HIDDEN_VERSION
  );
  expect(migrated.viewStateVersions.hiddenColumns).toBe(
    SESSIONS_SAVED_VIEW_HIDDEN_VERSION
  );

  const second = renderHook(() => useSessionsViewState(VIEW_KEY));
  expect(second.result.current.visibleColumns.has("issues")).toBe(true);
  second.unmount();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual(
    migrated
  );
});
