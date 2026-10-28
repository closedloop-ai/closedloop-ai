/**
 * ISS-12527 — `DataControlsScopeEditor`: the Settings scope editor's draft,
 * save, discard and leave handling, and the status it shows while saving.
 * Strings are test fixtures, not product copy: the editor takes every string
 * from its host. Directories are fictional.
 */
import {
  type DataSyncLevel,
  DataSyncLevel as Level,
} from "@repo/api/src/types/data-sync-level";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type DataControlsPolicy,
  DataControlsScopeEditor,
  type DataControlsScopeEditorCopy,
  isSameDataControlsPolicy,
} from "../data-controls-scope-editor";
import {
  DataControlsScopeEditorFixtureHost,
  type DataControlsScopeEditorFixtureHostProps,
  FIXTURE_SAVE_OUTCOME,
} from "../data-controls-scope-editor-fixtures";
import type {
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "../directory-scope-list";
import {
  POLICY_STATUS,
  type PolicyStatus,
  type PolicyStatusIndicatorProps,
} from "../policy-status-indicator";

const COPY: DataControlsScopeEditorCopy = {
  scopeHeading: "fixture-scope-heading",
  levelHeading: "fixture-level-heading",
  levelLabel: "fixture-level-label",
  unsavedChanges: "fixture-unsaved",
  saveLabel: "fixture-save",
  discardLabel: "fixture-discard",
  leaveTitle: "fixture-leave-title",
  leaveDescription: "fixture-leave-description",
  leaveStayLabel: "fixture-stay",
  leaveDiscardLabel: "fixture-discard-and-leave",
};

const SCOPE_COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: "fixture-auto-heading",
  autoExcludedReason: "fixture-auto-reason",
  empty: "fixture-empty",
  newlyDiscovered: "fixture-new",
  noSelection: "fixture-no-selection",
  treeLabel: "fixture-tree",
  unavailable: "fixture-unavailable",
  unavailableReason: "fixture-unavailable-reason",
};

const STATUS_LABELS: Record<PolicyStatus, string> = {
  [POLICY_STATUS.ACTIVE]: "fixture-active",
  [POLICY_STATUS.PENDING]: "fixture-pending",
  [POLICY_STATUS.FAILED]: "fixture-failed",
  [POLICY_STATUS.UNAVAILABLE]: "fixture-unavailable-status",
};

const ENTRIES: readonly DirectoryScopeEntry[] = [
  { id: "~/code", label: "~/code" },
  { id: "~/sandbox", label: "~/sandbox" },
];

const LEVELS: readonly DataSyncLevel[] = [
  Level.Off,
  Level.Metadata,
  Level.Full,
];

const SAVED: DataControlsPolicy = {
  includedIds: ["~/code"],
  level: Level.Metadata,
};

function renderHost(
  overrides: Partial<DataControlsScopeEditorFixtureHostProps> = {}
) {
  const props: DataControlsScopeEditorFixtureHostProps = {
    copy: COPY,
    entries: ENTRIES,
    initialSaved: SAVED,
    leaveLabel: "fixture-leave",
    levels: LEVELS,
    onLeave: vi.fn(),
    onSave: vi.fn(),
    onStay: vi.fn(),
    retryLabel: "fixture-retry",
    saveDelayMs: 0,
    saveOutcome: FIXTURE_SAVE_OUTCOME.SUCCEED,
    scopeCopy: SCOPE_COPY,
    statusLabels: STATUS_LABELS,
    ...overrides,
  };
  render(<DataControlsScopeEditorFixtureHost {...props} />);
  return props;
}

const row = (name: string) => screen.getByRole("treeitem", { name });
const saveButton = () => screen.getByRole("button", { name: COPY.saveLabel });
const discardButton = () =>
  screen.getByRole("button", { name: COPY.discardLabel });
const unsaved = () => screen.getByTestId("data-controls-unsaved");
const indicator = () => screen.getByTestId("policy-status-indicator");

describe("DataControlsScopeEditor in edit mode (AC-001)", () => {
  it("hosts an editable directory scope list and the level picker", () => {
    renderHost();
    expect(screen.getByRole("tree", { name: SCOPE_COPY.treeLabel })).toBe(
      row("~/code").closest('[role="tree"]')
    );
    expect(row("~/code")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row("~/sandbox"));
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radiogroup", { name: COPY.levelLabel })
    ).toBeInTheDocument();
  });
});

describe("DataControlsScopeEditor draft (AC-002)", () => {
  it("starts clean: nothing unsaved, save and discard disabled", () => {
    renderHost();
    expect(unsaved()).toHaveTextContent("");
    expect(saveButton()).toBeDisabled();
    expect(discardButton()).toBeDisabled();
  });

  it("shows unsaved changes after an edit, and discard restores the saved policy", () => {
    renderHost();
    fireEvent.click(row("~/sandbox"));
    expect(unsaved()).toHaveTextContent(COPY.unsavedChanges);
    expect(saveButton()).toBeEnabled();
    fireEvent.click(discardButton());
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "false");
    expect(row("~/code")).toHaveAttribute("aria-checked", "true");
    expect(unsaved()).toHaveTextContent("");
    expect(saveButton()).toBeDisabled();
  });

  it("an edit undone by hand is not unsaved", () => {
    renderHost();
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(row("~/sandbox"));
    expect(unsaved()).toHaveTextContent("");
  });

  it("a level change is part of the same draft", () => {
    renderHost();
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(unsaved()).toHaveTextContent(COPY.unsavedChanges);
  });

  it("save hands the whole draft to the host", async () => {
    const props = renderHost();
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(saveButton());
    expect(props.onSave).toHaveBeenCalledTimes(1);
    const [draft] = vi.mocked(props.onSave).mock.calls[0];
    expect(
      isSameDataControlsPolicy(draft, {
        includedIds: ["~/code", "~/sandbox"],
        level: Level.Metadata,
      })
    ).toBe(true);
    await waitFor(() => expect(unsaved()).toHaveTextContent(""));
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "true");
  });
});

describe("DataControlsScopeEditor leaving with unsaved changes (AC-002)", () => {
  it("lets the host leave at once when nothing is unsaved", () => {
    const props = renderHost();
    fireEvent.click(screen.getByRole("button", { name: "fixture-leave" }));
    expect(props.onLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks first; staying keeps the draft", async () => {
    const props = renderHost();
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(screen.getByRole("button", { name: "fixture-leave" }));
    expect(props.onLeave).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(COPY.leaveTitle);
    fireEvent.click(
      within(dialog).getByRole("button", { name: COPY.leaveStayLabel })
    );
    expect(props.onStay).toHaveBeenCalledTimes(1);
    expect(props.onLeave).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(unsaved()).toHaveTextContent(COPY.unsavedChanges);
  });

  it("discard and leave drops the draft and leaves exactly once", async () => {
    const props = renderHost();
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(screen.getByRole("button", { name: "fixture-leave" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: COPY.leaveDiscardLabel })
    );
    await waitFor(() => expect(props.onLeave).toHaveBeenCalledTimes(1));
    expect(props.onStay).not.toHaveBeenCalled();
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "false");
  });
});

describe("DataControlsScopeEditor status while saving (AC-003)", () => {
  it("shows pending, locks the editor, then shows active", async () => {
    vi.useFakeTimers();
    try {
      renderHost({ saveDelayMs: 1000 });
      expect(indicator()).toHaveAttribute("data-state", POLICY_STATUS.ACTIVE);
      fireEvent.click(row("~/sandbox"));
      fireEvent.click(saveButton());
      expect(indicator()).toHaveAttribute("data-state", POLICY_STATUS.PENDING);
      expect(
        screen.getByRole("status", { name: STATUS_LABELS.pending })
      ).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(discardButton()).toBeDisabled();
      expect(row("~/sandbox").closest("section")).toHaveAttribute("inert");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(indicator()).toHaveAttribute("data-state", POLICY_STATUS.ACTIVE);
      expect(unsaved()).toHaveTextContent("");
      expect(row("~/sandbox").closest("section")).not.toHaveAttribute("inert");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed save keeps the draft and retries the same draft", async () => {
    const props = renderHost({ saveOutcome: FIXTURE_SAVE_OUTCOME.FAIL });
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(indicator()).toHaveAttribute("data-state", POLICY_STATUS.FAILED)
    );
    expect(unsaved()).toHaveTextContent(COPY.unsavedChanges);
    fireEvent.click(screen.getByRole("button", { name: "fixture-retry" }));
    expect(props.onSave).toHaveBeenCalledTimes(2);
    expect(vi.mocked(props.onSave).mock.calls[1][0]).toBe(
      vi.mocked(props.onSave).mock.calls[0][0]
    );
  });
});

describe("isSameDataControlsPolicy", () => {
  it("compares the included set in any order, and the level", () => {
    const a = { includedIds: ["~/code", "~/sandbox"], level: Level.Full };
    expect(
      isSameDataControlsPolicy(a, {
        includedIds: ["~/sandbox", "~/code"],
        level: Level.Full,
      })
    ).toBe(true);
    expect(isSameDataControlsPolicy(a, { ...a, level: Level.Off })).toBe(false);
    expect(isSameDataControlsPolicy(a, { ...a, includedIds: ["~/code"] })).toBe(
      false
    );
  });
});

describe("DataControlsScopeEditor when the saved policy changes", () => {
  const OTHER: DataControlsPolicy = {
    includedIds: ["~/sandbox"],
    level: Level.Full,
  };

  function renderEditor(saved: DataControlsPolicy) {
    return (
      <DataControlsScopeEditor
        copy={COPY}
        entries={ENTRIES}
        levels={LEVELS}
        onSave={vi.fn()}
        saved={saved}
        scopeCopy={SCOPE_COPY}
        status={{ status: POLICY_STATUS.ACTIVE, label: STATUS_LABELS.active }}
      />
    );
  }

  it("a clean draft follows the new policy", () => {
    const { rerender } = render(renderEditor(SAVED));
    rerender(renderEditor(OTHER));
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "true");
    expect(row("~/code")).toHaveAttribute("aria-checked", "false");
    expect(unsaved()).toHaveTextContent("");
  });

  it("an unsaved draft is kept, never silently thrown away", () => {
    const { rerender } = render(renderEditor(SAVED));
    fireEvent.click(row("~/code"));
    rerender(renderEditor(OTHER));
    expect(row("~/code")).toHaveAttribute("aria-checked", "false");
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "false");
    expect(unsaved()).toHaveTextContent(COPY.unsavedChanges);
  });

  it("reports when the draft becomes and stops being unsaved", () => {
    const onDirtyChange = vi.fn();
    render(
      <DataControlsScopeEditor
        copy={COPY}
        entries={ENTRIES}
        levels={LEVELS}
        onDirtyChange={onDirtyChange}
        onSave={vi.fn()}
        saved={SAVED}
        scopeCopy={SCOPE_COPY}
        status={{ status: POLICY_STATUS.ACTIVE, label: STATUS_LABELS.active }}
      />
    );
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(discardButton());
    expect(onDirtyChange.mock.calls.map(([dirty]) => dirty)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("DataControlsScopeEditor review fixes (PR #8876)", () => {
  const OTHER: DataControlsPolicy = {
    includedIds: ["~/sandbox"],
    level: Level.Full,
  };
  const leave = () =>
    fireEvent.click(screen.getByRole("button", { name: "fixture-leave" }));

  it("holds a leave while a save is pending, then leaves once it lands", async () => {
    vi.useFakeTimers();
    try {
      const props = renderHost({ saveDelayMs: 1000 });
      fireEvent.click(row("~/sandbox"));
      fireEvent.click(saveButton());
      leave();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Discarding cannot cancel the write, so it is not offered.
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(props.onLeave).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(props.onLeave).toHaveBeenCalledTimes(1);
      expect(props.onStay).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks about a held leave once the pending save fails", async () => {
    vi.useFakeTimers();
    try {
      const props = renderHost({
        saveDelayMs: 1000,
        saveOutcome: FIXTURE_SAVE_OUTCOME.FAIL,
      });
      fireEvent.click(row("~/sandbox"));
      fireEvent.click(saveButton());
      leave();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByRole("dialog")).toHaveTextContent(COPY.leaveTitle);
      expect(props.onLeave).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed save followed by a change from elsewhere keeps the draft", () => {
    const editor = (
      saved: DataControlsPolicy,
      status: PolicyStatusIndicatorProps
    ) => (
      <DataControlsScopeEditor
        copy={COPY}
        entries={ENTRIES}
        levels={LEVELS}
        onSave={vi.fn()}
        saved={saved}
        scopeCopy={SCOPE_COPY}
        status={status}
      />
    );
    const active: PolicyStatusIndicatorProps = {
      status: POLICY_STATUS.ACTIVE,
      label: STATUS_LABELS.active,
    };
    const { rerender } = render(editor(SAVED, active));
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(saveButton());
    rerender(
      editor(SAVED, {
        status: POLICY_STATUS.FAILED,
        label: STATUS_LABELS.failed,
        retryLabel: "fixture-retry",
        onRetry: vi.fn(),
      })
    );
    rerender(editor(OTHER, active));
    // The draft (~/code + ~/sandbox, metadata) is not replaced by OTHER.
    expect(row("~/code")).toHaveAttribute("aria-checked", "true");
    expect(row("~/sandbox")).toHaveAttribute("aria-checked", "true");
    expect(unsaved()).toHaveTextContent(COPY.unsavedChanges);
  });

  it("answers a leave request once even if the host rebuilds it every render", () => {
    const onLeave = vi.fn();
    let rerenderHost: () => void = () => undefined;
    function Host() {
      const [, force] = useReducer((n: number) => n + 1, 0);
      rerenderHost = force;
      return (
        <DataControlsScopeEditor
          copy={COPY}
          entries={ENTRIES}
          // A fresh object on every render, as a mapped router blocker is.
          leaveRequest={{ onLeave, onStay: vi.fn() }}
          levels={LEVELS}
          onSave={vi.fn()}
          saved={SAVED}
          scopeCopy={SCOPE_COPY}
          status={{
            status: POLICY_STATUS.ACTIVE,
            label: STATUS_LABELS.active,
          }}
        />
      );
    }
    render(<Host />);
    act(() => rerenderHost());
    act(() => rerenderHost());
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("does not leave twice when a rerender lands between confirm and clear", async () => {
    const onLeave = vi.fn();
    let rerenderHost: () => void = () => undefined;
    function Host() {
      const [, force] = useReducer((n: number) => n + 1, 0);
      rerenderHost = force;
      return (
        <DataControlsScopeEditor
          copy={COPY}
          defaultDraft={OTHER}
          entries={ENTRIES}
          leaveRequest={{ onLeave, onStay: vi.fn() }}
          levels={LEVELS}
          onSave={vi.fn()}
          saved={SAVED}
          scopeCopy={SCOPE_COPY}
          status={{
            status: POLICY_STATUS.ACTIVE,
            label: STATUS_LABELS.active,
          }}
        />
      );
    }
    render(<Host />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: COPY.leaveDiscardLabel })
    );
    act(() => rerenderHost());
    act(() => rerenderHost());
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("locks editing and saving while the policy is unavailable", () => {
    renderHost({ initialDraft: OTHER, unavailable: true });
    expect(indicator()).toHaveAttribute(
      "data-state",
      POLICY_STATUS.UNAVAILABLE
    );
    expect(row("~/sandbox").closest("section")).toHaveAttribute("inert");
    expect(screen.getByRole("radio", { name: "Off" })).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    // Discard only drops the local draft, so it stays available.
    expect(discardButton()).toBeEnabled();
  });

  it("discard after a failed save drops the retry with the draft", async () => {
    const onDiscard = vi.fn();
    const props = renderHost({
      onDiscard,
      saveOutcome: FIXTURE_SAVE_OUTCOME.FAIL,
    });
    fireEvent.click(row("~/sandbox"));
    fireEvent.click(saveButton());
    await screen.findByRole("button", { name: "fixture-retry" });
    fireEvent.click(discardButton());
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "fixture-retry" })
    ).not.toBeInTheDocument();
    expect(indicator()).toHaveAttribute("data-state", POLICY_STATUS.ACTIVE);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });
});
