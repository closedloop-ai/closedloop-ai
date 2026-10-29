import { ARTIFACT_STATUS_UNKNOWN_LABEL } from "@repo/api/src/types/artifact-status-display";
import { DocumentStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import type { ArtifactRowEditController } from "@repo/app/documents/hooks/use-artifact-row-edit";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const NO_PERMISSION_COPY = "You do not have permission to change this status.";

describe("linked ArtifactRow universal status evidence", () => {
  it("renders unrecognized endpoint evidence read-only instead of editing its fallback", () => {
    const commit = vi.fn();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
        })}
      >
        <ArtifactRow
          artifact={{ ...makeArtifact(), rawStatus: "future-state" }}
          editing={{ commit }}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ARTIFACT_STATUS_UNKNOWN_LABEL })
    ).not.toBeInTheDocument();
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps an explicitly null endpoint status read-only", () => {
    const commit = vi.fn();
    renderUniversalRow({
      artifact: { ...makeArtifact(), rawStatus: null },
      commit,
    });

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ARTIFACT_STATUS_UNKNOWN_LABEL })
    ).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves an explicit single-write denial at the production editor", () => {
    const commit = vi.fn();
    renderUniversalRow({
      artifact: {
        ...makeArtifact(),
        rawStatus: DocumentStatus.Draft,
        statusMutation: {
          allowedStatuses: [DocumentStatus.Approved],
          expectedStatusByIdField: "expectedStatusById",
          expectedStatusField: "expectedStatus",
          permissions: {
            [DocumentStatusMutationOperation.Bulk]: true,
            [DocumentStatusMutationOperation.Single]: false,
          },
        },
      },
      commit,
    });

    expect(screen.queryByRole("button", { name: "Drafting" })).toBeNull();
    expect(
      screen.getByLabelText(`In progress, Drafting. ${NO_PERMISSION_COPY}`)
    ).toHaveTextContent(NO_PERMISSION_COPY);
    expect(commit).not.toHaveBeenCalled();
  });

  it("renders the optimistic status and restores it when the write rejects", async () => {
    const user = userEvent.setup();
    let rejectCommit: ((reason: Error) => void) | undefined;
    const commit = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCommit = reject;
        })
    );
    renderUniversalRow({
      artifact: {
        ...makeArtifact({ status: DocumentStatus.Draft }),
        rawStatus: DocumentStatus.Draft,
      },
      commit,
    });

    await user.click(
      screen.getByRole("button", { name: "In progress, Drafting" })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Done, Approved" })
    );
    expect(
      screen.getByRole("button", { name: "Done, Approved" })
    ).toBeVisible();
    rejectCommit?.(new Error("rejected"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "In progress, Drafting" })
      ).toBeVisible()
    );
  });
});

function renderUniversalRow({
  artifact,
  commit,
}: {
  artifact: Parameters<typeof ArtifactRow>[0]["artifact"];
  commit: ArtifactRowEditController["commit"];
}) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      })}
    >
      <ArtifactRow artifact={artifact} editing={{ commit }} />
    </FeatureFlagAdapterProvider>
  );
}
