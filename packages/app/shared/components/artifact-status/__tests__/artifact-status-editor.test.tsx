import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import { ARTIFACT_STATUS_DETAIL } from "@repo/api/src/types/artifact-status";
import {
  ArtifactStatusEditSurface,
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_UNKNOWN_TOOLTIP,
} from "@repo/api/src/types/artifact-status-display";
import {
  toArtifactStatusFromDocument,
  toArtifactStatusFromIssue,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { ArtifactStatusView } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Matched loosely on purpose: the exact wording is the editor's to own, and
// restating it here would be that copy written a second time. What these pin is
// that the reader is TOLD, which is the half the old handler-presence inference
// could not do at all.
const REFUSAL_SENTENCE = /cannot be changed here/i;
const NOTHING_LEGAL_SENTENCE = /no status change/i;
const INLINE_REFUSAL_NAME = /In progress, Running.*cannot be changed here/i;
const IN_REVIEW_NAME = /In review/;
const APPROVED_MENUITEM = /Approved$/;

const IN_REVIEW_VIEW: ArtifactStatusView = {
  artifactId: "doc-1",
  normalized: toArtifactStatusFromDocument(DocumentStatus.InReview),
  raw: DocumentStatus.InReview,
  vocabulary: ArtifactStatusVocabulary.Document,
};

const FUTURE_VIEW: ArtifactStatusView = {
  artifactId: "doc-future",
  normalized: toArtifactStatusFromDocument("FUTURE_DOCUMENT_STATUS"),
  raw: "FUTURE_DOCUMENT_STATUS",
  vocabulary: ArtifactStatusVocabulary.Document,
};

const NULL_VIEW: ArtifactStatusView = {
  artifactId: "doc-null",
  normalized: toArtifactStatusFromDocument(null),
  raw: null,
  vocabulary: ArtifactStatusVocabulary.Document,
};

const RUNNING_VIEW: ArtifactStatusView = {
  artifactId: "session-1",
  normalized: toArtifactStatusFromSession("active"),
  raw: "active",
  vocabulary: ArtifactStatusVocabulary.Session,
};

const ISSUE_VIEW: ArtifactStatusView = {
  artifactId: "issue-1",
  normalized: toArtifactStatusFromIssue(IssueStatus.InReview),
  raw: IssueStatus.InReview,
  vocabulary: ArtifactStatusVocabulary.Issue,
};

describe("editability is a permission, not a handler", () => {
  it("keeps the default status mark directly in its trigger for card-height parity", () => {
    render(
      <ArtifactStatus
        capability={{
          editable: true,
          allowedTargets: [DocumentStatus.Approved],
        }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    const trigger = screen.getByRole("button", { name: "In review" });
    expect(trigger.firstElementChild).toHaveClass("inline-flex");
    expect(trigger.firstElementChild).not.toHaveAttribute("aria-hidden");
  });

  it("uses the same commit menu behind a compact icon trigger", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          editable: true,
          allowedTargets: [DocumentStatus.Approved],
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.InlineCell}
        triggerVariant={ArtifactStatusVariant.Icon}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    const trigger = screen.getByRole("button", { name: "In review" });
    expect(trigger).toHaveClass("h-7", "w-7");
    expect(trigger.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("In review")).toBeNull();
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: APPROVED_MENUITEM })
    );
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({
      artifactId: IN_REVIEW_VIEW.artifactId,
      from: DocumentStatus.InReview,
      surface: ArtifactStatusEditSurface.InlineCell,
      to: DocumentStatus.Approved,
      vocabulary: ArtifactStatusVocabulary.Document,
    });
  });

  it("keeps a compact read-only glyph non-editable", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.NotPermitted,
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.InlineCell}
        triggerVariant={ArtifactStatusVariant.Icon}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    const trigger = screen.getByRole("button", { name: IN_REVIEW_NAME });
    expect(trigger).toHaveClass("h-7", "w-7");
    await user.click(trigger);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("offers no control at all for a read-only capability, live handler and all", async () => {
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.ProviderDerived,
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    // Reintroducing `if (!onCommit)` inference turns this green-to-red: the
    // handler IS present, so an editor that reads editability from it renders a
    // trigger here.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // And the refusal arrives with its reason, which is the state the old
    // inference could not represent at all.
    const refusal = screen.getByText(REFUSAL_SENTENCE);
    expect(refusal).toBeInTheDocument();
    expect(refusal.closest("fieldset")).toHaveClass(
      "items-center",
      "max-md:w-full",
      "max-md:flex-col",
      "max-md:items-start"
    );
    await waitFor(() => expect(onCommit).not.toHaveBeenCalled());
  });

  it("shows canonical Unknown without an inline explanation while honesty is off", () => {
    render(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
        }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={FUTURE_VIEW}
      />
    );

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the approved explanation from the status control by pointer", async () => {
    const user = userEvent.setup();
    renderWithHonesty(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
        }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={FUTURE_VIEW}
      />
    );

    const trigger = screen.getByRole("button");
    expect(screen.queryByText(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();
    await user.hover(trigger);
    expect(
      (await screen.findAllByText(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).length
    ).toBeGreaterThan(0);
  });

  it("opens the approved explanation from the status control by keyboard", async () => {
    const user = userEvent.setup();
    renderWithHonesty(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
        }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={FUTURE_VIEW}
      />
    );

    const trigger = screen.getByRole("button");
    expect(screen.queryByText(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(
      (await screen.findAllByText(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).length
    ).toBeGreaterThan(0);
  });

  it("does not invent version-skew copy for an absent status", () => {
    renderWithHonesty(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.UnrecognizedStatus,
        }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={NULL_VIEW}
      />
    );

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText(ARTIFACT_STATUS_UNKNOWN_TOOLTIP)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps an inline refusal visible without creating a live region", () => {
    render(
      <ArtifactStatus
        capability={{
          editable: false,
          reason: ArtifactStatusReadOnlyReason.MachineWritten,
        }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={RUNNING_VIEW}
      />
    );

    const status = screen.getByLabelText(INLINE_REFUSAL_NAME);
    expect(status).toHaveTextContent("In progress");
    expect(status).toHaveTextContent("Running");
    expect(status).toHaveTextContent(REFUSAL_SENTENCE);
    expect(status).toHaveClass("flex-col");
    expect(status).toHaveClass("max-md:max-w-full");
    expect(status).not.toHaveClass("flex-wrap");
    expect(screen.getByText(REFUSAL_SENTENCE)).toHaveClass("whitespace-nowrap");
    expect(screen.getByText(REFUSAL_SENTENCE)).toHaveClass(
      "max-md:whitespace-normal"
    );
    expect(
      screen.queryByRole("status", { name: INLINE_REFUSAL_NAME })
    ).toBeNull();

    expect(status).toHaveAttribute(
      "title",
      "Set automatically, so it cannot be changed here."
    );
  });

  it("opens, and states that nothing is legal, for an empty target list", async () => {
    const user = userEvent.setup();
    render(
      <ArtifactStatus
        capability={{ allowedTargets: [], editable: true }}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    // Editable-with-nothing-to-move-to is honest and distinct from read-only:
    // collapsing it into the refusal arm removes the control entirely and fails
    // the first assertion.
    const trigger = screen.getByRole("button");
    await user.click(trigger);
    expect(await screen.findByText(NOTHING_LEGAL_SENTENCE)).toBeInTheDocument();
  });
});

describe("the keyboard path and where focus lands", () => {
  it("commits the target the arrows landed on, and returns focus", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          // Two targets, and the SECOND is the one chosen. With one target an
          // editor that always commits `allowedTargets[0]` is indistinguishable
          // from one that commits what the reader selected.
          allowedTargets: [
            DocumentStatus.ChangesRequested,
            DocumentStatus.Approved,
          ],
          editable: true,
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    const trigger = screen.getByRole("button");
    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(items[1]).toHaveFocus());
    await user.keyboard("{Enter}");

    // The commit is fully formed by the champion, not reassembled by the
    // caller: the subject, the prior value, and the surface the write came
    // from. `commitGroupId` stays absent rather than null on a single-row
    // commit, which is what keeps it additive for an older consumer.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({
      artifactId: IN_REVIEW_VIEW.artifactId,
      from: DocumentStatus.InReview,
      surface: ArtifactStatusEditSurface.Detail,
      to: DocumentStatus.Approved,
      vocabulary: ArtifactStatusVocabulary.Document,
    });
    expect(Object.hasOwn(onCommit.mock.calls[0][0], "commitGroupId")).toBe(
      false
    );

    // UAS-021, the commit exit. A menu that leaves focus on `document.body`
    // strands a keyboard user where they started nothing.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus and cancels on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          allowedTargets: [DocumentStatus.Approved],
          editable: true,
        }}
        onCancel={onCancel}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    const trigger = screen.getByRole("button");
    await user.tab();
    // Space, the other open key WCAG 2.1.1 expects of a button.
    await user.keyboard("{ }");
    await screen.findByRole("menuitem");
    await user.keyboard("{Escape}");

    // UAS-021's other exit. Asserting only the commit path passes on a menu
    // that strands focus whenever the reader changes their mind.
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("does not report a cancel when the menu closed on a commit", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          allowedTargets: [DocumentStatus.Approved],
          editable: true,
        }}
        onCancel={onCancel}
        onCommit={() => undefined}
        surface={ArtifactStatusEditSurface.Detail}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByRole("menuitem"));

    // Radix reports both exits as one close, so dropping the commit latch makes
    // every successful write also announce itself as abandoned.
    await waitFor(() =>
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()
    );
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("hierarchical status targets", () => {
  it("puts selectable Issue parents before their indented details in semantic root order", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          allowedTargets: [
            IssueStatus.Triage,
            IssueStatus.Backlog,
            IssueStatus.Todo,
            IssueStatus.InProgress,
            IssueStatus.InReview,
            IssueStatus.Blocked,
            IssueStatus.Done,
            IssueStatus.Canceled,
            DocumentStatus.Approved,
          ],
          editable: true,
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={ISSUE_VIEW}
      />
    );

    await user.click(screen.getByRole("button"));
    const items = screen.getAllByRole("menuitem");
    expect(
      items.map((item) => item.getAttribute("aria-label") ?? item.textContent)
    ).toEqual([
      "Todo",
      "Todo, Triage",
      "Todo, Backlog",
      "In progress",
      "In progress, Blocked",
      "In review",
      "Done",
      "Canceled",
    ]);
    const detailItem = screen.getByRole("menuitem", { name: "Todo, Triage" });
    expect(detailItem).toHaveClass("ml-3", "border-l", "pl-3");
    expect(detailItem.querySelector("[data-slot='status-icon']")).toBeNull();
    const parentItem = screen.getByRole("menuitem", { name: "Todo" });
    expect(parentItem).not.toHaveClass("ml-3");
    expect(
      parentItem.querySelector("[data-slot='status-icon']")
    ).not.toBeNull();
    expect(screen.queryByText("Status and detail")).toBeNull();
    expect(
      screen.queryByText(
        ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.DocumentApproved]
      )
    ).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(
      screen
        .getByRole("menu")
        .querySelector("[data-slot='dropdown-menu-item-indicator']")
    ).toBeNull();

    await user.click(screen.getByRole("menuitem", { name: "Todo" }));
    expect(onCommit).toHaveBeenCalledWith({
      artifactId: ISSUE_VIEW.artifactId,
      from: IssueStatus.InReview,
      surface: ArtifactStatusEditSurface.InlineCell,
      to: IssueStatus.Todo,
      vocabulary: ArtifactStatusVocabulary.Issue,
    });
  });

  it("commits the exact Issue detail target, including by keyboard", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          allowedTargets: [IssueStatus.Triage, IssueStatus.Todo],
          editable: true,
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={ISSUE_VIEW}
      />
    );

    const trigger = screen.getByRole("button");
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Todo" })).toHaveFocus()
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onCommit).toHaveBeenCalledWith({
      artifactId: ISSUE_VIEW.artifactId,
      from: IssueStatus.InReview,
      surface: ArtifactStatusEditSurface.InlineCell,
      to: IssueStatus.Triage,
      vocabulary: ArtifactStatusVocabulary.Issue,
    });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not invent a Document parent-only write when only a detail exists", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ArtifactStatus
        capability={{
          allowedTargets: [DocumentStatus.Draft, DocumentStatus.InReview],
          editable: true,
        }}
        onCommit={onCommit}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={IN_REVIEW_VIEW}
      />
    );

    await user.click(screen.getByRole("button"));
    expect(screen.getByText("In progress")).toHaveAttribute(
      "data-slot",
      "dropdown-menu-label"
    );
    expect(screen.queryByRole("menuitem", { name: "In progress" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "In progress, Drafting" })
    ).toHaveClass("ml-3");
    expect(
      screen.getByRole("menuitem", { name: "In review" })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "In progress, Drafting" })
    );
    expect(onCommit).toHaveBeenCalledWith({
      artifactId: IN_REVIEW_VIEW.artifactId,
      from: DocumentStatus.InReview,
      surface: ArtifactStatusEditSurface.InlineCell,
      to: DocumentStatus.Draft,
      vocabulary: ArtifactStatusVocabulary.Document,
    });
  });
});

function renderWithHonesty(ui: ReactNode) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
      })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}
