import { ShareAudience } from "@repo/app/shared/lib/share-audience";
import { SessionUploadState } from "@repo/app/shared/lib/upload-state";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  resolveShareExceptionOutcome,
  type SessionShareException,
  SessionShareExceptionList,
  type SessionShareExceptionListCopy,
  ShareExceptionOutcome,
  ShareExceptionPrecedence,
} from "../session-share-exception-list";

/**
 * ISS-12535. Strings here are test fixtures, not product copy: the list takes
 * every string from its host.
 */
const COPY: SessionShareExceptionListCopy = {
  heading: "fixture heading",
  emptyText: "fixture empty",
  audienceLabel: {
    [ShareAudience.OnlyMe]: "fixture only-me",
    [ShareAudience.Organization]: "fixture organization",
  },
  uploadStateLabel: {
    [SessionUploadState.LocalOnly]: "fixture local-only",
    [SessionUploadState.Uploading]: "fixture uploading",
    [SessionUploadState.Shared]: "fixture shared",
    [SessionUploadState.Failed]: "fixture failed",
  },
  retryLabel: "fixture retry",
  excludedDirectoryLabel: "fixture excluded",
  blockedLabel: "fixture blocked",
};

const SHARED: SessionShareException = {
  id: "session-a",
  sessionName: "fixture session a",
  audience: ShareAudience.Organization,
  uploadState: SessionUploadState.Shared,
};

const IN_EXCLUDED: SessionShareException = {
  id: "session-b",
  sessionName: "fixture session b",
  audience: ShareAudience.OnlyMe,
  uploadState: SessionUploadState.Uploading,
  excludedDirectory: { id: "/fixture/excluded", label: "fixture-excluded-dir" },
};

const FAILED: SessionShareException = {
  id: "session-c",
  sessionName: "fixture session c",
  audience: ShareAudience.OnlyMe,
  uploadState: SessionUploadState.Failed,
};

function renderList(
  props: Partial<Parameters<typeof SessionShareExceptionList>[0]> = {}
) {
  return render(
    <SessionShareExceptionList
      copy={COPY}
      exceptions={[SHARED, IN_EXCLUDED]}
      onRetryUpload={vi.fn()}
      precedence={ShareExceptionPrecedence.ExceptionWins}
      {...props}
    />
  );
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

describe("SessionShareExceptionList", () => {
  it("AC-001: renders the exceptions as their own list, named by its heading", () => {
    renderList();
    const list = screen.getByRole("list", { name: COPY.heading });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("AC-001: shows the empty text, not an empty list, when there are no exceptions", () => {
    renderList({ exceptions: [] });
    expect(screen.getByText(COPY.emptyText)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("AC-002: each row shows its audience and its upload state", () => {
    renderList();
    const shared = rowFor(SHARED.sessionName);
    expect(
      within(shared).getByText(COPY.audienceLabel[ShareAudience.Organization])
    ).toBeInTheDocument();
    expect(
      within(shared).getByTestId("session-upload-state-badge")
    ).toHaveAttribute("data-state", SessionUploadState.Shared);
    expect(
      within(shared).getByText(COPY.uploadStateLabel[SessionUploadState.Shared])
    ).toBeInTheDocument();
  });

  it("AC-002: a failed row offers the badge's retry, which reports the row's id", () => {
    const onRetryUpload = vi.fn();
    renderList({ exceptions: [FAILED], onRetryUpload });
    fireEvent.click(screen.getByRole("button", { name: COPY.retryLabel }));
    expect(onRetryUpload).toHaveBeenCalledWith(FAILED.id);
  });

  it("disables the retry of a row whose retry is in flight", () => {
    renderList({ exceptions: [FAILED], retryingIds: [FAILED.id] });
    expect(
      screen.getByRole("button", { name: COPY.retryLabel })
    ).toBeDisabled();
  });

  it("AC-003 (decided rule): an exception in an excluded directory still applies, and is marked", () => {
    renderList();
    const row = rowFor(IN_EXCLUDED.sessionName);
    expect(row).toHaveAttribute(
      "data-outcome",
      ShareExceptionOutcome.AppliesDespiteExclusion
    );
    expect(
      within(row).getByText(COPY.excludedDirectoryLabel)
    ).toBeInTheDocument();
    expect(
      within(row).getByText(IN_EXCLUDED.excludedDirectory?.label ?? "")
    ).toBeInTheDocument();
    expect(
      within(row).getByText(COPY.uploadStateLabel[SessionUploadState.Uploading])
    ).toBeInTheDocument();
    expect(within(row).queryByText(COPY.blockedLabel)).not.toBeInTheDocument();
  });

  it("AC-003 (flipped rule): with exclusion winning, the same row shows as blocked", () => {
    renderList({ precedence: ShareExceptionPrecedence.ExclusionWins });
    const row = rowFor(IN_EXCLUDED.sessionName);
    expect(row).toHaveAttribute(
      "data-outcome",
      ShareExceptionOutcome.BlockedByExclusion
    );
    expect(within(row).getByText(COPY.blockedLabel)).toBeInTheDocument();
    expect(
      within(row).getByText(COPY.excludedDirectoryLabel)
    ).toBeInTheDocument();
    expect(
      within(row).queryByTestId("session-upload-state-badge")
    ).not.toBeInTheDocument();
    // A row outside any excluded directory is untouched by the rule.
    expect(
      within(rowFor(SHARED.sessionName)).getByTestId(
        "session-upload-state-badge"
      )
    ).toBeInTheDocument();
  });

  it("applies the precedence the host passes, which has no default", () => {
    for (const precedence of Object.values(ShareExceptionPrecedence)) {
      const { unmount } = renderList({ precedence });
      expect(
        screen.getByTestId("session-share-exception-list")
      ).toHaveAttribute("data-precedence", precedence);
      unmount();
    }
  });

  it("names only the list, not a region landmark around it", () => {
    renderList();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("session-share-exception-list")
    ).not.toHaveAttribute("aria-labelledby");
    expect(screen.getByRole("list", { name: COPY.heading })).toBeVisible();
  });
});

describe("resolveShareExceptionOutcome", () => {
  it("is Applies outside an excluded directory, whatever the rule", () => {
    for (const precedence of Object.values(ShareExceptionPrecedence)) {
      expect(resolveShareExceptionOutcome(SHARED, precedence)).toBe(
        ShareExceptionOutcome.Applies
      );
    }
  });

  it("follows the rule inside an excluded directory", () => {
    expect(
      resolveShareExceptionOutcome(
        IN_EXCLUDED,
        ShareExceptionPrecedence.ExceptionWins
      )
    ).toBe(ShareExceptionOutcome.AppliesDespiteExclusion);
    expect(
      resolveShareExceptionOutcome(
        IN_EXCLUDED,
        ShareExceptionPrecedence.ExclusionWins
      )
    ).toBe(ShareExceptionOutcome.BlockedByExclusion);
  });
});
