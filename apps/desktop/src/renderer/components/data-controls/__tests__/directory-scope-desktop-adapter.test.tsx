/**
 * ISS-12521 AC-004: the adapter-to-component half — the payload rename and
 * the outcomes the shared `DirectoryScopeListWithAdd` resolves from it, over
 * a HAND-WRITTEN `pickDirectoryScopeEntry` stub.
 *
 * It does NOT prove the preload contract, and no longer claims to (tamsinb,
 * PR #8917): a stub cannot catch the preload method naming a channel no main
 * handler answers on. That hop drives `createDesktopApi` against the real
 * registered handler in `apps/desktop/test/directory-scope-ipc.test.ts`,
 * which also owns the handler's own verdict logic.
 */
import type { DirectoryScopeListCopy } from "@repo/app/shared/components/directory-scope-list";
import { DirectoryScopeListWithAdd } from "@repo/app/shared/components/directory-scope-list-with-add";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../types/desktop-api";
import { createDesktopPickDirectory } from "../directory-scope-desktop-adapter";

const COPY = {
  added: "Directory added",
  duplicate: "Already selected",
  protectedFolder: "This directory is not allowed",
  trigger: "Add directory",
  unreadable: "This directory is currently unreadable",
};

const LIST_COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: "Always excluded",
  autoExcludedReason: "Protected by macOS.",
  empty: "No directories found yet.",
  newlyDiscovered: "New",
  noSelection: "No directories selected.",
  treeLabel: "Directories to collect sessions from",
  unavailable: "Unavailable",
  unavailableReason: "Not available right now.",
};

function renderWithDesktopApi(
  pickDirectoryScopeEntry: DesktopApi["pickDirectoryScopeEntry"]
) {
  const onAdd = vi.fn();
  render(
    <DirectoryScopeListWithAdd
      add={{
        copy: COPY,
        onAdd,
        onPickError: vi.fn(),
        pickDirectory: createDesktopPickDirectory({
          pickDirectoryScopeEntry,
        }),
      }}
      copy={LIST_COPY}
      entries={[]}
      includedIds={[]}
    />
  );
  return { onAdd };
}

async function clickAdd() {
  fireEvent.click(screen.getByRole("button", { name: COPY.trigger }));
  await screen.findByRole("alert");
}

describe("createDesktopPickDirectory", () => {
  it("renames the IPC payload's path to the component's id, preserving the rest", async () => {
    const pickDirectoryScopeEntry = vi.fn().mockResolvedValue({
      label: "~/oss/tern",
      path: "/Users/test/oss/tern",
      tccProtected: false,
      unreadable: false,
    });
    const { onAdd } = renderWithDesktopApi(pickDirectoryScopeEntry);
    await clickAdd();
    expect(pickDirectoryScopeEntry).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      id: "/Users/test/oss/tern",
      label: "~/oss/tern",
      newlyDiscovered: true,
    });
    expect(screen.getByRole("alert").textContent).toBe(COPY.added);
  });

  it("passes a cancelled pick (null payload) straight through", async () => {
    const pickDirectoryScopeEntry = vi.fn().mockResolvedValue(null);
    const { onAdd } = renderWithDesktopApi(pickDirectoryScopeEntry);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: COPY.trigger }));
      await Promise.resolve();
    });
    expect(pickDirectoryScopeEntry).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Not a `/Volumes` path: ISS-11914's `isTccProtectedPath` classifies every
  // mounted volume as protected, so the host can no longer emit one with
  // `tccProtected: false` and this fixture would contradict it.
  it("surfaces an unreadable pick as the Unreadable outcome, not Added", async () => {
    const pickDirectoryScopeEntry = vi.fn().mockResolvedValue({
      label: "/opt/orbit/ledger",
      path: "/opt/orbit/ledger",
      tccProtected: false,
      unreadable: true,
    });
    const { onAdd } = renderWithDesktopApi(pickDirectoryScopeEntry);
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(COPY.unreadable);
  });

  it("surfaces a TCC-protected pick as the Protected outcome", async () => {
    const pickDirectoryScopeEntry = vi.fn().mockResolvedValue({
      label: "~/Documents",
      path: "/Users/test/Documents",
      tccProtected: true,
      unreadable: true,
    });
    const { onAdd } = renderWithDesktopApi(pickDirectoryScopeEntry);
    await clickAdd();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(COPY.protectedFolder);
  });
});
