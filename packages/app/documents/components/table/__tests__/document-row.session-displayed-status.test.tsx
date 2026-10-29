import { ArtifactType } from "@repo/api/src/types/artifact";
import { ARTIFACT_STATUS_UNKNOWN_LABEL } from "@repo/api/src/types/artifact-status-display";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const QUIESCED_LABEL_REGEX = /quiesced/;

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(() => false),
  useFeatureFlagEnabledOptional: vi.fn(() => false),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/**
 * ISS-8694 enrichment, PRODUCTION render path. ISS-10364 (operator ruling,
 * 2026-09-23/24) made it permanently inert: `resolveServedSessionDisplayStatus`
 * always answers `undefined` now, because its only two admissible outputs
 * (`stale`, `unknown`) are retired from the vocabulary. A Documents-table
 * session row therefore always shows its own stored status, unexplained, with
 * no derived word, no tooltip, and no focusable trigger — regardless of the
 * `ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY` flag state and
 * regardless of whatever a legacy/version-skewed payload still carries in its
 * `displayedSessionStatus` field.
 */

function enableFlags(...enabledFlags: string[]): void {
  vi.mocked(useFeatureFlagEnabledOptional).mockImplementation((key: string) =>
    enabledFlags.includes(key)
  );
}

function renderSessionRow(
  storedStatus: string,
  legacyDisplayedSessionStatus?: string
) {
  const item: DocumentRowItem = {
    kind: "session",
    data: makeRawArtifact(ArtifactType.Session, {
      id: "ses-1",
      name: "Refactor the ingest fold",
      status: storedStatus,
      ...(legacyDisplayedSessionStatus === undefined
        ? {}
        : {
            // Cast past the production `SessionStatus` field type: a legacy/
            // version-skewed wire payload is not bound by this build's type.
            displayedSessionStatus:
              legacyDisplayedSessionStatus as SessionStatus,
          }),
    }),
  };
  return renderRow(item);
}

function renderRow(item: DocumentRowItem) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentRow item={item} visibleColumns={[]} />
    </QueryClientProvider>
  );
}

function tooltipTexts(): string[] {
  return screen
    .queryAllByTestId("tooltip-content")
    .map((node) => node.textContent ?? "");
}

describe("Documents-table session row — the inert ISS-8694 enrichment (ISS-10364)", () => {
  beforeEach(() => {
    vi.mocked(useFeatureFlagEnabledOptional).mockReturnValue(false);
  });

  it("renders the stored status unexplained, even with a legacy `stale` payload and the flag on", () => {
    enableFlags(ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY);

    renderSessionRow(SESSION_STATUS.ACTIVE, "stale");

    expect(screen.getByLabelText("Active")).toBeTruthy();
    expect(screen.getByLabelText("Active").closest("button")).toBeNull();
    expect(tooltipTexts().join(" ")).not.toContain("Stale");
  });

  it("agrees on the champion word for a case-variant known session status, with no Unknown fallback", () => {
    enableFlags(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY);

    renderSessionRow(SESSION_STATUS.INACTIVE.toUpperCase());

    expect(screen.getByLabelText("Done, Completed")).toBeTruthy();
    expect(tooltipTexts()).toContain("Completed");
    expect(screen.queryByLabelText(ARTIFACT_STATUS_UNKNOWN_LABEL)).toBeNull();
  });

  it("agrees on the champion word for a case-variant known branch status", () => {
    enableFlags(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY);
    renderRow({
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, {
        id: "branch-1",
        name: "Open branch",
        status: GitHubPRState.Open.toLowerCase(),
      }),
    });

    expect(screen.getByLabelText("In review, Open")).toBeTruthy();
    expect(tooltipTexts()).toContain("Open");
    expect(screen.queryByLabelText(ARTIFACT_STATUS_UNKNOWN_LABEL)).toBeNull();
  });

  it("folds an unrecognized stored status to Active rather than a confident wrong word", () => {
    renderSessionRow("quiesced-awaiting-review");

    expect(screen.getByLabelText("Active")).toBeTruthy();
    expect(screen.queryByLabelText(QUIESCED_LABEL_REGEX)).toBeNull();
  });

  it("refuses a served recognized lifecycle word rather than badging a stored row with it", () => {
    // Even if a legacy payload still carried a recognized value (`inactive`) in
    // the now-unread `displayedSessionStatus` field, the stored word wins —
    // the field is never consulted at all any more.
    renderSessionRow(SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE);

    expect(screen.getByLabelText("Active")).toBeTruthy();
    expect(
      screen.queryByLabelText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE])
    ).toBeNull();
  });

  it("keeps every session row's status glyph a plain div, never a tab stop", () => {
    renderSessionRow(SESSION_STATUS.ACTIVE);

    expect(screen.getByLabelText("Active").closest("button")).toBeNull();
  });
});
