import { describe, expect, test } from "vitest";
import {
  DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES,
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_IDS,
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
  workspaceMenuCapabilityError,
  workspaceMenuCapabilityReady,
  workspaceMenuCapabilityUnavailable,
} from "./workspace-menu.ts";

const JOIN_WORDING = /join/i;

describe("WORKSPACE_MENU_ENTRY_IDS", () => {
  test("derives every id the exhaustive label map declares", () => {
    // The point of deriving rather than restating: this cannot drift below the
    // map. A hand-written list would compile unchanged after an id is added.
    expect([...WORKSPACE_MENU_ENTRY_IDS].sort()).toEqual(
      Object.values(WorkspaceMenuEntryId).sort()
    );
    expect(WORKSPACE_MENU_ENTRY_IDS).toHaveLength(
      Object.keys(WORKSPACE_MENU_ENTRY_LABEL).length
    );
  });

  test("every id carries non-empty copy, so no entry can render blank", () => {
    for (const id of WORKSPACE_MENU_ENTRY_IDS) {
      expect(WORKSPACE_MENU_ENTRY_LABEL[id].trim()).not.toBe("");
    }
  });

  test("the create-workspace label does not offer joining", () => {
    // Joining happens during Clerk authentication; the menu cannot do it, so
    // the prototype's "Create or join a workspace…" would be a false promise.
    expect(
      WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateWorkspace]
    ).not.toMatch(JOIN_WORDING);
  });
});

describe("isWorkspaceMenuEntryRendered", () => {
  test("renders only a Ready entry", () => {
    expect(isWorkspaceMenuEntryRendered(workspaceMenuCapabilityReady())).toBe(
      true
    );
  });

  test("does not render an Unavailable entry — absent, never disabled", () => {
    expect(
      isWorkspaceMenuEntryRendered(
        workspaceMenuCapabilityUnavailable(
          WorkspaceMenuCapabilityReason.NotSupportedOnHost
        )
      )
    ).toBe(false);
  });

  test("does not render an Error entry either, but keeps the two distinct", () => {
    const failed = workspaceMenuCapabilityError(
      WorkspaceMenuCapabilityReason.ReadFailed
    );
    const absent = workspaceMenuCapabilityUnavailable(
      WorkspaceMenuCapabilityReason.NotSupportedOnHost
    );

    expect(isWorkspaceMenuEntryRendered(failed)).toBe(false);

    // Both are unrendered, and they must still be tellable apart: a failed read
    // is a different claim from a host that never had the feature.
    expect(failed.status).toBe(WorkspaceMenuCapabilityStatus.Error);
    expect(absent.status).toBe(WorkspaceMenuCapabilityStatus.Unavailable);
    expect(failed.status).not.toBe(absent.status);
  });
});

describe("DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES", () => {
  test("names exactly the entries desktop does not offer", () => {
    // Three come from the operator ruling; Members joined them in ISS-8368 for
    // a different reason — the desktop renderer mounts no Clerk provider, so
    // the OrganizationProfile embed behind that panel cannot mount there.
    expect([...DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES].sort()).toEqual(
      [
        WorkspaceMenuEntryId.CreateWorkspace,
        WorkspaceMenuEntryId.DownloadDesktop,
        WorkspaceMenuEntryId.Members,
        WorkspaceMenuEntryId.SwitchWorkspace,
      ].sort()
    );
  });

  test("is frozen, so a desktop adapter cannot mutate an org path into it", () => {
    expect(Object.isFrozen(DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES)).toBe(true);
  });
});
