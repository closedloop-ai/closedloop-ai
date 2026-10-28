/**
 * ISS-9307 — the champion editor's interaction contract.
 *
 * The value half is pinned next door in `artifact-priority.test.tsx`; this file
 * covers what the CONTROL owes: keyboard operation, focus restoration, the
 * mutation-activity state driven by a real in-flight write, and a refused write
 * showing the artifact's actual value again rather than the one it was denied.
 *
 * Rollback itself belongs to `useArtifactRowEdit` and its own suite. What is
 * asserted here is that the champion RENDERS whatever that ledger resolves to,
 * which is the half a second optimistic copy inside the editor would break.
 */

import { Priority } from "@repo/api/src/types/common";
import type { Document } from "@repo/api/src/types/document";
import { priorityTriggerLabel } from "@repo/app/documents/components/artifact-field-menus";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import type { ArtifactRowEditInput } from "@repo/app/documents/hooks/use-artifact-row-edit";
import { useArtifactRowEdit } from "@repo/app/documents/hooks/use-artifact-row-edit";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  type ArtifactPrioritySupport,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeFeatureArtifact } from "@repo/app/shared/test-fixtures/documents";
import {
  PRIORITY_LABEL_NONE,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ARTIFACT_SUPPORT =
  ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact];
/**
 * SYNTHETIC: since ISS-10332 made Branches and Sessions carry priority, no
 * shipped surface is unsupported, so the refusal is exercised against a
 * declaration of the shape the map still admits.
 */
const UNSUPPORTED_SUPPORT: ArtifactPrioritySupport = {
  adapter: "test",
  reason: "carries no priority",
  supported: false,
};

const CHAMPION = '[data-slot="artifact-priority"]';

afterEach(() => {
  cleanup();
});

/** Opens the `artifact-priority-surfaces` gate the activity treatments wait behind. */
function gated(children: ReactElement) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

describe("ArtifactPriorityEditor — keyboard and focus", () => {
  it("opens from the keyboard and returns focus to the trigger on Escape", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={Priority.High}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );

    const trigger = screen.getByRole("button", { name: "Priority: High" });
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "true")
    );
    expect(await screen.findByRole("menu")).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "false")
    );
    // Focus restoration: the control the reader came from is where they land,
    // not the document body.
    expect(trigger).toHaveFocus();
  });

  it("commits the picked member and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ArtifactPriorityEditor
        onSelect={onSelect}
        priority={Priority.Low}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );

    const trigger = screen.getByRole("button", { name: "Priority: Low" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));

    expect(onSelect).toHaveBeenCalledWith(Priority.Urgent);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("renders no control at all on a surface that carries no priority", () => {
    // Enforced by the component rather than by each call site remembering it.
    const { container } = render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={Priority.High}
        support={UNSUPPORTED_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
    // The sibling positive on the same target: the mark still renders, so
    // "no button" is not satisfied by a component that renders nothing.
    expect(container.querySelector(CHAMPION)).not.toBeNull();
  });

  it("renders no control when the surface supplies no commit path", () => {
    const { container } = render(
      <ArtifactPriorityEditor
        priority={Priority.High}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(CHAMPION)).not.toBeNull();
  });

  it("renders no control when the caller declares the row read-only", () => {
    // A third, independent reason to withhold the control: the surface supports
    // priority AND supplies a commit path, and the row is still not editable.
    const { container } = render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={Priority.High}
        readOnly
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(CHAMPION)).not.toBeNull();
    // The sibling positive: the same props WITHOUT `readOnly` do give a control,
    // so this cannot pass on a component that never renders one.
    cleanup();
    render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={Priority.High}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );
    expect(screen.getByRole("button", { name: "Priority: High" })).toBeTruthy();
  });
});

/**
 * The production wiring: the same hook every grid row and artifact row uses,
 * driving the same editor. Without this the champion's mutation-activity state
 * would have no producer, which is the unreachable code its own contract
 * forbids.
 */
function Row({
  artifact,
  commit,
}: {
  artifact: Document;
  commit: (input: ArtifactRowEditInput) => Promise<unknown>;
}) {
  const edit = useArtifactRowEdit(artifact, { commit });
  return (
    <ArtifactPriorityEditor
      mutationActivity={edit.priorityPending}
      onSelect={edit.onPriorityChange}
      priority={edit.priority}
      support={ARTIFACT_SUPPORT}
      variant={ArtifactPriorityVariant.Editor}
    />
  );
}

describe("ArtifactPriorityEditor — a real write in flight", () => {
  it("announces the write while it is out, and stops when it settles", async () => {
    const user = userEvent.setup();
    let resolveCommit: (() => void) | undefined;
    const commit = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveCommit = () => resolve({});
        })
    );
    const { container } = render(
      gated(<Row artifact={buildArtifact(Priority.Low)} commit={commit} />)
    );

    // Settled before the pick, so "aria-busy is set" cannot be satisfied by a
    // mark that always sets it.
    expect(container.querySelector(CHAMPION)).not.toHaveAttribute("aria-busy");

    await user.click(screen.getByRole("button", { name: "Priority: Low" }));
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));

    await waitFor(() =>
      expect(container.querySelector(CHAMPION)).toHaveAttribute(
        "aria-busy",
        "true"
      )
    );

    resolveCommit?.();
    await waitFor(() =>
      expect(container.querySelector(CHAMPION)).not.toHaveAttribute("aria-busy")
    );
  });

  it("shows the artifact's real value again when the server refuses", async () => {
    const user = userEvent.setup();
    const commit = vi.fn(() => Promise.reject(new Error("refused")));
    render(<Row artifact={buildArtifact(Priority.Low)} commit={commit} />);

    await user.click(screen.getByRole("button", { name: "Priority: Low" }));
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));

    // The refused value does not stay on screen. The champion holds no accepted
    // copy of its own, so what the ledger resolves to is what the reader sees.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Priority: Low" })).toBeTruthy()
    );
    expect(
      screen.queryByRole("button", { name: "Priority: Urgent" })
    ).toBeNull();
  });

  it("stops announcing the write when the server refuses it", async () => {
    // The rollback and the busy mark are independent, and a row that rolled the
    // value back while still reading `aria-busy` is the UI lying about state for
    // the rest of the row's life — nothing else ever lowers that count.
    const user = userEvent.setup();
    let rejectCommit: (() => void) | undefined;
    const commit = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectCommit = () => reject(new Error("refused"));
        })
    );
    const { container } = render(
      gated(<Row artifact={buildArtifact(Priority.Low)} commit={commit} />)
    );

    await user.click(screen.getByRole("button", { name: "Priority: Low" }));
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));
    // The busy mark is genuinely raised first, so "not busy" at the end cannot
    // be satisfied by a row that never announced the write at all.
    await waitFor(() =>
      expect(container.querySelector(CHAMPION)).toHaveAttribute(
        "aria-busy",
        "true"
      )
    );

    rejectCommit?.();

    await waitFor(() =>
      expect(container.querySelector(CHAMPION)).not.toHaveAttribute("aria-busy")
    );
  });

  it("stops announcing the write when the commit throws before returning a promise", async () => {
    // `commit` is supplied by the calling surface, so a synchronous throw is a
    // shape the row must survive. It does — but not by anything in the row:
    // `useFieldWriteQueue` hands `commit` to `tail.then(run, run)`, so the throw
    // is a rejection by the time the row's `.finally` sees it, and the ledger's
    // own `catch` never fires. This case therefore pins the OUTCOME and not a
    // guard: it is green against every arrangement of the row that keeps going
    // through the queue, and goes red the moment the queue stops deferring.
    const user = userEvent.setup();
    const commit = vi.fn(() => {
      throw new Error("threw before returning");
    });
    const { container } = render(
      gated(<Row artifact={buildArtifact(Priority.Low)} commit={commit} />)
    );

    await user.click(screen.getByRole("button", { name: "Priority: Low" }));
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(container.querySelector(CHAMPION)).not.toHaveAttribute("aria-busy")
    );
    // The refused value is gone too: a row that is merely not-busy while still
    // showing what was never saved is the same lie in the other half.
    expect(screen.getByRole("button", { name: "Priority: Low" })).toBeTruthy();
  });
});

/**
 * WCAG 2.5.3 (Label in Name): a control's accessible name must contain its
 * visible label, so a voice-control user can activate what they can read.
 *
 * Both directions, because the rule is per variant: the detail field paints the
 * absent value in words and so must be named by them, and the dense grid cell
 * paints no word and so keeps the name `priorityTriggerLabel` gives it. Pinning
 * only the first would let the grid's own trigger lose its name unnoticed.
 */
describe("ArtifactPriorityEditor — the trigger's accessible name", () => {
  it("is the visible word where the mark states the absence in words", () => {
    render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={null}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.DetailField}
      />
    );

    expect(
      screen.getByRole("button", { name: PRIORITY_LABEL_NONE })
    ).toHaveTextContent(PRIORITY_LABEL_NONE);
    // And the name it would otherwise have carried, which contains none of that
    // word, is gone rather than merely joined by it.
    expect(
      screen.queryByRole("button", { name: priorityTriggerLabel(null) })
    ).toBeNull();
  });

  it("is still the trigger label on a dense cell, which paints no word", () => {
    render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={null}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.Editor}
      />
    );

    const trigger = screen.getByRole("button", {
      name: priorityTriggerLabel(null),
    });
    // The mark alone: nothing visible for the name to have to contain, which is
    // why this variant is excluded rather than following the detail field.
    expect(trigger).not.toHaveTextContent(PRIORITY_LABEL_NONE);
  });

  it("keeps the field in the name for a value that is set", () => {
    render(
      <ArtifactPriorityEditor
        onSelect={vi.fn()}
        priority={Priority.High}
        support={ARTIFACT_SUPPORT}
        variant={ArtifactPriorityVariant.DetailField}
      />
    );

    // 2.5.3 asks for containment, not equality, so the label stays here and adds
    // the field the visible word belongs to.
    expect(
      screen.getByRole("button", {
        name: priorityTriggerLabel(Priority.High),
      })
    ).toHaveTextContent(priorityLabel(Priority.High));
  });
});

/** The shared grid fixture, so this row is the shape the production rows are. */
function buildArtifact(priority: Priority | null): Document {
  return makeFeatureArtifact({ priority });
}
